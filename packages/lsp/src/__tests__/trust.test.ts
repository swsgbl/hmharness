import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTrust, trustServer, untrustServer, listTrust, serverHash, trustPath } from '../trust.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'lsp-trust-'));
}

test('trust: PATH server needs explicit trust; trust pins the hash; round-trip verifies', async () => {
  const home = await tmpHome();
  const bin = join(home, 'fake-server.bin');
  await writeFile(bin, Buffer.from('fake server binary v1'));
  const server = { id: 'fakepath', command: bin, origin: 'PATH' };
  // untrusted initially
  const v0 = await checkTrust(home, server);
  assert.equal(v0.trusted, false);
  assert.match(v0.reason, /hmh lsp trust fakepath/);
  // trust pins the current hash
  const t = await trustServer(home, server);
  assert.equal(t.ok, true);
  assert.equal(t.sha256, await serverHash(bin));
  // now trusted, hash matches
  const v1 = await checkTrust(home, server);
  assert.equal(v1.trusted, true);
  assert.match(v1.reason, /hash matches/);
  // binary CHANGES -> tamper refusal with both hashes shown
  await writeFile(bin, Buffer.from('tampered binary'));
  const v2 = await checkTrust(home, server);
  assert.equal(v2.trusted, false);
  assert.match(v2.reason, /CHANGED/);
  assert.equal(v2.tampered?.pinned, t.sha256);
  assert.equal(v2.tampered?.actual, await serverHash(bin));
  // untrust works and returns to untrusted
  assert.equal(await untrustServer(home, 'fakepath'), true);
  assert.equal((await checkTrust(home, server)).trusted, false);
  assert.equal(await untrustServer(home, 'fakepath'), false);
  await rm(home, { recursive: true, force: true });
});

test('trust: DevEco-local servers auto-trust ONCE with pinning', async () => {
  const home = await tmpHome();
  const bin = join(home, 'clangd.exe');
  await writeFile(bin, Buffer.from('official clangd bytes'));
  const server = { id: 'clangd', command: bin, origin: 'DevEco-local' };
  const v1 = await checkTrust(home, server);
  assert.equal(v1.trusted, true);
  assert.match(v1.reason, /auto-trusted/);
  // the pin landed in the store (user-inspectable JSON)
  const store = JSON.parse(await readFile(trustPath(home), 'utf8'));
  assert.equal(store.entries.clangd.autoTrusted, true);
  assert.equal(store.entries.clangd.sha256, await serverHash(bin));
  // second check: now a normal trusted entry, still hash-matched
  const v2 = await checkTrust(home, server);
  assert.equal(v2.trusted, true);
  // tamper detection applies to auto-trusted servers equally
  await writeFile(bin, Buffer.from('evil'));
  const v3 = await checkTrust(home, server);
  assert.equal(v3.trusted, false);
  assert.match(v3.reason, /CHANGED/);
  // listTrust exposes the audit view
  const entries = await listTrust(home);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, 'clangd');
  await rm(home, { recursive: true, force: true });
});
