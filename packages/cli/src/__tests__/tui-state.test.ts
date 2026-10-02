import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePending, loadPending, clearPending, pendingPath } from '../tui-state.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tui-state-'));
}

test('tui-state: save/load roundtrip carries the crash context', async () => {
  const home = await tmpHome();
  await savePending(home, {
    runningTask: 'build the module and run tests',
    queue: ['then update the README', 'then bump the version'],
    sessionId: 'ses-42',
    savedAt: '2026-10-02T10:11:12Z',
  });
  const pend = await loadPending(home);
  assert.ok(pend, 'saved pending must load back');
  assert.equal(pend!.runningTask, 'build the module and run tests');
  assert.deepEqual(pend!.queue, ['then update the README', 'then bump the version']);
  assert.equal(pend!.sessionId, 'ses-42');
  await rm(home, { recursive: true, force: true });
});

test('tui-state: clear removes the file (graceful quit = no recall notice)', async () => {
  const home = await tmpHome();
  await savePending(home, { runningTask: 'x', queue: [], savedAt: '2026-10-02T10:11:12Z' });
  await clearPending(home);
  assert.equal(await loadPending(home), null);
  await rm(home, { recursive: true, force: true });
});

test('tui-state: corrupt or wrong-shaped files degrade to null, never throw', async () => {
  const home = await tmpHome();
  await writeFile(pendingPath(home), '{not json at all', 'utf8');
  assert.equal(await loadPending(home), null);
  // structurally wrong: runningTask not a string, queue not an array
  await writeFile(pendingPath(home), JSON.stringify({ runningTask: 5, queue: 'nope' }), 'utf8');
  assert.equal(await loadPending(home), null);
  // queue entries of the wrong type are dropped, not fatal
  await writeFile(pendingPath(home), JSON.stringify({ runningTask: 'ok', queue: ['a', 7, null, 'b'] }), 'utf8');
  const pend = await loadPending(home);
  assert.deepEqual(pend!.queue, ['a', 'b']);
  await rm(home, { recursive: true, force: true });
});

test('tui-state: save failures are silent (best-effort contract)', async () => {
  // an existing FILE as home: writing tui-pending.json under it can never
  // succeed — the courtesy hint must not become a crash
  const blocker = join(tmpdir(), `tui-blocker-${Date.now().toString(36)}`);
  await writeFile(blocker, 'x', 'utf8');
  await savePending(blocker, { runningTask: 't', queue: [], savedAt: '' });
  assert.equal(await loadPending(blocker), null);
  await rm(blocker, { force: true });
});
