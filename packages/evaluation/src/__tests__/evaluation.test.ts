import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textAssertionEvaluator, commandEvaluator, llmJudgeEvaluator, scoreFromEvidence, evaluateRun, EVIDENCE_RANK } from '../index.ts';

test('text-assertion: all five assertion modes enforced with evidence', async () => {
  const ok = await textAssertionEvaluator.evaluate({
    output: 'BUILD SUCCESSFUL in 12s\nhap signed: entry-default-signed.hap',
    expect: ['build successful', 'signed'],
    expectAny: ['hap', 'app'],
    expectNone: ['failed', 'error'],
  });
  assert.equal(ok.passed, true);
  assert.equal(ok.score, 1);
  assert.ok(ok.evidence.every((e) => e.kind === 'static'));

  const bad = await textAssertionEvaluator.evaluate({
    output: 'BUILD FAILED',
    expect: ['build successful'],
    expectNone: ['failed'],
  });
  assert.equal(bad.passed, false);
  assert.equal(bad.failures.length, 2, 'missing substring + forbidden marker');
});

test('command-exit: exit code is hard evidence, output markers checked', async () => {
  const ok = await commandEvaluator.evaluate({ command: process.execPath, args: ['-e', 'console.log("HMB-OK")'], timeoutMs: 30_000 });
  assert.equal(ok.passed, true);
  assert.equal(ok.evidence[0].kind, 'build');

  const fail = await commandEvaluator.evaluate({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 30_000 });
  assert.equal(fail.passed, false);
  assert.match(fail.failures[0].reason, /exit 3/);
});

test('llm-judge: verdict capped at 0.7 - judge alone never scores a full pass', async () => {
  const pass = await llmJudgeEvaluator.evaluate({ task: 't', output: 'o', criteria: ['c'], call: async () => 'PASS looks right' });
  assert.equal(pass.passed, true);
  assert.equal(pass.score, 0.7, 'hard cap applies');
  const fail = await llmJudgeEvaluator.evaluate({ task: 't', output: 'o', criteria: ['c'], call: async () => 'FAIL criteria unmet' });
  assert.equal(fail.passed, false);
});

test('evidence ladder: build ranks harder than llmJudge in scoring', () => {
  const { score } = scoreFromEvidence(
    [{ kind: 'llmJudge', detail: 'PASS', passed: true }],
    [],
  );
  assert.equal(score, 0.7);
  const hard = scoreFromEvidence([{ kind: 'build', detail: 'exit 0', passed: true }], []);
  assert.equal(hard.score, 1);
  assert.ok(EVIDENCE_RANK.build < EVIDENCE_RANK.llmJudge);
});

test('evaluateRun: judges from the trajectory RECORD (metrics, not self-report) and writes the verdict back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-eval-'));
  try {
    const { createTrajectoryRecorder, jsonlTrajectoryStore } = await import('@hmharness/observability');
    // a healthy run: tools all completed, no errors, success outcome
    const rec = createTrajectoryRecorder(home, { task: 'build the workspace app' });
    rec.emit('run.started', 'user', { task: 'build the workspace app' });
    rec.emit('tool.requested', 'tool', { name: 'harmony_build' });
    rec.emit('tool.completed', 'tool', { name: 'harmony_build', isError: false });
    await rec.finish({ success: true, reason: 'final' }, { turns: 1, toolUses: 1 });

    const result = await evaluateRun(home, rec.runId);
    assert.equal(result.passed, true, 'clean run passes');
    assert.equal(result.score, 1);

    // a failing run: majority tools errored, failed outcome
    const rec2 = createTrajectoryRecorder(home, { task: 'broken task' });
    rec2.emit('tool.completed', 'tool', { name: 'x', isError: true });
    rec2.emit('tool.completed', 'tool', { name: 'y', isError: true });
    rec2.emit('error.observed', 'tool', { name: 'x' });
    await rec2.finish({ success: false, reason: 'error', error: 'boom' }, { toolUses: 2 });
    const result2 = await evaluateRun(home, rec2.runId);
    assert.equal(result2.passed, false);
    assert.ok(result2.failures.length >= 2, 'outcome failure + tool ratio failure recorded');

    // both verdicts are part of the auditable record: evaluateRun settles each
    // judge record before it returns, so there is nothing left to wait for
    const store = jsonlTrajectoryStore(home);
    const runs = await store.listRuns(10);
    const judgeRuns = runs.filter((r) => r.task.startsWith('(judge)'));
    assert.equal(judgeRuns.length, 2, 'one judge-run per evaluated run');
    const judged = await store.getRun(judgeRuns[0].runId);
    assert.deepEqual(judged.events.map((e) => e.type).filter((t) => t.startsWith('judge.')), ['judge.started', 'judge.completed']);
  } finally {
    for (let i = 0; i < 3; i++) {
      try { await rm(home, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
});

test('evaluateRun: the judge run is on disk the moment it returns - nothing waited for', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-eval-'));
  try {
    const { createTrajectoryRecorder } = await import('@hmharness/observability');
    // a healthy run
    const rec = createTrajectoryRecorder(home, { task: 'a healthy run' });
    rec.emit('run.started', 'user', { task: 'a healthy run' });
    rec.emit('tool.completed', 'tool', { name: 'x', isError: false });
    await rec.finish({ success: true, reason: 'final' }, { turns: 1, toolUses: 1 });
    const runs = join(home, 'runs');
    const subject = new Set(await readdir(runs));

    await evaluateRun(home, rec.runId);

    // read at once: no sleep, nothing else awaited
    const judge = (await readdir(runs)).filter((id) => !subject.has(id));
    assert.equal(judge.length, 1, 'the judge run has its directory the instant evaluateRun returned');
    const lines = (await readFile(join(runs, judge[0]!, 'trajectory.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal((JSON.parse(lines.at(-1)!) as { type: string }).type, 'run.completed', 'the end event is the last line on disk');
    assert.match(await readFile(join(runs, judge[0]!, 'summary.json'), 'utf8'), /"success"\s*:\s*true/, 'and so is the summary');
  } finally {
    for (let i = 0; i < 3; i++) {
      try { await rm(home, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
});
