import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minePreconditions,
  preconditionsFromMined,
  hasContextSignal,
  selectByPreconditionStability,
  compileSkillWithPreconditions,
  triggerMatchScore,
  parseStructuredCheck,
  mineWorkflows,
  toSkillSpecV2,
  type CognitiveTrajectory,
} from '../index.ts';
import { TrajectoryRecorder } from '../index.ts';

/* P1-2 helpers: trajectories with a goal text so goal-keyword mining has
 * material, and action types we control. */
function traj(id: string, types: string[], success: boolean, goal: string, prefix: string[] = []): CognitiveTrajectory {
  const rec = new TrajectoryRecorder(id, id, { id: 'terminal', version: '1' }, { id: 'g', description: goal });
  [...prefix, ...types].forEach((t, i, arr) => {
    rec.record({ action: { id: `a${i}`, type: t, args: {}, reason: 'r' }, outcome: i === arr.length - 1 && !success ? 'failure' : 'success', evidence: [], durationMs: 1 });
  });
  return rec.finish(success);
}

const CAND = { steps: ['read_file', 'edit_file'], support: 4, trajectoryIds: ['t1', 't2', 't3', 't4'], environmentId: 'terminal' };

test('precond: preceding types mined with coverage, threshold and cap enforced', () => {
  // 4 support trajectories: read_file precedes in 3/4 (0.75 >= 0.6 kept),
  // list_dir in 2/4 (0.5 dropped), see_image in 1/4 (dropped)
  const train = [
    traj('t1', CAND.steps, true, 'g1', ['read_file', 'list_dir']),
    traj('t2', CAND.steps, true, 'g2', ['read_file', 'see_image']),
    traj('t3', CAND.steps, true, 'g3', ['read_file', 'list_dir']),
    traj('t4', CAND.steps, true, 'g4', ['write_file']),
  ];
  const mined = minePreconditions(CAND, train);
  assert.equal(mined.supportUsed, 4);
  assert.deepEqual(mined.preceding, [{ type: 'read_file', coverage: 0.75 }]);
  assert.equal(hasContextSignal(mined), true);
});

test('precond: position band only when supportUsed >= 4; nearest-rank quantiles', () => {
  const mk = (n: number, id: string) => traj(id, [...Array.from({ length: n }, () => `pad${id}`), ...CAND.steps], true, 'g');
  // n distinct prefix tokens, then the gram: ratios are n/(n+2) = 1/3, 0.5, 2/3, 9/11
  const train = [mk(1, 't1'), mk(2, 't2'), mk(4, 't3'), mk(9, 't4')];
  const cand = { ...CAND, steps: ['read_file', 'edit_file'] };
  const mined = minePreconditions(cand, train);
  assert.ok(mined.positionBand, '4 support -> band present');
  const ratios = [1 / 3, 0.5, 2 / 3, 9 / 11].sort((a, b) => a - b);
  assert.equal(mined.positionBand.p10, Number(ratios[0]!.toFixed(2)));
  assert.equal(mined.positionBand.p90, Number(ratios[3]!.toFixed(2)));
  const small = minePreconditions(cand, [train[0]!, train[1]!]);
  assert.equal(small.positionBand, undefined, 'supportUsed < 4 -> no band (stated, not faked)');
});

test('precond: goal keywords shared across support, tokenized identically', () => {
  const train = [
    traj('t1', CAND.steps, true, 'bump the package version'),
    traj('t2', CAND.steps, true, 'Bump the PACKAGE version'),
    traj('t3', CAND.steps, true, 'bump version now'),
    traj('t4', CAND.steps, true, 'something else entirely'),
  ];
  const mined = minePreconditions(CAND, train);
  const words = mined.goalKeywords.map((g) => g.word);
  assert.ok(words.includes('bump') && words.includes('version'), `got ${words.join(',')}`);
  assert.ok(mined.goalKeywords.every((g) => g.coverage === 0.75));
  assert.ok(!words.includes('package'), 'package appears in 2/4 = 0.5 < 0.6 -> dropped');
});

test('precond: check grammar round-trips through the parser', () => {
  const train = [
    traj('t1', CAND.steps, true, 'bump version', ['read_file']),
    traj('t2', CAND.steps, true, 'bump version', ['read_file']),
    traj('t3', CAND.steps, true, 'bump version', ['read_file']),
    traj('t4', CAND.steps, true, 'bump version', ['read_file']),
  ];
  const conds = preconditionsFromMined(minePreconditions(CAND, train));
  const checks = conds.map((c) => c.check);
  assert.ok(checks.includes('ctx:preceding:read_file'));
  assert.ok(checks.some((c) => c.startsWith('ctx:position:')));
  assert.ok(checks.includes('ctx:goal:bump') && checks.includes('ctx:goal:version'));
  for (const c of checks) assert.ok(parseStructuredCheck(c), `unparseable: ${c}`);
  assert.equal(parseStructuredCheck('env:id=terminal'), undefined, 'unknown grammar -> undefined, never guessed');
});

test('precond: triggerMatchScore anchor semantics (contained / first-step / absent)', () => {
  const train = [
    traj('t1', CAND.steps, true, 'bump version', ['read_file']),
    traj('t2', CAND.steps, true, 'bump version', ['read_file']),
    traj('t3', CAND.steps, true, 'bump version', ['read_file']),
    traj('t4', CAND.steps, true, 'bump version', ['read_file']),
  ];
  const skill = compileSkillWithPreconditions(CAND, train);
  // contained with a read_file prefix: all checks satisfiable
  const full = traj('h1', ['read_file', 'read_file', 'edit_file'], true, 'please bump the version');
  const r1 = triggerMatchScore(skill, full);
  assert.equal(r1.vacuous, false);
  assert.equal(r1.matched, true);
  assert.equal(r1.satisfied, r1.total);
  assert.equal(r1.anchor, 1);
  // gram present but NO prefix: 2/4 satisfied (both goals) -> score 0.5 which
  // IS the frozen tau (simple-majority firing) — matched stays true, context checks fail
  const bare = traj('h2', CAND.steps, true, 'bump version');
  const r2 = triggerMatchScore(skill, bare);
  assert.equal(r2.anchor, 0);
  assert.equal(r2.satisfied, 2);
  assert.equal(r2.score, 0.5);
  assert.equal(r2.matched, true, 'tau=0.5 simple majority: goal-only still fires (frozen rule)');
  // wrong context AND wrong goal: 0/4 -> refused
  const wrong = traj('h2b', CAND.steps, true, 'deploy the cluster');
  assert.equal(triggerMatchScore(skill, wrong).matched, false);
  // gram absent but first step present later: anchor falls back to first occurrence
  const late = traj('h3', ['write_file', 'write_file', 'read_file', 'run_command'], true, 'bump version');
  const r3 = triggerMatchScore(skill, late);
  assert.equal(r3.anchor, 2);
  // gram and first step both absent: preceding/position unsatisfiable, goal live
  const none = traj('h4', ['write_file', 'run_command'], true, 'bump version');
  const r4 = triggerMatchScore(skill, none);
  assert.equal(r4.anchor, -1);
  assert.equal(r4.matched, true, 'anchor -1 still fires on goal majority (2/4 = tau)');
  // env mismatch => score 0 outright (frozen rule)
  const otherEnv: CognitiveTrajectory = { ...traj('h5', CAND.steps, true, 'bump version'), environment: { id: 'browser', version: '1' } };
  assert.equal(triggerMatchScore(skill, otherEnv).score, 0);
});

test('precond: vacuous skill scores 1 and flags vacuous (empty is stated, never faked)', () => {
  const skill = toSkillSpecV2(CAND); // 现状: preconditions [] unconditionally
  const r = triggerMatchScore(skill, traj('h1', CAND.steps, true, 'anything'));
  assert.equal(r.vacuous, true);
  assert.equal(r.score, 1);
  assert.equal(r.total, 0);
});

test('precond: arm-B selection gate — first signal carrier in arm-A order, degenerate fallback', () => {
  // two candidates in arm-A order (longer first); the LONGER one has no
  // stable context (different prefix each time), the shorter one does
  const longCand = { steps: ['list_dir', 'read_file', 'edit_file', 'run_command'], support: 2, trajectoryIds: ['l1', 'l2'], environmentId: 'terminal' };
  const shortCand = { steps: CAND.steps, support: 3, trajectoryIds: ['s1', 's2', 's3'], environmentId: 'terminal' };
  const train = [
    traj('l1', longCand.steps, true, 'alpha', ['see_image']),
    traj('l2', longCand.steps, true, 'beta', ['run_command']),
    traj('s1', shortCand.steps, true, 'bump version', ['read_file']),
    traj('s2', shortCand.steps, true, 'bump version', ['read_file']),
    traj('s3', shortCand.steps, true, 'bump version', ['read_file']),
  ];
  const sel = selectByPreconditionStability([longCand, shortCand], train);
  assert.equal(sel.selected, shortCand, 'signal gate skips the context-less longer candidate');
  assert.deepEqual(sel.signalPool, [shortCand]);
  const none = selectByPreconditionStability([longCand], train);
  assert.equal(none.degenerate, true);
  assert.equal(none.selected, longCand, 'degenerate => B falls back to arm-A pick, recorded');
});

test('precond: end-to-end — mined skill fires on an unseen shape the strict trigger missed', () => {
  // train: the workflow always starts tasks right after reading a file, goal
  // always mentions bump+version
  const trainTypes = ['run_command', 'edit_file', 'run_command'];
  const train = ['t1', 't2', 't3'].map((id, i) =>
    traj(id, trainTypes, true, `bump package version ${i}`, i === 0 ? ['read_file'] : i === 1 ? ['read_file', 'read_file'] : ['list_dir', 'read_file']));
  const flows = mineWorkflows(train, { minSupport: 3, nMin: 2, nMax: 4 });
  assert.ok(flows.length >= 1);
  const sel = selectByPreconditionStability(flows, train);
  const skill = compileSkillWithPreconditions(sel.selected!, train);
  assert.ok(skill.preconditions.length > 0, 'preconditions actually filled (the现状 gap repaired)');
  // unseen: same context shape, workflow intact — B's trigger fires
  const unseen = traj('h1', ['read_file', ...trainTypes], true, 'bump the app version');
  const r = triggerMatchScore(skill, unseen);
  assert.equal(r.matched, true);
  // unseen, wrong context: no read before the run, unrelated goal — B refuses
  const wrongCtx = traj('h2', trainTypes, true, 'deploy the cluster');
  assert.equal(triggerMatchScore(skill, wrongCtx).matched, false);
});
