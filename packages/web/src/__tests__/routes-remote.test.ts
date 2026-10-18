/**
 * remote/extension routes smoke (web split slice 4, 2026-10-17): eight
 * endpoints moved to routes/remote.ts — a live loopback server pins the
 * delegation (loopback-refused mutations + read-only shapes). Pairing
 * endpoints that require lan/wan exposure assert their loopback 400/403
 * guards; the extension probe asserts its honest available:false.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('remote/extension routes served through the extracted module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-remote-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;

    // qr: renders SVG for a valid text; rejects empty/oversized
    // (fixture IP is RFC 5737 documentation-range, never a real address)
    const qr = await fetch(`${base}/api/qr?text=${encodeURIComponent('http://198.51.100.7:7788')}`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type') ?? '', /svg/);
    assert.match(await qr.text(), /<svg/);
    const badQr = await fetch(`${base}/api/qr?text=`);
    assert.equal(badQr.status, 400);

    // remote-info: read-only metadata shape
    const info = await fetch(`${base}/api/remote-info`);
    assert.equal(info.status, 200);
    const infoBody = (await info.json()) as { lanIp?: string; token: string; exposure: string; port: number };
    assert.ok(typeof infoBody.token === 'string' && typeof infoBody.exposure === 'string');
    assert.ok(infoBody.port > 0);

    // pair-info: loopback exposure refuses honestly (400, not a pairing URL)
    const pair = await fetch(`${base}/api/pair-info`);
    assert.equal(pair.status, 400);
    assert.match((await pair.json() as { error: string }).error, /exposure=lan\|wan/);

    // pair/rotate: works even on loopback (rotation is not exposure-gated)
    const rot = await fetch(`${base}/api/pair/rotate`, { method: 'POST' });
    assert.equal(rot.status, 200);
    const rotBody = (await rot.json()) as { ok: boolean; expiresAt: number };
    assert.equal(rotBody.ok, true);
    assert.ok(rotBody.expiresAt > 0);

    // tunnel/mobile mutations: desktop-only guard (loopback transport on a
    // loopback-bound test server reads as NOT lan -> 403 desktop only)
    const tun = await fetch(`${base}/api/tunnel/toggle`, { method: 'POST' });
    assert.equal(tun.status, 403);
    assert.equal((await tun.json() as { error: string }).error, 'desktop only');

    const mob = await fetch(`${base}/api/mobile/disconnect`, { method: 'POST' });
    assert.equal(mob.status, 403);

    // extension bridge probe: no bridge on this machine -> honest available:false
    const ext = await fetch(`${base}/api/extension/status`);
    assert.equal(ext.status, 200);
    const extBody = (await ext.json()) as { available: boolean; port: number };
    assert.equal(extBody.available, false);
    assert.ok(extBody.port > 0);
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
