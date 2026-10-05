import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TOKENS, isPaired, mintAndPinToken, pairedCount, pairingPath, touchLastSeen, unpair, verifyToken } from '../token.ts';

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ext-token-'));
  await mkdir(join(dir, 'cognitive'), { recursive: true });
  return dir;
}

test('token: auto-pair mint/verify — every browser gets its OWN token (multi-browser)', async () => {
  const home = await tmpHome();
  const t1 = await mintAndPinToken(home);
  const t2 = await mintAndPinToken(home);
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.match(t2, /^[0-9a-f]{64}$/);
  assert.notEqual(t1, t2, 'each announce mints a distinct token');
  // BOTH stay valid — nobody kicks anybody (the SSE slot is single, the
  // authorization set is not)
  assert.equal(await verifyToken(home, t1), true);
  assert.equal(await verifyToken(home, t2), true);
  assert.equal(await pairedCount(home), 2);
  assert.equal(await isPaired(home), true);
  // the store keeps ONLY hashes — plaintext tokens never at rest
  const atRest = await readFile(pairingPath(home), 'utf8');
  assert.doesNotMatch(atRest, new RegExp(t1));
  assert.doesNotMatch(atRest, new RegExp(t2));
  // wrong token refused; unpair revokes ALL
  assert.equal(await verifyToken(home, 'f'.repeat(64)), false);
  assert.equal(await unpair(home), true);
  assert.equal(await verifyToken(home, t1), false);
  assert.equal(await verifyToken(home, t2), false);
  assert.equal(await pairedCount(home), 0);
  assert.equal(await unpair(home), false); // idempotent
  await rm(home, { recursive: true, force: true });
});

test('token: cap at MAX_TOKENS (oldest evicted) + legacy single-token migration + corrupt store', async () => {
  const home = await tmpHome();
  const tokens: string[] = [];
  for (let i = 0; i < MAX_TOKENS + 3; i++) tokens.push(await mintAndPinToken(home));
  assert.equal(await pairedCount(home), MAX_TOKENS);
  // the OLDEST 3 are evicted, the newest MAX_TOKENS survive
  for (let i = 0; i < 3; i++) assert.equal(await verifyToken(home, tokens[i]), false, `token ${i} evicted`);
  for (let i = 3; i < tokens.length; i++) assert.equal(await verifyToken(home, tokens[i]), true, `token ${i} valid`);
  // legacy pre-round-44 store (single tokenHash field) migrates in
  const legacyHome = await tmpHome();
  const tok = await mintAndPinToken(legacyHome); // clean store
  const store = JSON.parse(await readFile(pairingPath(legacyHome), 'utf8')) as { tokenHashes: string[] };
  await writeFile(pairingPath(legacyHome), JSON.stringify({ kind: 'hmharness-extension-pairing', version: 1, tokenHash: store.tokenHashes[0] }), 'utf8');
  assert.equal(await pairedCount(legacyHome), 1);
  assert.equal(await verifyToken(legacyHome, tok), true, 'legacy single-hash store keeps the token valid');
  await rm(legacyHome, { recursive: true, force: true });
  // corrupt JSON reads as an empty store, never crashes
  await writeFile(pairingPath(home), '{not json', 'utf8');
  assert.equal(await pairedCount(home), 0);
  const fresh = await mintAndPinToken(home);
  assert.equal(await verifyToken(home, fresh), true);
  await rm(home, { recursive: true, force: true });
});
