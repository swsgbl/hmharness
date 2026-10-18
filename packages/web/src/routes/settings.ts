/**
 * @hmharness/web - settings routes (extracted from server.ts, 2026-10-16;
 * web split slice 2 per the v33 audit's 4.1 architecture guidance).
 *
 * Seven endpoints: ssh proxy (approval-gated remote exec), locale, model
 * (chat route switch), provider upsert/delete, general config patch, and
 * the read-only device inventory. Bodies moved VERBATIM; the API contract
 * (paths, validation messages, broadcast fan-out) is unchanged.
 *
 * Coupling note (why these inject deps): these routes MUTATE the shared
 * in-memory cfg object and fan out 'state' broadcasts — the cfg reference
 * and the two closures (broadcast, stateObject) are injected rather than
 * duplicated, so mutations still hit the live server state.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isBareProbe, setChatRoute, resolveProvider, saveProvider, deleteProvider, patchConfig,
  type HmhConfig,
} from '@hmharness/kernel';

export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

/** the exact surface of the shared in-memory cfg these routes touch */
type SettingsCfg = HmhConfig;

export interface SettingsRouteDeps {
  cfg: SettingsCfg;
  home: string;
  json: JsonFn;
  readBody: (req: IncomingMessage) => Promise<string | null>;
  broadcast: (kind: string, data?: unknown) => void;
  stateObject: () => Promise<unknown>;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleSettingsRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: SettingsRouteDeps,
): Promise<boolean> {
  const { cfg, home, json, readBody, broadcast, stateObject } = deps;

  if (req.method === 'GET' && url.pathname === '/api/devices') {
    // Read-only device inventory via hdc (local dev tool). Never mutates.
    const probe = await new Promise<{ ok: boolean; devices: Array<{ target: string; kind: string }> }>((resolve) => {
      execFile('hdc', ['list', 'targets'], { timeout: 4000, windowsHide: true }, (err, out) => {
        if (err || typeof out !== 'string') {
          resolve({ ok: false, devices: [] });
          return;
        }
        resolve({
          ok: true,
          devices: out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !/^\[Empty\]$/.test(l) && !l.startsWith('OHOS'))
            .map((target) => ({
              target,
              kind: /^127\.0\.0\.1:\d+$/.test(target) ? 'emulator' : 'usb',
            })),
        });
      });
    });
    json(res, 200, { devices: probe.devices, hdcAvailable: probe.ok });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/ssh') {
    // proxy a remote command: the browser never sees keys or the ssh
    // binary - the server resolves the configured host and runs ssh.
    // Read-only probes pass; anything else needs ?approve=1 from the
    // client-side approval flow (same gate discipline as tools).
    const body = JSON.parse((await readBody(req)) || '{}') as { host?: string; command?: string; approve?: boolean };
    const hosts = cfg.sshHosts ?? {};
    const h = hosts[String(body.host ?? '')];
    if (!h) { json(res, 404, { error: 'unknown host', configured: Object.keys(hosts) }); return true; }
    const command = String(body.command ?? '').trim();
    if (!command) { json(res, 400, { error: 'command required' }); return true; }
    // Fast path = a BARE read-only probe (shared kernel shellgate): one
    // allowlisted verb, plain arguments, zero shell metacharacters. The
    // old per-segment verb allowlist + writes-regex was bypassable -
    // `find -delete`, `echo $(touch /x)`, `echo hi >& /etc/file` and
    // `date -s` all passed without approval (same bypass classes as
    // GHSA-cv3g-hj65-pcfh / cli-mcp-server 0.2.5). Now: not a bare probe
    // → approval, no exceptions.
    if (!isBareProbe(command)) {
      if (body.approve !== true) { json(res, 403, { error: 'approval required', needsApproval: true }); return true; }
    }
    try {
      const { promisify: prom } = await import('node:util');
      const r = await prom(execFile)('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
        ...(h.keyPath ? ['-i', h.keyPath] : []),
        '-p', String(h.port ?? 22),
        (h.user ? h.user + '@' : '') + h.host,
        command,
      ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      json(res, 200, { output: (String(r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim().slice(0, 20_000) || '(no output)' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      json(res, 400, { error: [e.stdout, e.stderr, e.killed ? '(timed out)' : e.message].filter(Boolean).join('\n').slice(0, 400) });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/locale') {
    // persist the UI locale preference into config.json (all other
    // fields, including provider keys, preserved untouched) and fan out
    const body = JSON.parse((await readBody(req)) || '{}') as { locale?: string };
    if (body.locale !== 'zh' && body.locale !== 'en') {
      json(res, 400, { error: 'locale must be zh|en' });
      return true;
    }
    const file = join(home, 'config.json');
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      /* fresh config */
    }
    raw.locale = body.locale;
    await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    cfg.locale = body.locale;
    broadcast('state', await stateObject());
    json(res, 200, { ok: true, locale: body.locale });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/model') {
    // switch routing.chat to a named provider; config.json is rewritten
    // in place (all other fields kept) and the in-memory cfg follows so
    // the next task already uses the new route
    const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
    const name = String(body.name ?? '');
    try {
      const fresh = await setChatRoute(name);
      cfg.provider = fresh.provider;
      cfg.providers = fresh.providers;
      cfg.routing = fresh.routing;
      broadcast('state', await stateObject());
      json(res, 200, { ok: true, model: resolveProvider(cfg, 'chat').model });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  // ---- provider management (settings center) ----
  if (req.method === 'POST' && url.pathname === '/api/providers') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown;
      authHeader?: unknown; supportsVision?: unknown; timeoutMs?: unknown; contextWindow?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!name || !baseUrl || !model) {
      json(res, 400, { error: 'name, baseUrl and model are required' });
      return true;
    }
    // apiKey omitted = keep the stored key (the UI never round-trips
    // secrets); apiKey explicitly '' = clear it. Same for optional fields.
    try {
      const fresh = await saveProvider(name, {
        baseUrl,
        model,
        ...(body.apiKey !== undefined ? { apiKey: String(body.apiKey) } : {}),
        ...(typeof body.authHeader === 'string' && body.authHeader ? { authHeader: body.authHeader } : {}),
        ...(typeof body.supportsVision === 'boolean' ? { supportsVision: body.supportsVision } : {}),
        ...(typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0 ? { timeoutMs: body.timeoutMs } : {}),
        ...(typeof body.contextWindow === 'number' && Number.isFinite(body.contextWindow) && body.contextWindow > 0 ? { contextWindow: body.contextWindow } : {}),
      });
      cfg.provider = fresh.provider;
      cfg.providers = fresh.providers;
      cfg.routing = fresh.routing;
      broadcast('state', await stateObject());
      json(res, 200, { ok: true, name });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/providers/delete') {
    const body = JSON.parse((await readBody(req)) || '{}') as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      json(res, 400, { error: 'name required' });
      return true;
    }
    try {
      const fresh = await deleteProvider(name);
      cfg.provider = fresh.provider;
      cfg.providers = fresh.providers;
      cfg.routing = fresh.routing;
      broadcast('state', await stateObject());
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  // ---- general settings ----
  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      locale?: unknown; approval?: unknown; autoEvolveEvery?: unknown; autoPatch?: unknown; theme?: unknown;
    };
    const partial: Record<string, unknown> = {};
    if (body.locale !== undefined) {
      if (body.locale !== 'zh' && body.locale !== 'en') {
        json(res, 400, { error: 'locale must be zh|en' });
        return true;
      }
      partial.locale = body.locale;
    }
    if (body.approval !== undefined) {
      if (body.approval !== 'ask' && body.approval !== 'auto') {
        json(res, 400, { error: 'approval must be ask|auto' });
        return true;
      }
      partial.approval = body.approval;
    }
    if (body.autoEvolveEvery !== undefined) {
      const n = Number(body.autoEvolveEvery);
      if (!Number.isInteger(n) || n < 0) {
        json(res, 400, { error: 'autoEvolveEvery must be a non-negative integer' });
        return true;
      }
      partial.autoEvolveEvery = n;
    }
    if (body.autoPatch !== undefined) {
      if (typeof body.autoPatch !== 'boolean') {
        json(res, 400, { error: 'autoPatch must be boolean' });
        return true;
      }
      // lives under evolution.autoPatch in config.json
      partial.evolution = { autoPatch: body.autoPatch };
    }
    if (body.theme !== undefined) {
      if (body.theme !== 'dark' && body.theme !== 'light' && body.theme !== 'system') {
        json(res, 400, { error: 'theme must be dark|light|system' });
        return true;
      }
      partial.theme = body.theme;
    }
    try {
      const fresh = await patchConfig(partial);
      // sync the in-memory cfg field-by-field (evolution object is merged,
      // never wholesale-replaced, so other in-memory evolution fields survive)
      if (fresh.locale !== undefined) cfg.locale = fresh.locale;
      if (fresh.approval !== undefined) cfg.approval = fresh.approval;
      if (fresh.autoEvolveEvery !== undefined) cfg.autoEvolveEvery = fresh.autoEvolveEvery;
      if (fresh.evolution?.autoPatch !== undefined) cfg.evolution = { ...(cfg.evolution ?? {}), autoPatch: fresh.evolution.autoPatch };
      if ((fresh as { theme?: string }).theme !== undefined) (cfg as { theme?: string }).theme = (fresh as { theme?: string }).theme;
      broadcast('state', await stateObject());
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  return false;
}
