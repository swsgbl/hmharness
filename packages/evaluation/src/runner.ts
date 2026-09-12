/**
 * @hmharness/evaluation - trajectory linkage + bench bridge (M2).
 *
 * evaluateRun(): judge a finished run from its TRAJECTORY RECORD - the
 * outcome, tool completion ratio and error observations - never from the
 * agent's word for itself. The verdict is appended back as judge.completed
 * events on a linked judge-run, so every promotion decision is auditable.
 * runBenchCase(): the existing bench gate semantics through the Evaluator
 * contract, so evolution and evaluation share one assertion core.
 */
import { jsonlTrajectoryStore, createTrajectoryRecorder, type Trajectory } from '@hmharness/observability';
import { textAssertionEvaluator, type TextAssertionInput, type EvaluationResult, type Evidence } from './index.ts';

/** Score a run from its recorded trajectory metrics (hard evidence only). */
export function evaluateTrajectory(trajectory: Trajectory): EvaluationResult {
  const t0 = Date.now();
  const evidence: Evidence[] = [];
  const failures: { reason: string }[] = [];
  const outcome = trajectory.outcome;
  if (outcome) {
    evidence.push({ kind: 'runtime', detail: `outcome ${outcome.success ? 'success' : 'failed'} (${outcome.reason ?? '?'})`, passed: outcome.success });
    if (!outcome.success) failures.push({ reason: `run outcome: ${outcome.reason ?? 'failed'}${outcome.error ? ` - ${outcome.error}` : ''}` });
  } else {
    failures.push({ reason: 'run has no outcome recorded (unfinished?)' });
  }
  const toolDone = trajectory.events.filter((e) => e.type === 'tool.completed');
  const toolFailed = toolDone.filter((e) => (e.payload as { isError?: boolean })?.isError === true);
  if (toolDone.length > 0) {
    const ratio = (toolDone.length - toolFailed.length) / toolDone.length;
    evidence.push({ kind: 'runtime', detail: `tool completion ${toolDone.length - toolFailed.length}/${toolDone.length}`, passed: ratio >= 0.5 });
    if (ratio < 0.5) failures.push({ reason: `majority of tool calls failed (${toolFailed.length}/${toolDone.length})` });
  }
  const errors = trajectory.events.filter((e) => e.type === 'error.observed').length;
  evidence.push({ kind: 'runtime', detail: `${errors} error observation(s)`, passed: errors === 0 });
  const score = failures.length === 0 ? 1 : Math.max(0, 1 - failures.length * 0.34);
  return {
    score, passed: failures.length === 0, evidence, failures,
    evaluatorId: 'trajectory-metrics', evaluatorVersion: '1.0.0', durationMs: Date.now() - t0,
  };
}

/** Evaluate a completed run from its trajectory and record the verdict back
 *  onto a linked judge-run (part of the auditable record). */
export async function evaluateRun(
  home: string,
  runId: string,
  _assertions?: TextAssertionInput,
): Promise<EvaluationResult & { runId: string }> {
  const store = jsonlTrajectoryStore(home);
  const trajectory = await store.getRun(runId);
  const result = evaluateTrajectory(trajectory);
  const rec = createTrajectoryRecorder(home, { task: `(judge) ${trajectory.task.slice(0, 80)}`, cwd: trajectory.cwd });
  rec.emit('judge.started', 'judge', { subjectRunId: runId, evaluator: 'trajectory-metrics' });
  rec.emit('judge.completed', 'judge', {
    subjectRunId: runId, evaluator: 'trajectory-metrics',
    passed: result.passed, score: result.score, failures: result.failures.map((f) => f.reason),
  });
  rec.finish({ success: result.passed, reason: 'final' });
  return { ...result, runId };
}

/** Bench gate semantics through the Evaluator contract (shared assertion core). */
export async function runBenchCase(c: {
  name: string;
  prompt: string;
  output: string;
  expect?: string[];
  expectExact?: string;
  expectRegex?: string;
  expectNone?: string[];
  expectAny?: string[];
}): Promise<{ name: string; pass: boolean; detail: string; score: number }> {
  void textAssertionEvaluator; // assertion core shared via evaluators.ts
  const r = await textAssertionEvaluator.evaluate({
    output: c.output,
    expect: c.expect, expectExact: c.expectExact, expectRegex: c.expectRegex,
    expectNone: c.expectNone, expectAny: c.expectAny,
  });
  return { name: c.name, pass: r.passed, detail: r.failures.map((f) => f.reason).join('; ') || 'ok', score: r.score };
}
