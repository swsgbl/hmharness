import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitiveRunRecorder } from '../cognitive-recorder.ts';
import { parseSkillContract, auditEvolutionOutcome, checkCanaryRewardHacking, enforceContractGate } from '@hmharness/evolution';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cogrun-'));
}

test('cognitive-run-recorder: tool calls become trajectory steps + episodic index', async () => {
  const home = await tmpHome();
  const rec = new CognitiveRunRecorder(home, 'build the module', 'ses-42', 'G:/proj');
  rec.call('fs_write', { path: 'a.ts', content: 'x'.repeat(500) });
  rec.result('fs_write', 'written', false);
  rec.call('run_cmd', { cmd: 'npm test' });
  rec.result('run_cmd', '1 failing', true);
  rec.call('run_cmd', { cmd: 'npm test' });
  rec.result('run_cmd', 'all green', false);
  const done = await rec.finish(true, { turns: 3, toolUses: 3, task: 'build the module' });
  assert.ok(done?.trajectoryId.startsWith('trj-ses-42-'));
  // trajectory file landed
  const trajText = await readFile(join(home, 'cognitive', 'trajectories', `${done.trajectoryId}.jsonl`), 'utf8');
  const traj = JSON.parse(trajText.trim());
  assert.equal(traj.steps.length, 3);
  assert.equal(traj.steps[1].outcome, 'failure');
  assert.equal(traj.steps[2].outcome, 'success');
  assert.equal(traj.metrics.recoveryCount, 1);
  assert.equal(traj.environment.id, 'terminal');
  // episodic memory index entry with full provenance
  const memText = await readFile(join(home, 'cognitive', 'memory', 'memory.jsonl'), 'utf8');
  const entry = JSON.parse(memText.trim());
  assert.equal(entry.layer, 'episodic');
  assert.equal(entry.source, 'agent-run');
  assert.match(entry.provenance, /^trajectory:/);
  assert.equal(entry.environment, 'terminal');
  assert.equal(entry.session, 'ses-42');
  await rm(home, { recursive: true, force: true });
});

test('cognitive-run-recorder: unmatched results still recorded (preflight denials visible)', async () => {
  const home = await tmpHome();
  const rec = new CognitiveRunRecorder(home, 't', 'ses-1', 'G:/p');
  rec.result('run_cmd', 'denied by approval gate', true);
  const done = await rec.finish(false, { turns: 1, toolUses: 1, task: 't' });
  const trajText = await readFile(join(home, 'cognitive', 'trajectories', `${done?.trajectoryId}.jsonl`), 'utf8');
  const traj = JSON.parse(trajText.trim());
  assert.equal(traj.steps.length, 1);
  assert.equal(traj.steps[0].outcome, 'failure');
  assert.match(traj.steps[0].action.reason, /without recorded call/);
  await rm(home, { recursive: true, force: true });
});

test('cognitive-run-recorder: storage failure never throws', async () => {
  const rec = new CognitiveRunRecorder('Z:\\definitely\\not\\a\\real\\home', 't', 'ses-1', 'G:/p');
  const done = await rec.finish(true, { turns: 1, toolUses: 0, task: 't' });
  assert.equal(done, null);
});

/* ---- evolution cognitive-audit bridge ---- */

const DECLARED = `# Skill: faster builds\nHypothesis: caching hvigor outputs cuts build time\nExpected: buildMs <= 40000\nRegression: stale cache could mask real failures\n\nbody...`;

test('cognitive-audit: contract parser accepts full declarations, rejects partial', () => {
  const c = parseSkillContract(DECLARED);
  assert.ok(c);
  assert.match(c!.hypothesis, /caching/);
  assert.match(c!.regression, /stale cache/);
  assert.equal(parseSkillContract('# no declarations here\nbody'), null);
  // Chinese colon also accepted
  const zh = parseSkillContract('Hypothesis：缓存加速构建\nRegression：可能掩盖失败');
  assert.ok(zh);
});

test('cognitive-audit: outcomes land in the immutable trail with declared flags', async () => {
  const home = await tmpHome();
  await auditEvolutionOutcome(home, {
    name: 'faster-builds', action: 'promoted', reason: 'no regression (train 90% vs 70%)',
    baseline: { passRate: 0.7 }, candidate: { passRate: 0.9 },
    holdout: { baselineRate: 0.7, candidateRate: 0.85 },
    lineage: { parentInsights: ['i1'], metaModel: 'glm-5.3', decidedAt: '2026-09-29T00:00:00Z' },
  }, DECLARED);
  await auditEvolutionOutcome(home, { name: 'mystery-skill', action: 'rejected', reason: 'bench fail' });
  const text = await readFile(join(home, 'cognitive', 'evolution', 'audit.jsonl'), 'utf8');
  const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'promoted');
  assert.equal(events[0].detail.declared, true);
  assert.match(events[0].hypothesis, /caching/);
  assert.equal(events[1].detail.declared, false);
  assert.equal(events[1].event, 'rejected');
  await rm(home, { recursive: true, force: true });
});

test('cognitive-audit: canary reward-hacking check mirrors EV-012', () => {
  const clean = checkCanaryRewardHacking({ benchPassRateBefore: 0.5, benchPassRateAfter: 0.7, realTaskSuccessBefore: 0.5, realTaskSuccessAfter: 0.65 });
  assert.equal(clean.hacked, false);
  const hacked = checkCanaryRewardHacking({ benchPassRateBefore: 0.5, benchPassRateAfter: 0.8, realTaskSuccessBefore: 0.6, realTaskSuccessAfter: 0.601 });
  assert.equal(hacked.hacked, true);
});

test('cognitive-audit: strict contract gate rejects undeclared drafts only in strict mode', async () => {
  const home = await tmpHome();
  const lenient = await enforceContractGate(home, 's1', '# undeclared', false);
  assert.equal(lenient.pass, true);
  const strictUndeclared = await enforceContractGate(home, 's2', '# undeclared', true);
  assert.equal(strictUndeclared.pass, false);
  const audit = await readFile(join(home, 'cognitive', 'evolution', 'audit.jsonl'), 'utf8');
  assert.match(audit, /contract gate/);
  const strictDeclared = await enforceContractGate(home, 's3', DECLARED, true);
  assert.equal(strictDeclared.pass, true);
  await rm(home, { recursive: true, force: true });
});
