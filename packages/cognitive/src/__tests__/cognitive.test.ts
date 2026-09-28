import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateAction, validateObservation, validateTrajectory, stableHash,
  EnvironmentRegistry, MemoryEnvironment,
  TrajectoryStore, TrajectoryRecorder, brierScore, replay,
  WorldModel,
  GoalManager,
  UcbExplorationPolicy, ExplorationEngine, HypothesisRegistry, noveltyScore,
  RLMRuntime,
  CognitiveMemory,
  SkillCompiler,
  LearningController, evidenceThreshold,
  EvolutionController, detectRewardHacking,
  defineTopology, AgentTopology, ROLE_CONTRACTS,
  GeneralBench, uniformMetrics, buildTransferMatrix, transferScore,
} from '../index.ts';

function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-test-'));
}

/* ---------------- protocol ---------------- */

test('protocol: action validation catches shape errors', () => {
  assert.equal(validateAction({ id: 'a', type: 'set', args: {} }).valid, true);
  assert.equal(validateAction({ id: '', type: 'set', args: {} }).valid, false);
  assert.equal(validateAction({ id: 'a', type: 'set', args: [] }).valid, false);
});

test('protocol: observation requires availableActions array', () => {
  assert.equal(validateObservation({ environmentId: 'x', timestamp: 't', state: null, availableActions: [] }).valid, true);
  assert.equal(validateObservation({ environmentId: 'x', timestamp: 't', state: null }).valid, false);
});

test('protocol: stableHash is deterministic and key-order independent', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

test('protocol: trajectory validation enforces outcome enum + confidence range', () => {
  const ok = {
    id: 't1', sessionId: 's1', environment: { id: 'e', version: '1' },
    steps: [{ step: 1, action: { id: 'a', type: 'set', args: {} }, outcome: 'success', evidence: [], prediction: { claim: 'x', confidence: 0.7 } }],
    metrics: { success: true, actions: 1, elapsedMs: 10, recoveryCount: 0 }, startedAt: 't',
  };
  assert.equal(validateTrajectory(ok).valid, true);
  const bad = JSON.parse(JSON.stringify(ok));
  bad.steps[0].outcome = 'maybe';
  assert.equal(validateTrajectory(bad).valid, false);
  const badConf = JSON.parse(JSON.stringify(ok));
  badConf.steps[0].prediction = { claim: 'x', confidence: 1.5 };
  assert.equal(validateTrajectory(badConf).valid, false);
});

/* ---------------- registry ---------------- */

test('registry: register/list/get + duplicate rejection', () => {
  const r = new EnvironmentRegistry();
  r.register(new MemoryEnvironment('mem'));
  assert.equal(r.list().length, 1);
  assert.equal(r.get('mem')?.id, 'mem');
  assert.throws(() => r.register(new MemoryEnvironment('mem')));
});

test('registry: conformance passes for the reference environment', async () => {
  const r = new EnvironmentRegistry();
  const result = await r.conformance(new MemoryEnvironment('mem'));
  assert.deepEqual(result, { pass: true, failures: [] });
});

test('registry: conformance FAILS a broken environment (no fake adapters)', async () => {
  const r = new EnvironmentRegistry();
  const broken = new MemoryEnvironment('broken');
  const orig = broken.observe.bind(broken);
  broken.observe = async () => ({ ...orig(), availableActions: 'oops' as never });
  const result = await r.conformance(broken);
  assert.equal(result.pass, false);
});

test('registry: health flags a dead environment', async () => {
  const r = new EnvironmentRegistry();
  const dead = new MemoryEnvironment('dead');
  dead.observe = async () => { throw new Error('boom'); };
  r.register(dead);
  const h = await r.health('dead');
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /boom/);
});

/* ---------------- trajectory ---------------- */

test('trajectory: recorder counts recoveries and computes brier', () => {
  const rec = new TrajectoryRecorder('trj-1', 'ses-1', { id: 'env', version: '1' });
  rec.record({ action: { id: 'a1', type: 'x', args: {} }, outcome: 'failure', evidence: [] });
  rec.record({ action: { id: 'a2', type: 'x', args: {} }, outcome: 'success', evidence: [] }); // recovery
  rec.record({ action: { id: 'a3', type: 'x', args: {} }, outcome: 'success', evidence: [], prediction: { claim: 'will work', confidence: 0.9 } });
  const traj = rec.finish(true);
  assert.equal(traj.metrics.recoveryCount, 1);
  assert.equal(traj.steps.length, 3);
  // brier over the single prediction: (0.9-1)^2 = 0.01
  assert.equal(traj.metrics.brierScore, 0.01);
});

test('trajectory: store round-trips jsonl', async () => {
  const home = await tmpHome();
  const store = new TrajectoryStore(home);
  const rec = new TrajectoryRecorder('trj-2', 'ses-1', { id: 'env', version: '1' });
  rec.record({ action: { id: 'a', type: 'x', args: {} }, outcome: 'success', evidence: ['ev-1'] });
  const traj = rec.finish(true);
  const w = await store.append(traj);
  assert.equal(w.ok, true);
  const loaded = await store.load('trj-2');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].steps[0].evidence[0], 'ev-1');
  await rm(home, { recursive: true, force: true });
});

test('trajectory: replay detects divergence', async () => {
  const steps = [
    { step: 1, action: { id: 'a', type: 'x', args: {} }, outcome: 'success', evidence: [] },
    { step: 2, action: { id: 'b', type: 'y', args: {} }, outcome: 'success', evidence: [] },
  ];
  const r = await replay({ steps } as never, {
    act: async (a) => ({ outcome: a.type === 'x' ? 'success' : 'failure' }),
  });
  assert.equal(r.divergedAt, 2);
});

/* ---------------- world model ---------------- */

test('world model: unknown action predicts confidence 0 (allowed to not know)', () => {
  const wm = new WorldModel('env');
  const p = wm.predict({ action: { id: 'a', type: 'unseen', args: {} } });
  assert.equal(p.confidence, 0);
  assert.match(p.claim, /unknown/i);
});

test('world model: beliefs sharpen with evidence and resolve predictions', () => {
  const wm = new WorldModel('env');
  const mk = () => wm.worldState;
  for (let i = 0; i < 4; i++) {
    wm.update({ stateBefore: mk(), action: { id: `a${i}`, type: 'build', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'success' });
  }
  const belief = wm.worldState.beliefs.find((b) => b.id === 'act:build');
  assert.ok(belief);
  // EMA starts pessimistic (0.3) and converges: 4 successes reach ~0.83,
  // never jump to 1.0 — low-confidence-first is the design
  assert.ok((belief?.confidence ?? 0) >= 0.8);
  assert.equal(belief?.evidenceCount, 4);
  const p = wm.predict({ action: { id: 'a', type: 'build', args: {} } });
  assert.ok(p.confidence >= 0.8);
  wm.update({ stateBefore: mk(), action: { id: 'a', type: 'build', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'failure', predictionId: p.id });
  const explained = wm.explainPrediction(p.id);
  assert.equal(explained.actual, 'failure');
  assert.ok((explained.error ?? 0) > 0.8); // |0.825 - 0| after the failed reality check
});

test('world model: planner confidence gate splits trusted/untrusted/unknown', () => {
  const wm = new WorldModel('env');
  const mk = () => wm.worldState;
  for (let i = 0; i < 3; i++) {
    wm.update({ stateBefore: mk(), action: { id: `a${i}`, type: 'build', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'success' });
  }
  wm.update({ stateBefore: mk(), action: { id: 'b', type: 'deploy', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'failure' });
  const gate = wm.plannerConfidence(0.6);
  assert.ok(gate.trusted.includes('build'));
  assert.ok(gate.untrusted.includes('deploy'));
});

test('world model: error clustering + revision adds corrections (never rewrites)', () => {
  const wm = new WorldModel('env');
  const mk = () => wm.worldState;
  // build a false-positive cluster: model believes deploy works, it fails
  for (let i = 0; i < 4; i++) wm.update({ stateBefore: mk(), action: { id: `s${i}`, type: 'noop', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'success' });
  const p = wm.predict({ action: { id: 'd', type: 'deploy', args: {} } });
  // force a confident wrong belief by faking evidence: 3 successes
  for (let i = 0; i < 3; i++) wm.update({ stateBefore: mk(), action: { id: `d${i}`, type: 'deploy', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'success' });
  wm.update({ stateBefore: mk(), action: { id: 'd9', type: 'deploy', args: {} }, observation: { environmentId: 'env', timestamp: 't', state: {}, availableActions: [] }, outcome: 'failure', predictionId: p.id });
  const clusters = wm.errorClusters();
  assert.ok(clusters.length >= 1);
  const revision = wm.revise([{ cluster: 'deploy/predicted-success-but-failed', misses: 3, total: 3, sampleErrors: [] }]);
  assert.ok(revision.rulesAdded.length >= 1);
  const belief = wm.worldState.beliefs.find((b) => b.id === 'act:deploy');
  assert.ok(belief?.corrections?.length);
});

/* ---------------- goal system ---------------- */

test('goal: intrinsic goals cannot be adopted without approval', async () => {
  const gm = new GoalManager();
  const g = gm.propose({ id: 'g1', description: 'explore the repo', source: 'intrinsic', priority: 1, constraints: [], successCriteria: [{ id: 'c1', description: 'x' }] });
  await assert.rejects(() => gm.adopt(g.id), /requires explicit approval/);
  await gm.adopt(g.id, { approved: true });
  assert.equal(gm.get(g.id)?.status, 'active');
});

test('goal: decomposition carves subgoals per criterion', async () => {
  const gm = new GoalManager();
  gm.propose({ id: 'g2', description: 'ship feature', source: 'user', priority: 2, constraints: [], successCriteria: [{ id: 'c1', description: 'tests pass' }, { id: 'c2', description: 'build ok' }] });
  const subs = await gm.decompose('g2');
  assert.equal(subs.length, 2);
  assert.equal(subs[0].parentGoalId, 'g2');
});

test('goal: drift detection flags off-goal trajectories', () => {
  const gm = new GoalManager();
  const g = { id: 'g3', description: 'fix the login bug in auth module', source: 'user' as const, priority: 1, constraints: [], successCriteria: [], status: 'active' as const, createdAt: 't' };
  const traj = Array.from({ length: 10 }, (_, i) => ({
    stateBefore: {} as never, action: { id: `a${i}`, type: 'refactor-ui', args: {}, reason: 'unrelated styling' }, observation: { environmentId: 'e', timestamp: 't', state: {}, availableActions: [] }, outcome: 'success' as const,
  }));
  const report = gm.detectDrift(g, traj, { sessionId: 's' });
  assert.ok(report.driftScore > 0.5);
  assert.notEqual(report.recommendation, 'continue');
});

test('goal: graph exposes parent-child edges', async () => {
  const gm = new GoalManager();
  gm.propose({ id: 'p', description: 'parent', source: 'user', priority: 1, constraints: [], successCriteria: [{ id: 'c', description: 'done' }] });
  await gm.decompose('p');
  const { nodes, edges } = gm.graph();
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
});

/* ---------------- exploration ---------------- */

test('exploration: novelty is 1 for unseen state, decays with history', () => {
  assert.equal(noveltyScore({ a: 1 }, []), 1);
  const seen = [{ a: 1 }, { a: 1 }];
  assert.equal(noveltyScore({ a: 1 }, seen), 0);
  assert.ok(noveltyScore({ a: 1, b: 2 }, seen) > 0);
});

test('exploration: engine respects budget and resolves hypotheses', async () => {
  const wm = new WorldModel('env');
  const env = new MemoryEnvironment('env');
  const hyp = new HypothesisRegistry();
  hyp.register({ claim: 'set succeeds', expectedEvidence: 'action set succeeds', refutingEvidence: 'action set fails' });
  const engine = new ExplorationEngine();
  const obs = await env.reset();
  const result = await engine.run({
    maxActions: 3,
    maxCost: 10,
    riskTolerance: 0.5,
    ctx: { observation: obs, worldModel: wm, hypotheses: hyp },
    act: async (a) => {
      const r = await env.act(a);
      const after = await env.observe();
      wm.update({ stateBefore: wm.worldState, action: a, observation: after, outcome: r.outcome === 'success' ? 'success' : 'failure' });
      return { outcome: r.outcome };
    },
  });
  assert.ok(result.actionsTaken >= 1);
  assert.ok(result.actionsTaken <= 3);
});

test('exploration: risky actions are skipped under low tolerance', async () => {
  const policy = new UcbExplorationPolicy();
  const risky = await policy.selectAction(
    { observation: { environmentId: 'e', timestamp: 't', state: {}, availableActions: [{ id: 'd', type: 'delete-everything', cost: 1 }] }, worldModel: new WorldModel('e'), hypotheses: new HypothesisRegistry() },
    { maxActions: 1, maxCost: 5, riskTolerance: 0.2 },
  );
  assert.equal(risky, undefined);
});

/* ---------------- RLM ---------------- */

test('rlm: eval composes workspace variables with accounting', async () => {
  const rlm = new RLMRuntime({ maxEvals: 2 });
  rlm.set('goal', 'write tests');
  rlm.set('files', ['a.ts', 'b.ts']);
  const r = await rlm.eval('return { goal: ctx.vars.goal, n: ctx.vars.files.length };');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { goal: 'write tests', n: 2 });
  await rlm.eval('return 1;');
  const exhausted = await rlm.eval('return 2;');
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.error?.code, 'E_BUDGET_EVALS');
});

test('rlm: checkpoint + restore + fork isolation', async () => {
  const rlm = new RLMRuntime();
  rlm.set('x', 1);
  const cp = rlm.checkpoint('before');
  rlm.set('x', 2);
  rlm.restore(cp);
  assert.equal(rlm.get('x'), 1);
  const child = await rlm.fork('child');
  child.set('x', 99);
  assert.equal(rlm.get('x'), 1);
  assert.equal(child.get('x'), 99);
});

test('rlm: eval cannot touch governance state', async () => {
  const rlm = new RLMRuntime();
  const r = await rlm.eval('try { ctx.meta = { hacked: true }; return "mutated"; } catch { return "blocked"; }');
  assert.equal(r.value, 'blocked');
});

test('rlm: spawn without host bridge refuses', async () => {
  const rlm = new RLMRuntime();
  await assert.rejects(() => rlm.spawn({ role: 'explorer', task: 'x' }), /no RLMHost bridge/);
});

/* ---------------- memory ---------------- */

test('memory: long-term write enforces provenance', async () => {
  const home = await tmpHome();
  const mem = new CognitiveMemory(home);
  await assert.rejects(
    () => mem.write({ layer: 'semantic', content: 'rule', source: '', provenance: '', confidence: 1, environment: 'e', session: 's' }),
    /source required/,
  );
  await rm(home, { recursive: true, force: true });
});

test('memory: contradiction detection + append-only consolidation', async () => {
  const home = await tmpHome();
  const mem = new CognitiveMemory(home);
  await mem.write({ layer: 'semantic', content: 'hdc shell accepts param -t', source: 'session', provenance: 'traj-1', confidence: 0.8, environment: 'harmonyos', session: 's1' });
  await mem.write({ layer: 'semantic', content: 'hdc shell does not accept param -t', source: 'session', provenance: 'traj-2', confidence: 0.7, environment: 'harmonyos', session: 's2' });
  const contradictions = mem.detectContradictions();
  assert.equal(contradictions.length, 1);
  // duplicate merge: same claim again
  await mem.write({ layer: 'semantic', content: 'hdc shell accepts param -t', source: 'session', provenance: 'traj-3', confidence: 0.9, environment: 'harmonyos', session: 's3' });
  const r = await mem.consolidate();
  assert.ok(r.merged >= 1);
  // append-only: superseded entry is still on disk
  await mem.load();
  assert.equal(mem.stats().semantic, 3);
  await rm(home, { recursive: true, force: true });
});

test('memory: hybrid retrieval ranks by confidence+recency', async () => {
  const home = await tmpHome();
  const mem = new CognitiveMemory(home);
  await mem.write({ layer: 'semantic', content: 'use ohpm fix for deps', source: 's', provenance: 'p', confidence: 0.9, environment: 'harmonyos', session: 's1', tags: ['deps'] });
  await mem.write({ layer: 'semantic', content: 'use ohpm fix maybe', source: 's', provenance: 'p', confidence: 0.3, environment: 'harmonyos', session: 's2', tags: ['deps'] });
  const hits = mem.retrieve({ text: 'ohpm fix', limit: 2 });
  assert.equal(hits[0].confidence, 0.9);
  await rm(home, { recursive: true, force: true });
});

/* ---------------- skill compiler ---------------- */

function mkTraj(id: string, actionTypes: string[], success: boolean) {
  const rec = new TrajectoryRecorder(id, 'ses', { id: 'env', version: '1' });
  for (const t of actionTypes) rec.record({ action: { id: 'a', type: t, args: {} }, outcome: 'success', evidence: [] });
  return rec.finish(success);
}

test('skill compiler: repeated successful runs compile to candidates', async () => {
  const sc = new SkillCompiler();
  const trajs = [
    mkTraj('t1', ['scan', 'build'], true),
    mkTraj('t2', ['scan', 'build'], true),
  ];
  const candidates = await sc.compile(trajs);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].status, 'candidate');
  assert.equal(candidates[0].procedure.length, 2);
});

test('skill compiler: promotion requires passing verification', async () => {
  const sc = new SkillCompiler();
  const trajs = [mkTraj('t1', ['scan', 'build'], true), mkTraj('t2', ['scan', 'build'], true)];
  const [cand] = await sc.compile(trajs);
  await assert.rejects(() => sc.promote(cand.id), /no passing verification on record/);
  const bench = { runSkill: async () => ({ successRate: 0.9, actionsPerSuccess: 2 }) };
  const verdict = await sc.verify(cand, bench);
  assert.equal(verdict.pass, true);
  await sc.promote(cand.id);
  assert.equal(sc.get(cand.id)?.status, 'active');
  await sc.rollback(cand.id);
  assert.equal(sc.get(cand.id)?.status, 'rolled-back');
});

test('skill compiler: failing verification blocks promotion', async () => {
  const sc = new SkillCompiler();
  const trajs = [mkTraj('t1', ['scan', 'build'], true), mkTraj('t2', ['scan', 'build'], true)];
  const [cand] = await sc.compile(trajs);
  const bench = { runSkill: async () => ({ successRate: 0.4 }) };
  const verdict = await sc.verify(cand, bench);
  assert.equal(verdict.pass, false);
  await assert.rejects(() => sc.promote(cand.id), /no passing verification/);
});

/* ---------------- continual learning ---------------- */

test('continual: evidence thresholds escalate toward model', () => {
  assert.ok(evidenceThreshold('memory') < evidenceThreshold('prompt'));
  assert.ok(evidenceThreshold('prompt') < evidenceThreshold('adapter'));
  assert.ok(evidenceThreshold('adapter') < evidenceThreshold('model'));
});

test('continual: diagnose surfaces failure and calibration opportunities', async () => {
  const lc = new LearningController();
  await lc.collect(mkTraj('f1', ['a'], false));
  await lc.collect(mkTraj('f2', ['a'], false));
  const opps = await lc.diagnose(lc.dataset());
  assert.ok(opps.some((o) => o.id.startsWith('opp-fail')));
});

test('continual: model targets refuse without a real trainer', async () => {
  const lc = new LearningController(
    { trainHarness: async (p) => ({ payload: p.payload }) },
    { evaluate: async (c) => ({ candidateId: c.id, pass: true, metrics: { holdoutSize: 100 }, holdoutSize: 100 }) },
  );
  await assert.rejects(
    () => lc.train({ opportunityId: 'o', target: 'model', payload: {}, expectedEffect: 'x', rollbackStrategy: 'y' }),
    /requires a trainer with trainModel/,
  );
});

test('continual: harness path trains, evaluates, promotes', async () => {
  const lc = new LearningController(
    { trainHarness: async (p) => ({ payload: { ...p.payload, written: true } }) },
    { evaluate: async (c) => ({ candidateId: c.id, pass: true, metrics: { holdoutSize: 30 }, holdoutSize: 30 }) },
  );
  const cand = await lc.train({ opportunityId: 'o1', target: 'memory', payload: { note: 'avoid flag X' }, expectedEffect: 'fewer failures', rollbackStrategy: 'delete the note' });
  assert.equal(cand.status, 'trained');
  const result = await lc.evaluate(cand, { trajectories: [] });
  assert.equal(result.pass, true);
  await lc.promote(cand.id);
  assert.equal(lc.candidate(cand.id)?.status, 'promoted');
});

/* ---------------- evolution 2.0 ---------------- */

function mkCandidateHome() {
  return tmpHome();
}

test('evolution2: intake rejects incomplete contracts', async () => {
  const home = await mkCandidateHome();
  const ec = new EvolutionController(home);
  assert.throws(
    () => ec.propose({
      target: 'skill', hypothesis: '', expectedEffect: { metric: 'success', op: '>=', value: 0.5, where: 'bench' },
      possibleRegression: [], evaluationDataset: 'd', holdoutDataset: 'h',
      transferTest: { sourceEnv: 'a', targetEnv: 'b' }, rollbackStrategy: 'r',
      resourceBudget: { maxWallMs: 1000, maxCostUnits: 10 }, safetyConstraints: [],
    }),
    /hypothesis required/,
  );
  await rm(home, { recursive: true, force: true });
});

test('evolution2: sequential gate needs holdout samples and significance', async () => {
  const home = await mkCandidateHome();
  const ec = new EvolutionController(home);
  const tooFew = ec.sequentialGate([{ won: 1, source: 'holdout' }]);
  assert.equal(tooFew.decision, 'continue');
  const strong = ec.sequentialGate([
    ...Array(7).fill({ won: 1, source: 'holdout' as const }),
    ...Array(2).fill({ won: 0, source: 'holdout' as const }),
  ]);
  assert.equal(strong.decision, 'promote');
  const weak = ec.sequentialGate([
    ...Array(2).fill({ won: 1, source: 'holdout' as const }),
    ...Array(7).fill({ won: 0, source: 'holdout' as const }),
  ]);
  assert.equal(weak.decision, 'reject');
  await rm(home, { recursive: true, force: true });
});

test('evolution2: train samples never decide the gate', () => {
  const ec = new EvolutionController('unused');
  const onlyTrain = ec.sequentialGate(Array(20).fill({ won: 1, source: 'train' }));
  assert.equal(onlyTrain.decision, 'continue');
});

test('evolution2: full pipeline sandbox->gate->canary->promote with audit', async () => {
  const home = await mkCandidateHome();
  const ec = new EvolutionController(home);
  const c = ec.propose({
    target: 'memory', hypothesis: 'remembering pitfall X reduces failures',
    expectedEffect: { metric: 'success', op: '>=', value: 0.6, where: 'bench' },
    possibleRegression: ['note could go stale'], evaluationDataset: 'train', holdoutDataset: 'holdout',
    transferTest: { sourceEnv: 'harmonyos', targetEnv: 'terminal' }, rollbackStrategy: 'remove the memory entry',
    resourceBudget: { maxWallMs: 60_000, maxCostUnits: 10 }, safetyConstraints: ['read-only'],
  });
  ec.markSandboxes(c.id);
  const gate = ec.sequentialGate([...Array(8).fill({ won: 1, source: 'holdout' }), { won: 0, source: 'transfer' }]);
  ec.markGated(c.id, gate);
  assert.equal(ec.get(c.id)?.status, 'gated');
  const canary = await ec.canary(c.id, { metricBefore: 0.4, metricAfter: 0.6, realTaskSuccessBefore: 0.5, realTaskSuccessAfter: 0.65 });
  assert.equal(canary.pass, true);
  await ec.promote(c.id);
  assert.equal(ec.get(c.id)?.status, 'promoted');
  const log = await ec.auditLog();
  assert.ok(log.some((l) => l.event === 'promoted'));
  await ec.rollback(c.id, 'regression in production');
  assert.equal(ec.get(c.id)?.status, 'rolled-back');
  await rm(home, { recursive: true, force: true });
});

test('evolution2: reward hacking freezes the pipeline', async () => {
  const home = await mkCandidateHome();
  const ec = new EvolutionController(home);
  const c = ec.propose({
    target: 'router', hypothesis: 'reroute improves judge score',
    expectedEffect: { metric: 'judgeScore', op: '>=', value: 0.7, where: 'bench' },
    possibleRegression: ['latency'], evaluationDataset: 'train', holdoutDataset: 'holdout',
    transferTest: { sourceEnv: 'a', targetEnv: 'b' }, rollbackStrategy: 'revert route',
    resourceBudget: { maxWallMs: 60_000, maxCostUnits: 10 }, safetyConstraints: [],
  });
  ec.markSandboxes(c.id);
  ec.markGated(c.id, { decision: 'promote', samples: 10, wins: 9, pValue: 0.01 });
  const canary = await ec.canary(c.id, { metricBefore: 0.5, metricAfter: 0.9, realTaskSuccessBefore: 0.6, realTaskSuccessAfter: 0.602 });
  assert.equal(canary.pass, false);
  assert.equal(ec.get(c.id)?.status, 'rejected');
  assert.ok(ec.get(c.id)?.flagged);
  await assert.rejects(() => ec.promote(c.id), /flagged/);
  await rm(home, { recursive: true, force: true });
});

test('evolution2: detectRewardHacking separates Goodhart from real gains', () => {
  assert.equal(detectRewardHacking({ metricBefore: 0.5, metricAfter: 0.8, realTaskSuccessBefore: 0.5, realTaskSuccessAfter: 0.7 }).hacked, false);
  assert.equal(detectRewardHacking({ metricBefore: 0.5, metricAfter: 0.8, realTaskSuccessBefore: 0.5, realTaskSuccessAfter: 0.501 }).hacked, true);
});

/* ---------------- multi-agent ---------------- */

test('multi-agent: role contracts exist for all blueprint roles', () => {
  for (const r of ['supervisor', 'explorer', 'planner', 'implementer', 'critic', 'verifier', 'researcher', 'memory-curator'] as const) {
    assert.ok(ROLE_CONTRACTS[r], `missing contract for ${r}`);
  }
});

test('multi-agent: topology runs, heartbeats, budgets, cancels downstream', async () => {
  const topo = defineTopology(
    ['planner', 'implementer', 'verifier'],
    [
      { from: 'planner', to: 'implementer', handoff: 'plan' },
      { from: 'implementer', to: 'verifier', handoff: 'changes' },
    ],
  );
  const board = {
    goalGraph: { nodes: [], edges: [] },
    worldDigest: { beliefs: [], uncertainty: {} },
    evidence: [],
    budget: { totalCostUnits: 10, spent: 0 },
    approvals: [],
    artifacts: [],
  };
  const t = new AgentTopology(topo, board);
  const [planner, implementer, verifier] = t.view();
  t.start(planner.id);
  assert.equal(t.staleAgents().length, 0); // fresh heartbeat
  t.heartbeat(planner.id);
  const spend = t.trySpend(8);
  assert.deepEqual(spend, { ok: true, spent: 8, total: 10 });
  assert.equal(t.trySpend(5).ok, false); // over budget
  t.finish(planner.id, { plan: ['a', 'b'] });
  const cancelled = t.cancel(planner.id);
  assert.ok(cancelled.includes('implementer'));
  assert.ok(cancelled.includes('verifier'));
  assert.equal(t.view().find((n) => n.id === implementer.id)?.status, 'cancelled');
  assert.equal(verifier.status, 'cancelled');
  void verifier;
});

test('multi-agent: watchdog flags stale running agents', async () => {
  const topo = defineTopology(['explorer']);
  const t = new AgentTopology(topo, { goalGraph: { nodes: [], edges: [] }, worldDigest: { beliefs: [], uncertainty: {} }, evidence: [], budget: { totalCostUnits: 1, spent: 0 }, approvals: [], artifacts: [] });
  const [n] = t.view();
  t.start(n.id);
  // fake an old heartbeat
  const stale = t.staleAgents(Date.now() + 10 * n.contract.heartbeatIntervalMs);
  assert.equal(stale.length, 1);
});

/* ---------------- benchmark + transfer ---------------- */

test('benchmark: uniform metrics + aggregate', async () => {
  const bench = new GeneralBench();
  bench.register({
    id: 'case-1', track: 'software', prompt: 'fix the test', environmentId: 'terminal',
    verify: async () => ({ pass: true }), actionBudget: 10,
  });
  const traj = mkTraj('b1', ['edit', 'test', 'test'], true);
  traj.metrics.brierScore = 0.2;
  const run = await bench.runCase('case-1', traj);
  assert.equal(run.metrics.success, 1);
  assert.equal(run.metrics.actionEfficiency, 1); // budget 10 / 3 actions, capped at 1
  const report = await bench.runTrack('software', new Map([['case-1', traj]]));
  assert.equal(report.aggregate.cases, 1);
});

test('benchmark: transfer matrix with negative-transfer verdicts', () => {
  const m = buildTransferMatrix([
    { sourceEnv: 'harmonyos', targetEnv: 'terminal', withTransfer: 0.8, fromScratch: 0.5, samplesWith: 10, samplesWithout: 10 },
    { sourceEnv: 'terminal', targetEnv: 'browser', withTransfer: 0.4, fromScratch: 0.6, samplesWith: 10, samplesWithout: 10 },
  ]);
  assert.equal(m.summary.positive, 1);
  assert.equal(m.summary.negative, 1);
  assert.ok(transferScore(m.cells[0]) > 0);
  assert.ok(transferScore(m.cells[1]) < 0);
});
