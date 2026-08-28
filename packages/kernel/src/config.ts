/**
 * @hmh/kernel - config
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
