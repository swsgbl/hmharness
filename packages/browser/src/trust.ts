/**
 * @hmharness/browser - source trust (Capability OS supply-chain guard,
 * same contract as @hmharness/lsp trust, applied to the browser binary)
 *
 * Launching BrowserOS means executing a binary we discovered on the
 * machine — with a profile the agent drives. The rule: 来源白名单 + hash.
 *
 *  - the binary gets a sha256 PIN at trust time
 *  - install-local (official layout) and config (user wrote the path
 *    deliberately) auto-trust ONCE — the pin still applies
 *  - PATH binaries require explicit one-time trust (hmh browser trust)
 *  - a trusted binary whose hash CHANGED is refused (tamper detection),
 *    with both hashes shown; a genuine BrowserOS self-update also trips
 *    this — re-trust knowingly
 *
 * The trust store lives in HMH_HOME/cognitive/browser-trust.json — plain
 * JSON, user-inspectable, no telemetry.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface BrowserTrustEntry {
  id: string;
  command: string;
  sha256: string;
  origin: string;
  trustedAt: string;
  autoTrusted: boolean;
}

export interface BrowserTrustStore {
  kind: 'hmharness-browser-trust';
  version: 1;
  entries: Record<string, BrowserTrustEntry>;
}

export function browserTrustPath(home: string): string {
  return join(home, 'cognitive', 'browser-trust.json');
}

async function loadTrust(home: string): Promise<BrowserTrustStore> {
  try {
    const j = JSON.parse(await readFile(browserTrustPath(home), 'utf8')) as BrowserTrustStore;
    if (j && j.kind === 'hmharness-browser-trust' && j.entries && typeof j.entries === 'object') return j;
  } catch { /* absent/corrupt = empty store */ }
  return { kind: 'hmharness-browser-trust', version: 1, entries: {} };
}

/** sha256 of the browser binary (the executable file itself). */
export async function browserHash(command: string): Promise<string> {
  const buf = await readFile(command);
  return createHash('sha256').update(buf).digest('hex');
}

export interface BrowserTrustVerdict {
  trusted: boolean;
  reason: string;
  /** set when the id is trusted but the BINARY changed (tamper case) */
  tampered?: { pinned: string; actual: string };
}

/** Check whether a discovered browser may be launched. */
export async function checkBrowserTrust(home: string, browser: { id: string; command: string; origin: string }): Promise<BrowserTrustVerdict> {
  const store = await loadTrust(home);
  const entry = store.entries[browser.id];
  const actual = await browserHash(browser.command).catch(() => '');
  if (!entry) {
    if (browser.origin === 'install-local' || browser.origin === 'config') {
      // official install layout / deliberate config path: auto-trust once
      const pinned: BrowserTrustEntry = { id: browser.id, command: browser.command, sha256: actual, origin: browser.origin, trustedAt: new Date().toISOString(), autoTrusted: true };
      const next = { ...store, entries: { ...store.entries, [browser.id]: pinned } };
      await mkdir(join(home, 'cognitive'), { recursive: true });
      await writeFile(browserTrustPath(home), JSON.stringify(next, null, 1), 'utf8');
      return { trusted: true, reason: `auto-trusted (${browser.origin}), sha256 pinned ${actual.slice(0, 12)}…` };
    }
    return { trusted: false, reason: `PATH binary not trusted yet — run: hmh browser trust ${browser.id}` };
  }
  if (entry.sha256 && actual && entry.sha256 !== actual) {
    return {
      trusted: false,
      reason: `binary CHANGED since trust — pinned ${entry.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…; a BrowserOS self-update also changes the hash: re-trust only if you know why it changed`,
      tampered: { pinned: entry.sha256, actual },
    };
  }
  return { trusted: true, reason: `trusted since ${entry.trustedAt.slice(0, 10)} (${entry.autoTrusted ? 'auto' : 'user'}), hash matches` };
}

/** Explicit user trust: pins the CURRENT hash. */
export async function trustBrowser(home: string, browser: { id: string; command: string; origin: string }): Promise<{ ok: boolean; error?: string; sha256?: string }> {
  const sha = await browserHash(browser.command).catch(() => '');
  if (!sha) return { ok: false, error: 'cannot hash the browser binary (unreadable?)' };
  const store = await loadTrust(home);
  store.entries[browser.id] = { id: browser.id, command: browser.command, sha256: sha, origin: browser.origin, trustedAt: new Date().toISOString(), autoTrusted: false };
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(browserTrustPath(home), JSON.stringify(store, null, 1), 'utf8');
  return { ok: true, sha256: sha };
}

/** Revoke trust for a browser id. */
export async function untrustBrowser(home: string, id: string): Promise<boolean> {
  const store = await loadTrust(home);
  if (!store.entries[id]) return false;
  delete store.entries[id];
  await writeFile(browserTrustPath(home), JSON.stringify(store, null, 1), 'utf8');
  return true;
}

/** Read-only view for `hmh browser status`. */
export async function listBrowserTrust(home: string): Promise<BrowserTrustEntry[]> {
  const store = await loadTrust(home);
  return Object.values(store.entries);
}
