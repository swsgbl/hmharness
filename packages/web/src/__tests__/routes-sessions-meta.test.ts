/**
 * session metadata routes smoke (web split slice 5b, 2026-10-18): six
 * endpoints moved to routes/sessions-meta.ts — a live server on a
 * throwaway home pins the delegation (empty-store shapes, validation
 * guards, and one full rename round-trip through workspaces.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('session metadata routes served through the extracted module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-smeta-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // listing: empty store shape
    const list = await fetch(`${base}/api/sessions`);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { sessions: unknown[]; nextCursor?: unknown };
    assert.ok(Array.isArray(listBody.sessions));
    assert.equal(listBody.sessions.length, 0);

    // unknown session op on a missing id -> 404
    const del = await post('/api/sessions/ghost/delete', {});
    assert.equal(del.status, 404);

    // unknown session preview -> 404
    const prev = await fetch(`${base}/api/sessions/ghost`);
    assert.equal(prev.status, 404);

    // export of a missing session -> 404 (not a 500 with a bogus file)
    const exp = await fetch(`${base}/api/sessions/ghost/export.md`);
    assert.equal(exp.status, 404);

    // feedback: validation guard
    const badFb = await post('/api/feedback', { thumbs: 'sideways' });
    assert.equal(badFb.status, 400);
    // feedback: valid up round-trips into the explicit store
    const okFb = await post('/api/feedback', { sessionId: 's1', thumbs: 'up', text: 'nice' });
    assert.equal(okFb.status, 200);
    const fbLine = JSON.parse((await readFile(join(home, 'insights', 'explicit-feedback.jsonl'), 'utf8')).trim()) as { thumbs: string; session: string };
    assert.equal(fbLine.thumbs, 'up');
    assert.equal(fbLine.session, 's1');

    // label queue: empty-store shape
    const queue = await fetch(`${base}/api/label/list`);
    assert.equal(queue.status, 200);
    const queueBody = (await queue.json()) as { sessions: unknown[]; labeled: number };
    assert.ok(Array.isArray(queueBody.sessions));
    assert.equal(queueBody.labeled, 0);

    // label submit: validation guard (score out of range)
    const badLabel = await post('/api/label', { session: 'x', score: 9 });
    assert.equal(badLabel.status, 400);
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
