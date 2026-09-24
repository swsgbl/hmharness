import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrajectoryRecorder, jsonlTrajectoryStore, newRunId, brief, RUN_EVENT_TYPES } from '../index.ts';

test('store: append -> getRun -> export round trip', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-traj-'));
  try {
    const store = jsonlTrajectoryStore(home);
    const r = createTrajectoryRecorder(home, { task: 'build the app', model: 'test-model', cwd: 'G:/x' }, store);
    r.emit('context.assembled', 'system', { systemChars: 1234 });
    r.emit('tool.requested', 'tool', { name: 'harmony_build', args: 'module=entry' });
    r.emit('tool.denied', 'system', { name: 'harmony_build' });
    r.finish({ success: true, reason: 'final' }, { turns: 3, toolUses: 1, durationMs: 1200 });
    // recorder appends are queued; wait for the chain to drain (finish is last)
    await new Promise((res) => setTimeout(res, 150));

    const t = await store.getRun(r.runId);
    assert.equal(t.task, 'build the app');
    assert.equal(t.model, 'test-model');
    assert.ok(t.outcome?.success);
    assert.equal(t.metrics?.turns, 3);
    const types = t.events.map((e) => e.type);
    assert.deepEqual(types, ['run.created', 'context.assembled', 'tool.requested', 'tool.denied', 'run.completed']);
    // ids unique + ordered
    const ids = t.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    // jsonl export = one JSON object per line, parseable
    const jsonl = await store.exportRun(r.runId, 'jsonl');
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, t.events.length);
    JSON.parse(lines[0]) as { runId: string };
    // summary on disk
    const summary = JSON.parse(await readFile(join(home, 'runs', r.runId, 'summary.json'), 'utf8')) as { eventCount: number };
    assert.equal(summary.eventCount, t.events.length);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('store: listRuns newest-first, unfinished runs tolerated', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-traj-'));
  try {
    const store = jsonlTrajectoryStore(home);
    const r1 = createTrajectoryRecorder(home, { task: 'first' }, store);
    r1.finish({ success: false, reason: 'error', error: 'boom' });
    const r2 = createTrajectoryRecorder(home, { task: 'second' }, store); // never finished
    await new Promise((res) => setTimeout(res, 150));
    const runs = await store.listRuns(10);
    assert.equal(runs.length, 2);
    assert.ok(runs[0].runId.startsWith('run_'));
    assert.equal(runs.length, 2);
    const finished = runs.find((x) => x.task === 'first');
    const unfinished = runs.find((x) => x.task === '(unfinished)' || x.task === 'second');
    assert.ok(finished?.outcome?.success === false, 'first run outcome persisted');
    assert.ok(unfinished, 'unfinished run still listed');
    assert.ok(r1.runId.slice(0, 18) <= r2.runId.slice(0, 18), 'run ids sort chronologically (timestamp prefix)');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('recorder: storage failure never throws (observability cannot fail a run)', async () => {
  const boom = {
    runDir: () => '/nonexistent',
    append: () => Promise.reject(new Error('disk full')),
    getRun: () => Promise.reject(new Error('no')),
    listRuns: async () => [] as never,
    saveSummary: () => Promise.reject(new Error('disk full')),
    exportRun: () => Promise.reject(new Error('no')),
  };
  const r = createTrajectoryRecorder('X:/nope', { task: 't' }, boom);
  assert.doesNotThrow(() => {
    r.emit('tool.requested', 'tool', { name: 'x' });
    r.finish({ success: true }, { turns: 1 });
  });
});

test('schema: closed event-type set + brief() truncation keeps payloads bounded', () => {
  assert.ok(RUN_EVENT_TYPES.includes('run.completed'));
  assert.ok(RUN_EVENT_TYPES.includes('checkpoint.restored'));
  assert.ok(RUN_EVENT_TYPES.length >= 22);
  assert.equal(brief('a'.repeat(500)), 'a'.repeat(160) + '…');
  assert.equal(brief({ command: 'hvigorw  assembleHap' }), '{"command":"hvigorw assembleHap"}');
  assert.match(newRunId(), /^run_\d{14}_[0-9a-f]{6}$/);
});
