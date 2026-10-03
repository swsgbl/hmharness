import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBrowserTrust, trustBrowser, untrustBrowser, listBrowserTrust, browserHash, browserTrustPath } from '../trust.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'browser-trust-'));
}

test('browser trust: PATH binary needs explicit trust; trust pins the hash; round-trip verifies', async () => {
  const home = await tmpHome();
  const bin = join(home, 'BrowserOS.exe');
  await writeFile(bin, Buffer.from('fake browser binary v1'));
  const browser = { id: 'browseros', command: bin, origin: 'PATH' };
  // untrusted initially, with the exact command to fix it
  const v0 = await checkBrowserTrust(home, browser);
  assert.equal(v0.trusted, false);
  assert.match(v0.reason, /hmh browser trust browseros/);
  // trust pins the current hash
  const t = await trustBrowser(home, browser);
  assert.equal(t.ok, true);
  assert.equal(t.sha256, await browserHash(bin));
  // now trusted, hash matches
  const v1 = await checkBrowserTrust(home, browser);
  assert.equal(v1.trusted, true);
  assert.match(v1.reason, /hash matches/);
  // binary CHANGES -> tamper refusal with both hashes + self-update hint
  await writeFile(bin, Buffer.from('tampered binary'));
  const v2 = await checkBrowserTrust(home, browser);
  assert.equal(v2.trusted, false);
  assert.match(v2.reason, /CHANGED/);
  assert.match(v2.reason, /self-update/);
  assert.equal(v2.tampered?.pinned, t.sha256);
  assert.equal(v2.tampered?.actual, await browserHash(bin));
  // untrust works and returns to untrusted
  assert.equal(await untrustBrowser(home, 'browseros'), true);
  assert.equal((await checkBrowserTrust(home, browser)).trusted, false);
  assert.equal(await untrustBrowser(home, 'browseros'), false);
  await rm(home, { recursive: true, force: true });
});

test('browser trust: install-local and config origins auto-trust ONCE with pinning; tamper still caught', async () => {
  for (const origin of ['install-local', 'config'] as const) {
    // fresh store per origin: auto-trust happens only on FIRST absence
    const home = await tmpHome();
    const bin = join(home, 'BrowserOS.exe');
    await writeFile(bin, Buffer.from('official browser bytes'));
    const browser = { id: 'browseros', command: bin, origin };
    const v1 = await checkBrowserTrust(home, browser);
    assert.equal(v1.trusted, true, origin);
    assert.match(v1.reason, /auto-trusted/);
    // the pin landed in the user-inspectable store
    const store = JSON.parse(await readFile(browserTrustPath(home), 'utf8'));
    assert.equal(store.entries.browseros.sha256, await browserHash(bin));
    // tamper detection applies to auto-trusted entries equally
    await writeFile(bin, Buffer.from('evil'));
    const v3 = await checkBrowserTrust(home, browser);
    assert.equal(v3.trusted, false, origin);
    assert.match(v3.reason, /CHANGED/);
    const entries = await listBrowserTrust(home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, 'browseros');
    await rm(home, { recursive: true, force: true });
  }
});
