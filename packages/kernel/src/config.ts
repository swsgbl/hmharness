/**
 * @hmharness/kernel - config
 * HMH_HOME isolation: all hmharness state lives under one root
 * (env HMH_HOME wins, default ~/.hmharness). Nothing is ever shared with
 * any other harness on the machine - the lesson that motivated this
 * clean-room project.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HmhConfig } from './types.ts';

export const STATE_DIRS = ['sessions', 'memory', 'skills', 'insights', 'bench'] as const;

export function homeDir(): string {
  return process.env.HMH_HOME ?? join(homedir(), '.hmharness');
}

export function defaultConfig(): HmhConfig {
  return {
    // Point at any OpenAI-compatible endpoint via config.json or env vars.
    provider: {
      baseUrl: process.env.HMH_BASE_URL ?? '',
      apiKey: process.env.HMH_API_KEY ?? '',
      model: process.env.HMH_MODEL ?? '',
    },
    maxTurns: 25,
  };
}

/** HMH_LOCALE env (zh|en) overrides the configured locale - used by --locale. */
function applyLocaleOverride(cfg: HmhConfig): HmhConfig {
  const env = process.env.HMH_LOCALE;
  return env === 'zh' || env === 'en' ? { ...cfg, locale: env } : cfg;
}

export async function loadConfig(): Promise<HmhConfig> {
  const home = homeDir();
  const file = join(home, 'config.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as HmhConfig;
    return applyLocaleOverride({ ...defaultConfig(), ...raw, provider: { ...defaultConfig().provider, ...raw.provider } });
  } catch {
    return applyLocaleOverride(defaultConfig());
  }
}

/**
 * Point routing.chat at a named provider (`/model <name>` in the TUI/REPL,
 * the model picker in the web UI). Preserves every other config field; the
 * returned config reflects the new route (HMH_LOCALE override reapplied).
 */
export async function setChatRoute(name: string): Promise<HmhConfig> {
  const home = homeDir();
  const file = join(home, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  if (!raw.providers || !(name in (raw.providers as Record<string, unknown>))) {
    throw new Error(`unknown provider "${name}" - configure it under providers in config.json first`);
  }
  raw.routing = { ...(raw.routing as Record<string, unknown> ?? {}), chat: name };
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/**
 * Persist the UI locale (TUI/REPL `/lang`) to config.json. Same
 * read-mutate-write shape as setChatRoute; returns the refreshed config.
 */
export async function setLocale(locale: 'zh' | 'en'): Promise<HmhConfig> {
  const file = join(homeDir(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  raw.locale = locale;
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/**
 * Merge detected providers into config.json (`hmh providers --scan`).
 * Same-name entries never overwrite what is already configured; returns the
 * refreshed config and the names actually added.
 */
export async function addProviders(items: Array<{ name: string; baseUrl: string; model: string; apiKey?: string }>): Promise<{ cfg: HmhConfig; added: string[] }> {
  const home = homeDir();
  const file = join(home, 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  const providers = (raw.providers ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  for (const it of items) {
    if (providers[it.name]) continue;
    providers[it.name] = { baseUrl: it.baseUrl, model: it.model, ...(it.apiKey ? { apiKey: it.apiKey } : {}) };
    added.push(it.name);
  }
  raw.providers = providers;
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { cfg: await loadConfig(), added };
}

/**
 * Insert or fully replace one provider (web settings center: "保存即生效").
 * apiKey omitted/empty keeps the existing key — the UI never round-trips
 * secrets. Returns the refreshed config; throws on bad names.
 */
export async function upsertProvider(input: { name: string; baseUrl: string; model: string; apiKey?: string; purposes?: string[] }): Promise<HmhConfig> {
  const name = String(input.name ?? '').trim();
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(input.model ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name)) throw new Error('provider name must be 1-48 chars of [a-zA-Z0-9_-]');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('baseUrl must start with http(s)://');
  if (!model) throw new Error('model required');
  const file = join(homeDir(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  const providers = (raw.providers ?? {}) as Record<string, unknown>;
  const existing = (providers[name] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {
    baseUrl,
    model,
    // empty apiKey in the form = keep whatever was configured (never blank a key)
    ...(input.apiKey ? { apiKey: input.apiKey } : existing.apiKey ? { apiKey: existing.apiKey } : {}),
    ...(existing.authHeader ? { authHeader: existing.authHeader } : {}),
    ...(existing.timeoutMs ? { timeoutMs: existing.timeoutMs } : {}),
    ...(existing.supportsVision ? { supportsVision: existing.supportsVision } : {}),
    ...(input.purposes?.length ? { purposes: input.purposes } : existing.purposes ? { purposes: existing.purposes } : {}),
  };
  providers[name] = next;
  raw.providers = providers;
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/**
 * Save (upsert) one named provider for the web/TUI settings center.
 * Semantics differ from upsertProvider on the secret key: `apiKey ===
 * undefined` (form field left blank) KEEPS the existing key, while
 * `apiKey === ''` DELETES it. Optional fields (authHeader, timeoutMs,
 * contextWindow, supportsVision) are only written when provided. Returns
 * the refreshed config; throws on invalid names/baseUrl/model.
 */
export async function saveProvider(name: string, p: { baseUrl: string; model: string; apiKey?: string; authHeader?: string; timeoutMs?: number; contextWindow?: number; supportsVision?: boolean }): Promise<HmhConfig> {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid provider name');
  if (!/^https?:\/\//.test(p.baseUrl)) throw new Error('baseUrl must start with http:// or https://');
  if (!p.model) throw new Error('model must not be empty');
  const file = join(homeDir(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  const providers = (raw.providers ?? {}) as Record<string, unknown>;
  const existing = (providers[name] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {
    baseUrl: p.baseUrl,
    model: p.model,
    // apiKey === undefined: keep the existing key (edit form left blank).
    // apiKey === '': explicitly clear it (delete the key).
    ...(p.apiKey !== undefined
      ? (p.apiKey !== '' ? { apiKey: p.apiKey } : {})
      : existing.apiKey !== undefined ? { apiKey: existing.apiKey } : {}),
    ...(p.authHeader ? { authHeader: p.authHeader } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
    ...(p.supportsVision !== undefined ? { supportsVision: p.supportsVision } : {}),
  };
  providers[name] = next;
  raw.providers = providers;
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/** Remove a provider (web settings center). Routing keys that pointed at it
 *  (chat/vision/evolve/bench) are removed with it instead of being left
 *  dangling. Returns the refreshed config. */
export async function deleteProvider(name: string): Promise<HmhConfig> {
  const file = join(homeDir(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  const providers = (raw.providers ?? {}) as Record<string, unknown>;
  if (!(name in providers)) throw new Error(`unknown provider "${name}"`);
  delete providers[name];
  raw.providers = providers;
  const routing = (raw.routing ?? {}) as Record<string, unknown>;
  let routingTouched = false;
  for (const key of ['chat', 'vision', 'evolve', 'bench'] as const) {
    if (routing[key] === name) {
      delete routing[key];
      routingTouched = true;
    }
  }
  if (routingTouched) raw.routing = routing;
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/**
 * Generic in-place config patch (web settings center): read the raw JSON,
 * Object.assign the top-level keys, shallow-merge `evolution` separately,
 * write back and return loadConfig(). The CALLER is responsible for only
 * passing whitelisted keys (this function validates nothing). `theme` is a
 * plain top-level key and flows through the top-level assign.
 */
export async function patchConfig(partial: Record<string, unknown>): Promise<HmhConfig> {
  const file = join(homeDir(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh config */
  }
  const { evolution, ...top } = partial;
  Object.assign(raw, top);
  if (evolution !== undefined && typeof evolution === 'object' && evolution !== null) {
    raw.evolution = { ...((raw.evolution ?? {}) as Record<string, unknown>), ...(evolution as Record<string, unknown>) };
  }
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return loadConfig();
}

export async function initHome(): Promise<{ home: string; created: string[] }> {
  const home = homeDir();
  const created: string[] = [];
  await mkdir(home, { recursive: true });
  for (const dir of STATE_DIRS) {
    const p = join(home, dir);
    try {
      await mkdir(p, { recursive: true });
    } catch {
      /* exists */
    }
  }
  const configFile = join(home, 'config.json');
  try {
    await readFile(configFile, 'utf8');
  } catch {
    await writeFile(configFile, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8');
    created.push('config.json');
  }
  return { home, created };
}
