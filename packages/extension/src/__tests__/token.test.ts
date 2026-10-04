import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issuePairingCode, isPaired, pairingPath, redeemPairingCode, unpair, verifyToken } from '../token.ts';

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ext-token-'));
  await mkdir(join(dir, 'cognitive'), { recursive: true });
  return dir;
}

test('token: pairing code lifecycle — issue, redeem once, verify, revoke', async () => {
  const home = await tmpHome();
  const issued = await issuePairingCode(home);
  assert.equal(issued.ok, true);
  if (!issued.ok) return; // narrows the union for the rest of the test
  // the store keeps ONLY the hash — plaintext never at rest
  const atRest = await readFile(pairingPath(home), 'utf8');
  assert.doesNotMatch(atRest, new RegExp(issued.code), 'plaintext code must not be persisted');
  const r = await redeemPairingCode(home, issued.code);
  assert.equal(r.ok, true);
  const token = r.ok ? r.token : '';
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await verifyToken(home, token), true);
  assert.equal(await isPaired(home), true);
  const atRest2 = await readFile(pairingPath(home), 'utf8');
  assert.doesNotMatch(atRest2, new RegExp(token), 'plaintext token must not be persisted');
  // single use: the same code cannot mint a second token
  const again = await redeemPairingCode(home, issued.code);
  assert.equal(again.ok, false);
  // wrong token refused
  assert.equal(await verifyToken(home, 'f'.repeat(64)), false);
  // revoke
  assert.equal(await unpair(home), true);
  assert.equal(await verifyToken(home, token), false);
  assert.equal(await unpair(home), false); // idempotent
  await rm(home, { recursive: true, force: true });
});

test('token: wrong codes cost attempts; 5 bad ones lock the store for both redeem AND issue', async () => {
  const home = await tmpHome();
  const code = await issuePairingCode(home);
  assert.equal(code.ok, true);
  for (let i = 0; i < 4; i++) {
    const bad = await redeemPairingCode(home, 'XXXXXXXX');
    assert.equal(bad.ok, false);
  }
  // the 5th bad attempt trips the lockout (and burns the pending code)
  const locked = await redeemPairingCode(home, 'XXXXXXXX');
  assert.equal(locked.ok, false);
  // locked: even the CORRECT code is refused, and no new code can be issued
  if (code.ok) {
    const good = await redeemPairingCode(home, code.code);
    assert.equal(good.ok, false);
  }
  const reissue = await issuePairingCode(home);
  assert.equal(reissue.ok, false);
  // tampered store: corrupt JSON reads as a fresh store, never crashes
  await writeFile(pairingPath(home), '{not json', 'utf8');
  assert.equal(await isPaired(home), false);
  const fresh = await issuePairingCode(home);
  assert.equal(fresh.ok, true); // lockout state was in the file we corrupted — fresh store is unlocked
  await rm(home, { recursive: true, force: true });
});

test('token: expired code refused with the actionable reason', async () => {
  const home = await tmpHome();
  const code = await issuePairingCode(home);
  assert.equal(code.ok, true);
  // force the pending code into the past
  const store = JSON.parse(await readFile(pairingPath(home), 'utf8'));
  store.pendingExpiresAt = Date.now() - 1_000;
  await writeFile(pairingPath(home), JSON.stringify(store), 'utf8');
  if (code.ok) {
    const r = await redeemPairingCode(home, code.code);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /过期/);
  }
  await rm(home, { recursive: true, force: true });
});
