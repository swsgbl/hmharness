/**
 * @hmharness/extension - pairing codes + bearer tokens
 *
 * ChatGPT-extension-style pairing, adapted to hmharness's trust-file
 * conventions (same file discipline as browser/lsp trust stores):
 *
 *  - `hmh extension pair` prints a ONE-TIME 8-char code (5-minute TTL).
 *    The user types it into the extension popup ONCE — only something
 *    running on this machine, shown this code, can pair.
 *  - a successful pair mints a 32-byte bearer token. The store keeps
 *    ONLY the sha256 of the token — a leaked pairing file cannot be
 *    replayed against the bridge.
 *  - brute force is throttled at the STORE level (5 bad codes -> 60s
 *    lockout) so the HTTP layer stays dumb and every entry path is
 *    covered, not just the one handler that remembered to check.
 *  - `hmh extension unpair` revokes; the bridge drops a connected
 *    extension on the next request.
 *
 * Store: HMH_HOME/cognitive/extension-pairing.json — plain JSON,
 * user-inspectable, no secrets at rest (hash only).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — read-aloud safe
export const CODE_TTL_MS = 5 * 60_000;
export const PAIR_ATTEMPT_LIMIT = 5;
export const PAIR_LOCKOUT_MS = 60_000;

export interface PairingStore {
  kind: 'hmharness-extension-pairing';
  version: 1;
  /** sha256 of the active bearer token (hex) — the token itself is NEVER stored */
  tokenHash?: string;
  issuedAt?: string;
  lastSeenAt?: string;
  /** the pending one-time code, hashed — printed plaintext exists only on the terminal */
  pendingCodeHash?: string;
  pendingExpiresAt?: number;
  failedAttempts: number;
  lockedUntil?: number;
}

export function pairingPath(home: string): string {
  return join(home, 'cognitive', 'extension-pairing.json');
}

async function loadStore(home: string): Promise<PairingStore> {
  try {
    const j = JSON.parse(await readFile(pairingPath(home), 'utf8')) as PairingStore;
    if (j && j.kind === 'hmharness-extension-pairing') {
      return { ...j, failedAttempts: j.failedAttempts ?? 0 };
    }
  } catch { /* absent/corrupt = fresh store */ }
  return { kind: 'hmharness-extension-pairing', version: 1, failedAttempts: 0 };
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

/** Mint a fresh one-time pairing code. Returns the PLAINTEXT code (printed
 *  once by the CLI); only its hash is persisted. Any previous pending code
 *  is replaced. Refuses while locked out (returns the wait, never a code). */
export async function issuePairingCode(home: string): Promise<{ ok: true; code: string; expiresAt: number } | { ok: false; retryInMs: number }> {
  const store = await loadStore(home);
  if (store.lockedUntil && store.lockedUntil > Date.now()) {
    return { ok: false, retryInMs: store.lockedUntil - Date.now() };
  }
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const expiresAt = Date.now() + CODE_TTL_MS;
  await saveStore(home, {
    ...store,
    pendingCodeHash: sha(code),
    pendingExpiresAt: expiresAt,
    failedAttempts: 0,
    lockedUntil: undefined,
  });
  return { ok: true, code, expiresAt };
}

/** Redeem a one-time code -> bearer token. Single use, TTL'd, throttled. */
export async function redeemPairingCode(home: string, code: string): Promise<{ ok: true; token: string } | { ok: false; error: string; retryInMs?: number }> {
  const store = await loadStore(home);
  if (store.lockedUntil && store.lockedUntil > Date.now()) {
    return { ok: false, error: `配对已临时锁定（连续失败），${Math.ceil((store.lockedUntil - Date.now()) / 1000)}s 后重试`, retryInMs: store.lockedUntil - Date.now() };
  }
  const pending = store.pendingCodeHash;
  const expired = !pending || !store.pendingExpiresAt || store.pendingExpiresAt < Date.now();
  const matches = pending !== undefined && hashEquals(pending, sha(String(code ?? '')));
  if (expired || !matches) {
    const failedAttempts = store.failedAttempts + 1;
    if (failedAttempts >= PAIR_ATTEMPT_LIMIT) {
      await saveStore(home, { ...store, pendingCodeHash: undefined, pendingExpiresAt: undefined, failedAttempts: 0, lockedUntil: Date.now() + PAIR_LOCKOUT_MS });
      return { ok: false, error: `配对码错误次数过多，锁定 ${PAIR_LOCKOUT_MS / 1000}s`, retryInMs: PAIR_LOCKOUT_MS };
    }
    await saveStore(home, { ...store, failedAttempts });
    return { ok: false, error: expired ? '配对码已过期（hmh extension pair 重新生成）' : '配对码不正确' };
  }
  // single use: clear the pending code, mint + hash the token
  const token = randomBytes(32).toString('hex');
  await saveStore(home, {
    ...store,
    pendingCodeHash: undefined,
    pendingExpiresAt: undefined,
    failedAttempts: 0,
    lockedUntil: undefined,
    tokenHash: sha(token),
    issuedAt: new Date().toISOString(),
  });
  return { ok: true, token };
}

/** Verify a bearer token against the store (constant time). */
export async function verifyToken(home: string, token: string): Promise<boolean> {
  const store = await loadStore(home);
  if (!store.tokenHash) {
    hashEquals('00'.repeat(32), '00'.repeat(32)); // equal-cost path when unpaired
    return false;
  }
  return hashEquals(store.tokenHash, sha(String(token ?? '')));
}

/** Is there a paired token at all (status display — verifies nothing). */
export async function isPaired(home: string): Promise<boolean> {
  const store = await loadStore(home);
  return Boolean(store.tokenHash);
}

export async function touchLastSeen(home: string): Promise<void> {
  const store = await loadStore(home);
  if (store.tokenHash) await saveStore(home, { ...store, lastSeenAt: new Date().toISOString() });
}

/** Revoke the paired token (`hmh extension unpair`). */
export async function unpair(home: string): Promise<boolean> {
  const store = await loadStore(home);
  if (!store.tokenHash) return false;
  await saveStore(home, { ...store, tokenHash: undefined, issuedAt: undefined, lastSeenAt: undefined });
  return true;
}
