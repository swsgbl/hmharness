/**
 * @hmharness/extension - token store (round 44: pairing codes REMOVED)
 *
 * The only onboarding path is AUTO-PAIR: an extension-origin announce
 * (browser-enforced origin scheme — the one claim a web page cannot
 * forge) gets a token in the announce response. The pairing-code ritual
 * existed as defense-in-depth, but its two adversaries were already
 * covered: cross-site callers can't fake the origin scheme (and
 * Authorization-bearing requests cannot even be sent cross-site without
 * a preflight we only grant to extensions), and same-user local malware
 * is game-over with or without us. User verdict (2026-10-05): delete it.
 *
 * MULTI-BROWSER (round 44): the store holds UP TO MAX_TOKENS hashes —
 * every installed browser that announces gets its OWN token; nobody
 * kicks anybody. The SSE downlink stays single-slot (the most recent
 * attach answers commands — one live driver at a time), but each
 * browser's token remains valid to (re)attach. `unpair` revokes ALL.
 *
 * Store: HMH_HOME/cognitive/extension-pairing.json — plain JSON,
 * user-inspectable, hashes only (a leaked file cannot be replayed).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_TOKENS = 8;

export interface PairingStore {
  kind: 'hmharness-extension-pairing';
  version: 1;
  /** sha256 of every active token (oldest first; capped at MAX_TOKENS) */
  tokenHashes: string[];
  issuedAt?: string;
  lastSeenAt?: string;
}

export function pairingPath(home: string): string {
  return join(home, 'cognitive', 'extension-pairing.json');
}

async function loadStore(home: string): Promise<PairingStore> {
  try {
    const j = JSON.parse(await readFile(pairingPath(home), 'utf8')) as PairingStore & { tokenHash?: string };
    if (j && j.kind === 'hmharness-extension-pairing') {
      // migrate the pre-round-44 single-token field
      const hashes = j.tokenHashes?.length ? j.tokenHashes : (j.tokenHash ? [j.tokenHash] : []);
      return { ...j, tokenHashes: hashes.slice(-MAX_TOKENS) };
    }
  } catch { /* absent/corrupt = fresh store */ }
  return { kind: 'hmharness-extension-pairing', version: 1, tokenHashes: [] };
}

async function saveStore(home: string, store: PairingStore): Promise<void> {
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(pairingPath(home), JSON.stringify(store, null, 1), 'utf8');
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Constant-time hex compare; length-mismatched input still burns a compare. */
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); // equal-cost dummy compare
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Mint + pin a token (auto-pair): the caller has ALREADY established the
 *  request came from a real extension (extension-scheme Origin). Each
 *  browser gets its own; the oldest hash beyond MAX_TOKENS is dropped. */
export async function mintAndPinToken(home: string): Promise<string> {
  const store = await loadStore(home);
  const token = randomBytes(32).toString('hex');
  const tokenHashes = [...store.tokenHashes, sha(token)].slice(-MAX_TOKENS);
  await saveStore(home, { ...store, tokenHashes, issuedAt: new Date().toISOString() });
  return token;
}

/** Verify a bearer token against ANY of the pinned hashes (constant time). */
export async function verifyToken(home: string, token: string): Promise<boolean> {
  const store = await loadStore(home);
  const candidate = sha(String(token ?? ''));
  let matched = false;
  for (const h of store.tokenHashes) {
    if (hashEquals(h, candidate)) matched = true;
  }
  return matched;
}

/** How many browsers hold a valid token (status display). */
export async function pairedCount(home: string): Promise<number> {
  return (await loadStore(home)).tokenHashes.length;
}

/** Is any browser paired (verifies nothing — display only). */
export async function isPaired(home: string): Promise<boolean> {
  return (await pairedCount(home)) > 0;
}

export async function touchLastSeen(home: string): Promise<void> {
  const store = await loadStore(home);
  if (store.tokenHashes.length > 0) await saveStore(home, { ...store, lastSeenAt: new Date().toISOString() });
}

/** Revoke EVERY token (`hmh extension unpair`) — all browsers re-pair on
 *  their next announce (auto; no re-entry of anything). */
export async function unpair(home: string): Promise<boolean> {
  const store = await loadStore(home);
  if (store.tokenHashes.length === 0) return false;
  await saveStore(home, { ...store, tokenHashes: [], issuedAt: undefined, lastSeenAt: undefined });
  return true;
}
