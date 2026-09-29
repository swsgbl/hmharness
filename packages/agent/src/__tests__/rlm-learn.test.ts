import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rlmWorkspaceTool } from '../rlm-tool.ts';
import { runLearningLoop } from '@hmharness/cognitive';
import { TrajectoryStore, TrajectoryRecorder } from '@hmharness/cognitive';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rlm-live-'));
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tmpHome();
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

const ctxOf = (home: string) => ({ cwd: '.', home });
const exec = (args: Record<string, unknown>, home: string) => rlmWorkspaceTool.execute!(args, ctxOf(home));

test('rlm tool: set/get/list round-trip persists across calls', async () => {
  await withHome(async (home) => {
    assert.match(String((await exec({ action: 'set', name: 'findings', value: 'module-a,module-b' }, home)).output), /set findings/);
    assert.equal(String((await exec({ action: 'get', name: 'findings' }, home)).output), 'module-a,module-b');
    assert.match(String((await exec({ action: 'list' }, home)).output), /findings/);
  });
});

test('rlm tool: eval composes variables; sandbox denies governance writes; budget meters', async () => {
  await withHome(async (home) => {
    await exec({ action: 'set', name: 'a', value: '1' }, home);
    await exec({ action: 'set', name: 'b', value: '2' }, home);
    const r = await exec({ action: 'eval', code: 'return Number(ctx.vars.a) + Number(ctx.vars.b);' }, home);
    assert.equal(String(r.output), '3');
    assert.equal(r.isError, undefined);
    // governance frozen: assigning ctx.meta throws in strict mode -> error result
    const hack = await exec({ action: 'eval', code: 'ctx.meta = { hacked: true }; return "ok";' }, home);
    assert.ok(hack.isError);
    // invalid name rejected
    const bad = await exec({ action: 'set', name: '9bad', value: 'x' }, home);
    assert.ok(bad.isError);
  });
});

test('rlm tool: checkpoint/restore round-trip; reset clears', async () => {
  await withHome(async (home) => {
    await exec({ action: 'set', name: 'x', value: 'before' }, home);
    const cp = String((await exec({ action: 'checkpoint', label: 'pre' }, home)).output);
    assert.match(cp, /checkpoint cp-\d+/);
    const id = (cp.match(/cp-\d+/) ?? [''])[0];
    await exec({ action: 'set', name: 'x', value: 'after' }, home);
    assert.match(String((await exec({ action: 'restore', checkpointId: id }, home)).output), /restored/);
    assert.equal(String((await exec({ action: 'get', name: 'x' }, home)).output), 'before');
    assert.match(String((await exec({ action: 'reset' }, home)).output), /cleared/);
    const empty = await exec({ action: 'list' }, home);
    assert.match(String(empty.output), /empty/);
  });
});

test('learning loop: memory-target opportunities train entries with provenance', async () => {
  await withHome(async (home) => {
    // two failing trajectories -> failure-cluster opportunity
    const store = new TrajectoryStore(home);
    for (const id of ['f1', 'f2']) {
      const rec = new TrajectoryRecorder(id, 's', { id: 'terminal', version: '1' });
      rec.record({ action: { id: 'a', type: 'run_command', args: {} }, outcome: 'failure', evidence: [] });
      await store.append(rec.finish(false));
    }
    const notes: string[] = [];
    const report = await runLearningLoop(home, { writeEvolutionNote: async (n) => { notes.push(n); } });
    assert.ok(report.opportunities >= 1);
    assert.ok(report.trained >= 1);
    const trained = report.outcomes.find((o) => o.trained);
    assert.ok(trained);
    assert.ok(trained!.memoryEntries.length > 0);
    assert.ok(notes.length >= 1, 'evolution note must be written for retrieval injection');
    assert.match(notes[0], /\[lesson\]/);
    // memory landed with provenance
    const { CognitiveMemory } = await import('@hmharness/cognitive');
    const mem = new CognitiveMemory(home);
    await mem.load();
    const lesson = mem.retrieve({ layer: 'semantic', text: 'lesson', limit: 5 });
    assert.ok(lesson.some((e) => e.source === 'learning-loop' && e.provenance.startsWith('opportunity:')));
  });
});
