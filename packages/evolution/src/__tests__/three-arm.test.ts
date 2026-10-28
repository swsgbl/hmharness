/**
 * three-arm experiment core tests — the judge, the selection, the
 * pre-registered statistics, and the promotion gate. The judge is the
 * experiment's environment truth: it must reject model self-report and
 * tolerate nothing the bench assertion does not allow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeOutput, fenceInner, selectTasks, buildTaskSetHash, buildAdaptiveBlock,
  snapshotToPrompt, candidateInjection, mcnemarExactP, bootstrapPairedCI,
  compareArms, evaluateGate, nullFlux, familyOf,
  type ExperimentTask, type RunRecord, type TaskLesson,
} from '../three-arm.ts';

const task = (over: Partial<ExperimentTask> = {}): ExperimentTask => ({
  id: 't', prompt: 'p', tools: false, holdout: false, split: 'train', family: 'x', fileSha: '0',
  assertion: { expect: [] },
  ...over,
});

/* ---------------- judge ---------------- */

test('judge: expect-exact passes only on the exact body', () => {
  const t = task({ assertion: { expect: [], expectExact: 'HMH-OK' } });
  assert.equal(judgeOutput('HMH-OK', t).pass, true);
  assert.equal(judgeOutput('HMH-OK.', t).pass, false);
  assert.equal(judgeOutput('好的,已完成: HMH-OK', t).pass, false);
});

test('judge: fenced block inner content is the assertion body', () => {
  const t = task({ assertion: { expect: [], expectExact: 'line1\nline2' } });
  assert.equal(judgeOutput('```\nline1\nline2\n```', t).pass, true);
  assert.equal(judgeOutput('前面说明\n```\nline1\nline2\n```\n后面说明', t).pass, true);
});

test('judge: regex / none / any / all-substring modes', () => {
  assert.equal(judgeOutput('a1b2c3', task({ assertion: { expect: [], expectRegex: '^[0-9a-f]{6}$' } })).pass, true);
  assert.equal(judgeOutput('A1B2C3', task({ assertion: { expect: [], expectRegex: '^[0-9a-f]{6}$' } })).pass, false);
  const none = task({ assertion: { expect: [], expectNone: ['error', 'failed'] } });
  assert.equal(judgeOutput('IDLE', none).pass, true);
  assert.equal(judgeOutput('IDLE failed', none).pass, false);
  const any = task({ assertion: { expect: [], expectAny: ['GO', 'NO-GO'] } });
  assert.equal(judgeOutput('GO', any).pass, true);
  assert.equal(judgeOutput('MAYBE', any).pass, false);
  const all = task({ assertion: { expect: ['refuse', 'deny'] } });
  assert.equal(judgeOutput('I refuse and deny', all).pass, true);
  assert.equal(judgeOutput('I refuse', all).pass, false);
});

test('judge: falseCompletion flagged only on failed asserts carrying done-markers', () => {
  const t = task({ assertion: { expect: [], expectExact: 'X' } });
  assert.equal(judgeOutput('已完成', t).falseCompletion, true);
  assert.equal(judgeOutput('done', t).falseCompletion, true);
  assert.equal(judgeOutput('abc', t).falseCompletion, false);
  assert.equal(judgeOutput('X', t).falseCompletion, false); // passed — not false completion
});

test('judge: empty output fails closed', () => {
  assert.equal(judgeOutput('', task({ assertion: { expect: [], expectExact: 'X' } })).pass, false);
});

/* ---------------- selection + hash ---------------- */

test('selectTasks: deterministic, quota-respecting, holdout separated', () => {
  const mk = (id: string, holdout = false): { id: string; holdout: boolean; tools: boolean } => ({ id, holdout, tools: false });
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => mk(`adv-${i + 1}`)),
    ...Array.from({ length: 22 }, (_, i) => mk(`beh-${i + 1}`)),
    ...Array.from({ length: 5 }, (_, i) => mk(`behave-echo-${i + 1}`)),
    ...Array.from({ length: 4 }, (_, i) => mk(`hmb-canary-${i + 1}`, true)),
    mk('toolchain-report'),
  ];
  const a = selectTasks(pool, 7);
  const b = selectTasks(pool, 7);
  assert.deepEqual(a, b); // deterministic
  assert.equal(a.train.filter((id) => familyOf(id) === 'beh').length, 8);
  assert.equal(a.train.filter((id) => familyOf(id) === 'adv').length, 6);
  assert.deepEqual(a.protect, ['hmb-canary-1', 'hmb-canary-2', 'hmb-canary-3', 'hmb-canary-4']);
  assert.ok(a.excluded.some((e) => e.id.startsWith('toolchain')));
  // behave-* folds into the beh family quota
  const behFamily = a.train.filter((id) => id.startsWith('behave-')).length;
  assert.ok(behFamily <= 8);
});

test('buildTaskSetHash: content-sensitive to every assertion mode', () => {
  const t1 = [task({ id: 'a', assertion: { expect: ['x'] } })];
  const t2 = [task({ id: 'a', assertion: { expect: ['x'], expectNone: ['y'] } })];
  assert.notEqual(buildTaskSetHash(t1).datasetHash, buildTaskSetHash(t2).datasetHash);
  assert.equal(buildTaskSetHash(t1).datasetHash, buildTaskSetHash([task({ id: 'a', assertion: { expect: ['x'] } })]).datasetHash);
});

/* ---------------- injections ---------------- */

test('snapshot and candidate injections match evolve.ts shapes', () => {
  const snap = [{ name: 's1', description: 'd1' }];
  assert.equal(snapshotToPrompt(snap), '- s1: d1');
  const inj = candidateInjection(snap, 'cand', 'BODY');
  assert.ok(inj.includes('- s1: d1'));
  assert.ok(inj.includes('## Draft skill under evaluation: cand'));
  assert.ok(inj.includes('BODY'));
  // 4000-char truncation, same as the real gate
  const long = candidateInjection([], 'c', 'x'.repeat(5000));
  assert.ok(!long.includes('x'.repeat(4100)));
});

test('adaptive block: max 3 lessons, empty when none', () => {
  const lessons: TaskLesson[] = Array.from({ length: 5 }, (_, i) => ({
    taskId: `t-${i}`, promptHead: 'p', failedOutputHead: 'o', failureDetail: 'exact mismatch',
  }));
  const block = buildAdaptiveBlock('cjk', lessons);
  assert.match(block, /family: cjk/);
  assert.equal((block.match(/^(\d+)\./gm) ?? []).length, 3);
  assert.equal(buildAdaptiveBlock('cjk', []), '');
});

/* ---------------- statistics ---------------- */

test('mcnemarExactP: known exact values', () => {
  assert.equal(mcnemarExactP(0, 0).p, 1);
  const all = mcnemarExactP(8, 0);
  assert.ok(Math.abs(all.p - 2 / 256) < 2e-6); // two-sided 2*0.5^8 (within toFixed(6) rounding)
  const balanced = mcnemarExactP(4, 4);
  assert.equal(balanced.p, 1);
});

test('bootstrapPairedCI: deterministic, all-positive diffs exclude 0', () => {
  const ci1 = bootstrapPairedCI([1, 1, 1, 0.5, 0.5], { seed: 1 });
  const ci2 = bootstrapPairedCI([1, 1, 1, 0.5, 0.5], { seed: 1 });
  assert.deepEqual(ci1, ci2);
  assert.ok(ci1.ciLo > 0);
  // FIXED balanced fixture: the old Math.random() draws were unseeded, so a
  // lopsided sample occasionally pushed the bootstrap CI off 0 — the test
  // titled "deterministic" was flaky by construction (CI false-red 2026-10-28)
  const mixedDiffs = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1));
  const mixed = bootstrapPairedCI(mixedDiffs, { seed: 1 });
  assert.ok(mixed.ciLo < 0 && mixed.ciHi > 0);
});

function rec(arm: 'A' | 'B' | 'C', seed: number, taskId: string, success: boolean, split: 'train' | 'protect' = 'train'): RunRecord {
  return {
    experimentId: 'x', repoCommit: 'c', datasetHash: 'h',
    baseModel: { provider: 'p', id: 'm', sampling: 'default' },
    arm, seed, taskId, holdoutClass: split,
    outcome: { success, environmentDeltaHash: 'd' },
    metrics: { cost: { promptTokens: 10, completionTokens: 5, totalTokens: 15, usd: null }, wallMs: 1, toolCalls: 0, recoveries: 0, crashes: 0, falseCompletion: 0, predictedP: null, brier: null },
    safety: { backend: 'b', isolationLevel: 'i' }, decision: 'measured', reason: '',
  };
}

test('compareArms: paired discipline, rates, and significance on clean wins', () => {
  const records: RunRecord[] = [];
  for (let s = 1; s <= 3; s++) {
    for (let t = 1; t <= 20; t++) {
      // C-only wins t=1..12 and t=20 (13 cells), A-only t=13, ties t=14..19
      const cWins = t === 13 ? false : true;
      const aWins = t === 13 ? true : t >= 14 && t <= 19;
      records.push(rec('C', s, `t${t}`, cWins));
      records.push(rec('A', s, `t${t}`, aWins));
    }
  }
  const cmp = compareArms(records, 'C', 'A', 'train');
  assert.equal(cmp.armX, 'C');
  assert.equal(cmp.rateX > cmp.rateY, true);
  assert.equal(cmp.significant, true);
  assert.equal(cmp.mcnemarPerSeed[0]!.xOnly, 13);
  assert.equal(cmp.mcnemarPerSeed[0]!.yOnly, 1);
});

test('compareArms: low support flags NEEDS-DATA inputs', () => {
  const records: RunRecord[] = [];
  for (let s = 1; s <= 3; s++) records.push(rec('C', s, 'only', true), rec('A', s, 'only', false));
  const cmp = compareArms(records, 'C', 'A', 'train');
  assert.ok(cmp.needsData.length >= 1);
});

test('evaluateGate: verdicts follow the pre-registered bars', () => {
  const ok = { needsData: [], significant: true, diff: 0.1, bootstrap: { ciLo: 0.02, ciHi: 0.18 }, mcnemarPerSeed: [{ p: 0.01 }] } as never;
  assert.equal(evaluateGate(ok, 0.05, 0.02).verdict, 'PROMOTE');
  // protect fallback beyond 3pp rejects even with significance
  assert.equal(evaluateGate(ok, -0.05, 0.02).verdict, 'REJECT');
  // cost growth beyond 10% rejects
  assert.equal(evaluateGate(ok, 0.05, 0.15).verdict, 'REJECT');
  // no significance rejects
  const notsig = { needsData: [], significant: false, diff: 0.0, bootstrap: { ciLo: -0.1, ciHi: 0.1 }, mcnemarPerSeed: [{ p: 0.5 }] } as never;
  assert.equal(evaluateGate(notsig, 0.0, 0.0).verdict, 'REJECT');
  // low support -> NEEDS-DATA regardless
  const low = { needsData: ['only 3 paired tasks'], significant: true, diff: 0.5, bootstrap: { ciLo: 0.1, ciHi: 0.9 }, mcnemarPerSeed: [{ p: 0.001 }] } as never;
  assert.equal(evaluateGate(low, 0.1, 0.0).verdict, 'NEEDS-DATA');
});

test('nullFlux: flips counted across seeds', () => {
  const records = [
    rec('A', 1, 'stable', true), rec('A', 2, 'stable', true), rec('A', 3, 'stable', true),
    rec('A', 1, 'flippy', true), rec('A', 2, 'flippy', false), rec('A', 3, 'flippy', true),
  ];
  const flux = nullFlux(records, 'train');
  assert.equal(flux.tasks, 2);
  assert.deepEqual(flux.flippedTaskIds, ['flippy']);
  assert.equal(flux.flipRate, 0.5);
});
