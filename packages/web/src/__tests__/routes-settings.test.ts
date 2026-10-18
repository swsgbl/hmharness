/**
 * settings routes smoke (web split slice 2, 2026-10-16): the seven settings
 * endpoints moved VERBATIM to routes/settings.ts — a live server on a
 * throwaway home pins the delegation (validation shapes + the mutation
 * fan-out actually reaching the shared cfg / state broadcast).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('settings routes served through the extracted module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-set-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let port = 0;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    port = handle.port;
    close = () => handle.close();
    const base = `http://127.0.0.1:${port}`;

    // locale: validation then persistence + fan-out
    const bad = await fetch(`${base}/api/locale`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'fr' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as { error: string }).error, /zh\|en/);

    const ok = await fetch(`${base}/api/locale`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) });
    assert.equal(ok.status, 200);
    const raw = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { locale?: string };
    assert.equal(raw.locale, 'en', 'config.json persisted through the extracted route');

    // config patch: theme validation
    const badTheme = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'neon' }) });
    assert.equal(badTheme.status, 400);
    const goodTheme = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
    assert.equal(goodTheme.status, 200);

    // providers: required-field validation (no mutation attempted)
    const badProv = await fetch(`${base}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(badProv.status, 400);
    assert.match((await badProv.json() as { error: string }).error, /name, baseUrl and model/);

    // model switch to an unknown provider -> 400 with the kernel error
    const badModel = await fetch(`${base}/api/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
    assert.equal(badModel.status, 400);

    // ssh: unknown host -> 404 with configured list
    const ssh = await fetch(`${base}/api/ssh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'ghost', command: 'ls' }) });
    assert.equal(ssh.status, 404);
    assert.ok(Array.isArray((await ssh.json() as { configured: string[] }).configured));

    // devices: read-only inventory shape (hdc absent on most machines -> ok:false is fine)
    const dev = await fetch(`${base}/api/devices`);
    assert.equal(dev.status, 200);
    const devBody = (await dev.json()) as { devices: unknown[]; hdcAvailable: boolean };
    assert.ok(Array.isArray(devBody.devices) && typeof devBody.hdcAvailable === 'boolean');
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
