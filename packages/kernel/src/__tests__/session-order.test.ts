/**
 * Session order and "load more" (2026-11-26).
 *
 * Two session files written back to back land on the same clock tick 40% of
 * the time on the Windows machine this was measured on (modification times
 * carry fractions of a millisecond and advance in ticks), and the tie was
 * settled by the random id: the resume list showed the OLDER session first in
 * a fifth of such pairs. Pagination rebuilt its position by comparing
 * timestamps with the cursor's, which carries whole milliseconds only - so a
 * session updated in the anchor's own millisecond a moment earlier was
 * skipped. The numbers were taken with `.audit/web-modernization/mtime-tie-probe.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as kernel from '../session.ts';

type ListFn = (home: string, opts: { sort: 'updated' | 'created'; limit?: number; cursor?: string }) => Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>;
const listSessions = (): ListFn => {
  const fn = (kernel as Record<string, unknown>).listSessions;
  assert.equal(typeof fn, 'function');
  return fn as unknown as ListFn;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// longer than a clock tick, so two files made with this pause have distinct creation times
const TICK = 20;

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-order-'));
  try {
    await mkdir(join(home, 'sessions'), { recursive: true });
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** One rollout with the given id and title. */
async function write(home: string, id: string, title: string, cwd = '/w/x'): Promise<string> {
  const file = join(home, 'sessions', id + '.jsonl');
  await writeFile(file, JSON.stringify({ t: 'session/start', id, time: '2026-01-01T10:00:00Z', cwd, model: 'm' }) + '\n'
    + JSON.stringify({ t: 'user', time: 'x', text: title }) + '\n', 'utf8');
  return file;
}

test('same modification time: the session created later is listed first, whichever ids they have', async () => {
  await withHome(async (home) => {
    const ls = listSessions();
    // the OLDER file carries the larger id: by the old tie rule it came first
    const olderId = '2026-01-01T10-00-00-zzzz';
    const newerId = '2026-01-01T10-00-00-aaaa';
    const older = await write(home, olderId, 'older session');
    await sleep(TICK);
    const newer = await write(home, newerId, 'newer session');
    assert.notEqual((await stat(older)).birthtimeMs, (await stat(newer)).birthtimeMs, 'the two files have distinct creation times on this file system');
    const at = new Date('2026-06-01T00:00:00Z');
    await utimes(older, at, at);
    await utimes(newer, at, at);
    assert.equal((await stat(older)).mtimeMs, (await stat(newer)).mtimeMs, 'the two files have the very same modification time');

    const byUpdated = await ls(home, { sort: 'updated' });
    assert.deepEqual(byUpdated.items.map((i) => i.id), [newerId, olderId]);
    // the id stamps are the same second too, so "created" is a tie the same way
    const byCreated = await ls(home, { sort: 'created' });
    assert.deepEqual(byCreated.items.map((i) => i.id), [newerId, olderId]);
  });
});

test('"load more" does not skip a session updated in the anchor\'s own millisecond, a moment earlier', async () => {
  await withHome(async (home) => {
    const ls = listSessions();
    const a = await write(home, '2026-01-01T10-00-00-aaaa', 'A');
    const b = await write(home, '2026-01-01T10-00-00-bbbb', 'B');
    const d = await write(home, '2026-01-01T10-00-00-dddd', 'D');
    const c = await write(home, '2026-01-01T10-00-00-cccc', 'C');
    // all of A, B, D were last written inside ONE millisecond, in this order; C a second earlier
    // (utimes takes seconds: 0.0009 s is 0.9 ms)
    const base = Date.parse('2026-06-01T00:00:00Z') / 1000;
    await utimes(a, base + 0.0009, base + 0.0009);
    await utimes(b, base + 0.0005, base + 0.0005);
    await utimes(d, base + 0.0002, base + 0.0002);
    await utimes(c, base - 1, base - 1);
    const ms = (f: string) => stat(f).then((s) => s.mtimeMs);
    const [ma, mb, md, mc] = await Promise.all([ms(a), ms(b), ms(d), ms(c)]);
    assert.ok(ma > mb && mb > md && md > mc, `the modification times keep their order: ${ma} > ${mb} > ${md} > ${mc}`);
    assert.equal(Math.floor(ma), Math.floor(md), 'A, B and D share one millisecond');

    const all = await ls(home, { sort: 'updated' });
    assert.deepEqual(all.items.map((i) => i.id.slice(-4)), ['aaaa', 'bbbb', 'dddd', 'cccc'], 'newest first, by the full modification time');
    const p1 = await ls(home, { sort: 'updated', limit: 2 });
    assert.deepEqual(p1.items.map((i) => i.id.slice(-4)), ['aaaa', 'bbbb']);
    assert.ok(p1.nextCursor, 'there is a next page');
    const p2 = await ls(home, { sort: 'updated', limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.items.map((i) => i.id.slice(-4)), ['dddd', 'cccc'], 'the page after B starts with D - the row in B\'s own millisecond');
    assert.equal(p2.nextCursor, null);
  });
});

test('the page after an anchor still starts in the right place when the anchor row was deleted in between', async () => {
  await withHome(async (home) => {
    const ls = listSessions();
    const a = await write(home, '2026-01-01T10-00-00-aaaa', 'A');
    const b = await write(home, '2026-01-01T10-00-00-bbbb', 'B');
    const d = await write(home, '2026-01-01T10-00-00-dddd', 'D');
    const t = (s: string) => new Date('2026-06-01T00:00:' + s + 'Z');
    await utimes(a, t('03'), t('03'));
    await utimes(b, t('02'), t('02'));
    await utimes(d, t('01'), t('01'));
    const p1 = await ls(home, { sort: 'updated', limit: 2 });
    assert.deepEqual(p1.items.map((i) => i.id.slice(-4)), ['aaaa', 'bbbb']);
    assert.ok(p1.nextCursor, 'there is a next page');
    // B disappears between the two pages: the cursor still has to lead past it
    await rm(b);
    const p2 = await ls(home, { sort: 'updated', limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.items.map((i) => i.id.slice(-4)), ['dddd'], 'neither the deleted anchor nor anything before it comes back');
    assert.equal(p2.nextCursor, null);
  });
});
