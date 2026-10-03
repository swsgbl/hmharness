/**
 * @hmharness/lsp - source trust (Capability OS first slice, 03 方案 supply-chain guard)
 *
 * Running a language server means executing a binary we discovered on the
 * machine. The 03 plan's supply-chain rule: 来源白名单 + hash. This module
 * is that guard:
 *
 *  - every server binary gets a sha256 PIN at trust time
 *  - DevEco-local servers (official IDE install layout) are auto-trusted
 *    ONCE — the pin still applies, so a modified binary is caught
 *  - PATH servers require explicit one-time user trust (hmh lsp trust <id>)
 *  - a trusted binary whose hash CHANGED is refused (tamper detection),
 *    with the old and new hash both shown for audit
 *
 * The trust store lives in HMH_HOME/cognitive/lsp-trust.json — plain JSON,
 * user-inspectable, no telemetry.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TrustEntry {
  id: string;
  command: string;
  sha256: string;
  origin: string;
  trustedAt: string;
  autoTrusted: boolean;
}

export interface TrustStore {
  kind: 'hmharness-lsp-trust';
  version: 1;
  entries: Record<string, TrustEntry>;
}

export function trustPath(home: string): string {
  return join(home, 'cognitive', 'lsp-trust.json');
}

async function loadTrust(home: string): Promise<TrustStore> {
  try {
    const j = JSON.parse(await readFile(trustPath(home), 'utf8')) as TrustStore;
    if (j && j.kind === 'hmharness-lsp-trust' && j.entries && typeof j.entries === 'object') return j;
  } catch { /* absent/corrupt = empty store */ }
  return { kind: 'hmharness-lsp-trust', version: 1, entries: {} };
}

/** sha256 of the server binary (the executable file itself). */
export async function serverHash(command: string): Promise<string> {
  const buf = await readFile(command);
  return createHash('sha256').update(buf).digest('hex');
}

export interface TrustVerdict {
  trusted: boolean;
  reason: string;
  /** set when the id is trusted but the BINARY changed (tamper case) */
  tampered?: { pinned: string; actual: string };
}

/** Check whether a discovered server may be executed. */
export async function checkTrust(home: string, server: { id: string; command: string; origin: string }): Promise<TrustVerdict> {
  const store = await loadTrust(home);
  const entry = store.entries[server.id];
  const actual = await serverHash(server.command).catch(() => '');
  if (!entry) {
    if (server.origin.includes('DevEco-local')) {
      // official IDE install layout: auto-trust once, pin the hash now
      const pinned: TrustEntry = { id: server.id, command: server.command, sha256: actual, origin: server.origin, trustedAt: new Date().toISOString(), autoTrusted: true };
      const next = { ...store, entries: { ...store.entries, [server.id]: pinned } };
      await mkdir(join(home, 'cognitive'), { recursive: true });
      await writeFile(trustPath(home), JSON.stringify(next, null, 1), 'utf8');
      return { trusted: true, reason: `auto-trusted (official DevEco-local layout), sha256 pinned ${actual.slice(0, 12)}…` };
    }
    return { trusted: false, reason: `PATH server not trusted yet — run: hmh lsp trust ${server.id}` };
  }
  if (entry.sha256 && actual && entry.sha256 !== actual) {
    return { trusted: false, reason: `binary CHANGED since trust (tamper?) — pinned ${entry.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…; re-trust only if you know why it changed`, tampered: { pinned: entry.sha256, actual } };
  }
  return { trusted: true, reason: `trusted since ${entry.trustedAt.slice(0, 10)} (${entry.autoTrusted ? 'auto, DevEco-local' : 'user'}), hash matches` };
}

/** Explicit user trust: pins the CURRENT hash. */
export async function trustServer(home: string, server: { id: string; command: string; origin: string }): Promise<{ ok: boolean; error?: string; sha256?: string }> {
  const sha = await serverHash(server.command).catch(() => '');
  if (!sha) return { ok: false, error: 'cannot hash the server binary (unreadable?)' };
  const store = await loadTrust(home);
  store.entries[server.id] = { id: server.id, command: server.command, sha256: sha, origin: server.origin, trustedAt: new Date().toISOString(), autoTrusted: false };
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(trustPath(home), JSON.stringify(store, null, 1), 'utf8');
  return { ok: true, sha256: sha };
}

/** Revoke trust for a server id. */
export async function untrustServer(home: string, id: string): Promise<boolean> {
  const store = await loadTrust(home);
  if (!store.entries[id]) return false;
  delete store.entries[id];
  await writeFile(trustPath(home), JSON.stringify(store, null, 1), 'utf8');
  return true;
}

/** Read-only view for `hmh lsp list`. */
export async function listTrust(home: string): Promise<TrustEntry[]> {
  const store = await loadTrust(home);
  return Object.values(store.entries);
}
