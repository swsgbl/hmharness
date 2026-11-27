/**
 * settleRecord (2026-11-27): a bounded, never-throwing wait for a run record.
 *
 * The recorder is a fire-and-forget queue; finish() returns the queue's tail.
 * The agent runner and the judge used to drop that promise on the floor, so a
 * run could be reported done while its record was not on disk yet (it surfaced
 * as a flaky test on a slow CI runner). This is the one wait both of them use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as obs from '../index.ts';

const { createTrajectoryRecorder, RECORD_SETTLE_MS, settleRecord } = obs;
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const RECORDER_URL = pathToFileURL(join(REPO, 'packages', 'observability', 'src', 'recorder.ts')).href;

test('settleRecord: waits for the record, but never past its limit, and never throws', { timeout: 5_000 }, async () => {
  assert.equal(typeof settleRecord, 'function');
  assert.equal(await settleRecord(Promise.resolve(), 1_000), 'settled');
  // the record's own error is reported, not raised: the first version of this
  // helper let it escape - a task that had just SUCCEEDED would have failed on
  // its audit trail
  assert.equal(await settleRecord(Promise.reject(new Error('disk full')), 1_000), 'failed');
  const t0 = Date.now();
  assert.equal(await settleRecord(new Promise<void>(() => { /* a hung disk */ }), 40), 'timed out');
  assert.ok(Date.now() - t0 < 1_000, 'it gave up at its limit, not later');
});

test('a real record: a long one settles well inside the limit, and is whole on disk when it does', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-settle-'));
  try {
    // 300 events is a long run (measured 2026-11-27: 50-94 ms to settle, even
    // with every core busy - a fraction of the 2 s limit)
    const rec = createTrajectoryRecorder(home, { task: 'a long run' });
    for (let n = 0; n < 300; n++) rec.emit('tool.completed', 'tool', { name: 'echo', n });
    assert.equal(await settleRecord(rec.finish({ success: true, reason: 'final' })), 'settled');
    // read at once - nothing else awaited
    const [id] = await readdir(join(home, 'runs'));
    assert.ok(id, 'the run directory is there');
    const lines = (await readFile(join(home, 'runs', id, 'trajectory.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 302, 'run.created + 300 events + the end event');
    assert.equal((JSON.parse(lines.at(-1)!) as { type: string }).type, 'run.completed', 'the end event is the last line on disk');
    assert.match(await readFile(join(home, 'runs', id, 'summary.json'), 'utf8'), /"success"\s*:\s*true/, 'and so is the summary');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('settleRecord leaves no timer behind: a one-shot process that settled exits at once', { timeout: 20_000 }, async (t) => {
  assert.equal(typeof settleRecord, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'hmh-settle-'));
  try {
    // a real process, the way a one-shot `hmh` command ends: settle, then fall off the end
    const script = join(dir, 'oneshot.mjs');
    await writeFile(script, [
      `import { settleRecord } from ${JSON.stringify(RECORDER_URL)};`,
      `process.stdout.write(String(await settleRecord(Promise.resolve())));`,
    ].join('\n'));
    const t0 = Date.now();
    const out = await new Promise<{ code: number | null; text: string }>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: REPO });
      let text = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; });
      t.signal.addEventListener('abort', () => { child.kill(); }, { once: true });
      child.on('error', () => done({ code: -1, text }));
      child.on('exit', (code) => done({ code, text }));
    });
    const waited = Date.now() - t0;
    assert.equal(out.code, 0, out.text);
    assert.equal(out.text, 'settled');
    // a timer left running keeps the process alive for the rest of the limit:
    // every one-shot command would end with a dead 2 s wait
    assert.ok(waited < RECORD_SETTLE_MS, `the process took ${waited} ms - longer than the ${RECORD_SETTLE_MS} ms limit`);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
