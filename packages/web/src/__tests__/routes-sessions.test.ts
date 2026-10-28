/**
 * session run-control routes smoke (web split slice 5a, 2026-10-18): six
 * endpoints moved to routes/sessions.ts — a live loopback server pins the
 * delegation. No task is running in this harness, so the run-control
 * endpoints assert their IDLE contracts (ok:false / 404 / 409 / shapes);
 * the goal endpoint round-trips through the real kernel goal store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('session run-control routes served through the extracted module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-sess-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  // pre-seed the workspace store with a NON-git directory so /api/diff is
  // deterministic: the server adopts workspaces.json from HMH_HOME and
  // chdirs into the current workspace - without this, diff targets the
  // repo checkout and flips git:true (assertion had never actually
  // executed before the 2026-10-29 close() rewrite let this file finish)
  const ws = await mkdtemp(join(tmpdir(), 'hmh-sess-ws-'));
  await writeFile(join(home, 'workspaces.json'), JSON.stringify({ current: 'ws0', items: [{ id: 'ws0', name: 'ws', path: ws }] }), 'utf8');
  const prevCwd = process.cwd();
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // diff: non-git temp workspace -> honest git:false (never a 500)
    const diff = await fetch(`${base}/api/diff`);
    assert.equal(diff.status, 200);
    const diffBody = (await diff.json()) as { git: boolean; cwd: string; changed: unknown[]; stat: string };
    assert.equal(diffBody.git, false);
    assert.ok(Array.isArray(diffBody.changed));

    // interrupt: nothing running -> ok:false with honest counts
    const itr = await post('/api/interrupt', {});
    assert.equal(itr.status, 200);
    const itrBody = (await itr.json()) as { ok: boolean; busy: boolean; running: number };
    assert.equal(itrBody.ok, false);
    assert.equal(itrBody.running, 0);

    // queue GET: empty flat shape
    const q = await fetch(`${base}/api/queue`);
    assert.equal(q.status, 200);
    const qBody = (await q.json()) as { items: string[]; busy: boolean };
    assert.ok(Array.isArray(qBody.items));
    assert.equal(qBody.busy, false);

    // queue DELETE with a bogus index -> 404
    const qd = await fetch(`${base}/api/queue?i=99`, { method: 'DELETE' });
    assert.equal(qd.status, 404);

    // approve: nothing pending -> 404 with concurrent count
    const ap = await post('/api/approve', { granted: true });
    assert.equal(ap.status, 404);
    assert.equal((await ap.json() as { concurrent: number }).concurrent, 0);

    // inject: nothing running -> 409
    const inj = await post('/api/inject', { text: 'hello' });
    assert.equal(inj.status, 409);

    // inject with empty text -> 400 (validation precedes the 409)
    const injEmpty = await post('/api/inject', { text: '   ' });
    assert.equal(injEmpty.status, 400);

    // goal: set then clear through the extracted route (kernel store round-trip)
    const g1 = await post('/api/goal', { goal: 'finish the split' });
    assert.equal(g1.status, 200);
    const g2 = await post('/api/goal', { goal: '' });
    assert.equal(g2.status, 200);
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    process.chdir(prevCwd); // before the rm: Windows cannot delete a live cwd
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});
