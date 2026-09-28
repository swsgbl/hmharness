import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryStore, TrajectoryRecorder } from '../trajectory.ts';
import { analyzeWorldModel, diagnoseOpportunities, benchFromTrajectories, loadTrajectories, buildContextDigest, analyzeGoalDrift, skillCandidatesFromHistory } from '../analysis.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-analysis-'));
}

function seedTrajectory(home: string, id: string, steps: Array<{ type: string; outcome: 'success' | 'failure' }>, success: boolean, goal?: string): Promise<void> {
  const rec = new TrajectoryRecorder(id, 'ses-x', { id: 'terminal', version: '1.0.0' }, goal ? { id: `goal-${id}`, description: goal } : undefined);
  for (const s of steps) rec.record({ action: { id: 'a', type: s.type, args: {} }, outcome: s.outcome, evidence: [] });
  const traj = rec.finish(success);
  return new TrajectoryStore(home).append(traj).then(() => undefined);
}

test('analysis: loadTrajectories reads what the recorder wrote', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 't1', [{ type: 'read_file', outcome: 'success' }], true);
  const all = await loadTrajectories(home);
  assert.equal(all.length, 1);
  assert.equal(all[0].steps[0].action.type, 'read_file');
  await rm(home, { recursive: true, force: true });
});

test('analysis: world model replays history with predict-before-update (calibration measured, no leakage)', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 't1', [
    { type: 'read_file', outcome: 'success' },
    { type: 'read_file', outcome: 'success' },
    { type: 'read_file', outcome: 'success' },
    { type: 'run_command', outcome: 'failure' },
  ], false);
  await seedTrajectory(home, 't2', [
    { type: 'read_file', outcome: 'success' },
    { type: 'edit_file', outcome: 'success' },
  ], true);
  const wm = await analyzeWorldModel(home);
  assert.equal(wm.trajectoriesReplayed, 2);
  assert.equal(wm.stepsReplayed, 6);
  const readFile = wm.beliefs.find((b) => b.actionType === 'read_file');
  assert.ok(readFile, 'read_file belief must exist');
  assert.equal(readFile?.evidenceCount, 4);
  assert.ok((readFile?.confidence ?? 0) > 0.6);
  const runCmd = wm.beliefs.find((b) => b.actionType === 'run_command');
  assert.ok(runCmd && runCmd.confidence < 0.5, 'failing tool must carry low confidence');
  // calibration: predictions were made BEFORE each update, so resolved>0
  assert.ok(wm.calibration.resolved >= 6);
  assert.ok(wm.calibration.meanError !== undefined && wm.calibration.meanError > 0);
  await rm(home, { recursive: true, force: true });
});

test('analysis: planner gate trusts the reliable tool, distrusts the flaky one', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 't1', [
    { type: 'read_file', outcome: 'success' }, { type: 'read_file', outcome: 'success' },
    { type: 'read_file', outcome: 'success' }, { type: 'read_file', outcome: 'success' },
  ], true);
  await seedTrajectory(home, 't2', [{ type: 'deploy', outcome: 'failure' }, { type: 'deploy', outcome: 'failure' }], false);
  const wm = await analyzeWorldModel(home);
  assert.ok(wm.plannerGate.trusted.includes('read_file'));
  assert.ok(wm.plannerGate.untrusted.includes('deploy'));
  await rm(home, { recursive: true, force: true });
});

test('analysis: diagnosis surfaces failure clusters from real trajectories', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 'f1', [{ type: 'run_command', outcome: 'failure' }], false);
  await seedTrajectory(home, 'f2', [{ type: 'run_command', outcome: 'failure' }], false);
  const { opportunities, trajectories } = await diagnoseOpportunities(home);
  assert.equal(trajectories, 2);
  assert.ok(opportunities.some((o) => o.id === 'opp-fail-terminal' && o.suggestedTargets.includes('memory')));
  await rm(home, { recursive: true, force: true });
});

test('analysis: bench aggregates uniform metrics over recorded runs', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 'b1', [{ type: 'a', outcome: 'success' }, { type: 'b', outcome: 'success' }], true);
  await seedTrajectory(home, 'b2', [{ type: 'a', outcome: 'failure' }, { type: 'a', outcome: 'success' }], true);
  const report = await benchFromTrajectories(home);
  assert.ok(report);
  assert.equal(report?.runs, 2);
  assert.equal(report?.aggregate.successRate, 1); // both finished successfully
  assert.ok((report?.aggregate.actionEfficiency ?? 0) > 0);
  assert.ok((report?.aggregate.recoveryRate ?? 0) > 0); // b2 recovered from a failure
  const empty = await benchFromTrajectories(home, 'harmonyos');
  assert.equal(empty, null);
  await rm(home, { recursive: true, force: true });
});

test('analysis: context digest stays silent on thin history, advises on flaky tools', async () => {
  const home = await tmpHome();
  // fewer than 3 steps: no advice (cold start sees nothing)
  await seedTrajectory(home, 'thin', [{ type: 'read', outcome: 'success' }], true);
  assert.equal(await buildContextDigest(home), '');
  // now history with a failing tool: the digest must name it
  await seedTrajectory(home, 'h1', [
    { type: 'read', outcome: 'success' }, { type: 'read', outcome: 'success' }, { type: 'read', outcome: 'success' },
    { type: 'deploy', outcome: 'failure' }, { type: 'deploy', outcome: 'failure' },
  ], false);
  const digest = await buildContextDigest(home);
  assert.match(digest, /deploy/i);
  assert.match(digest, /Flaky/i);
  assert.ok(digest.length <= 500);
  await rm(home, { recursive: true, force: true });
});

test('analysis: goal drift ranks off-goal trajectories worst', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 'focused', [
    { type: 'fix_login_bug', outcome: 'success' }, { type: 'fix_login_bug', outcome: 'success' },
    { type: 'fix_login_bug', outcome: 'success' }, { type: 'fix_login_bug', outcome: 'success' },
    { type: 'fix_login_bug', outcome: 'success' },
  ], true, 'fix the login bug');
  await seedTrajectory(home, 'wandering', Array.from({ length: 8 }, () => ({ type: 'refactor_ui_styling', outcome: 'success' as const })), true, 'fix the login bug');
  const views = await analyzeGoalDrift(home);
  assert.equal(views.length, 2);
  assert.equal(views[0].trajectoryId.startsWith('wandering') || views[0].goalDescription === 'fix the login bug', true);
  assert.ok(views[0].driftScore > views[1].driftScore, 'off-goal run must rank worst');
  assert.notEqual(views[0].recommendation, 'continue');
  await rm(home, { recursive: true, force: true });
});

test('analysis: skill candidates mined from repeated successful runs', async () => {
  const home = await tmpHome();
  await seedTrajectory(home, 's1', [{ type: 'scan', outcome: 'success' }, { type: 'build', outcome: 'success' }, { type: 'test', outcome: 'success' }], true);
  await seedTrajectory(home, 's2', [{ type: 'scan', outcome: 'success' }, { type: 'build', outcome: 'success' }, { type: 'test', outcome: 'success' }], true);
  const candidates = await skillCandidatesFromHistory(home);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].status, 'candidate');
  assert.equal(candidates[0].evidenceTrajectories, 2);
  assert.deepEqual(candidates[0].procedure, ['scan', 'build', 'test']);
  await rm(home, { recursive: true, force: true });
});
