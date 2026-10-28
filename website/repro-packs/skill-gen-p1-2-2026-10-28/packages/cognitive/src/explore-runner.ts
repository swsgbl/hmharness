/**
 * @hmharness/cognitive - exploration runner (blueprint M4 / EXP-001..009)
 *
 * The live entry point for the Exploration Engine: run a budgeted
 * uncertainty-seeking session against a real environment, seeded from the
 * world model built so far, and land the outcome as a cognitive trajectory
 * + episodic index entry — exploration feeds the same flywheel as tasks do.
 *
 * Loop per action: policy selects (uncertainty x info-gain x goal-relevance
 * - risk, under budget) -> env.act -> world-model predict-then-update ->
 * trajectory step. Unknown affordances get probed first (that is the point).
 */
import type { Environment, CognitiveTrajectory } from './index.ts';
import { TrajectoryStore, TrajectoryRecorder, MemoryEnvironment } from './index.ts';
import { WorldModel } from './world-model.ts';
import { ExplorationEngine, UcbExplorationPolicy, HypothesisRegistry, type ExplorationResult } from './exploration.ts';
import { loadTrajectories, replayIntoWorldModel } from './analysis.ts';
import { CognitiveMemory } from './memory.ts';

export interface ExploreOptions {
  environmentId?: string;
  maxActions?: number;
  maxCost?: number;
  riskTolerance?: number;
  goalKeywords?: string[];
  /** the concrete environment to explore (host wires the adapter) */
  env?: Environment;
  /** calibration-targeting weight (0 disables; default 0.2) */
  calibrationWeight?: number;
}

export interface ExploreSummary {
  result: ExplorationResult;
  trajectoryId: string;
  hypotheses: Array<{ claim: string; status: string }>;
  worldModelBeliefs: Array<{ actionType: string; confidence: number; evidenceCount: number }>;
}

export async function runExploration(home: string, opts: ExploreOptions = {}): Promise<ExploreSummary> {
  const environmentId = opts.environmentId ?? 'terminal';
  const maxActions = opts.maxActions ?? 6;
  const maxCost = opts.maxCost ?? 20;
  const riskTolerance = opts.riskTolerance ?? 0.6;

  let env = opts.env;
  if (!env) {
    if (environmentId === 'memory') {
      env = new MemoryEnvironment('memory');
    } else {
      // layering: cognitive must NOT import @hmharness/environments (it
      // depends on us). The CLI/host wires the concrete environment.
      throw new Error(`environment '${environmentId}' requires opts.env — the host wires the concrete adapter (layering rule: cognitive never imports environments)`);
    }
  }

  // seed the world model from history so exploration PROBES what is unknown
  const history = await loadTrajectories(home);
  const wm = replayIntoWorldModel(history, environmentId === 'memory' ? 'memory' : environmentId);
  const hypotheses = new HypothesisRegistry();
  hypotheses.register({
    claim: 'unseen affordances can be exercised successfully',
    expectedEvidence: 'probing an unknown action succeeds',
    refutingEvidence: 'probing unknown actions fails or is denied',
  });

  const rec = new TrajectoryRecorder(`trj-explore-${Date.now().toString(36)}`, `explore-${environmentId}`, { id: env.id, version: env.version }, { id: 'goal-explore', description: 'reduce uncertainty about the environment affordances' });
  const obs = await env.reset({});

  // calibration targeting (§26 finding→product): actions the model predicts
  // POORLY get an exploration boost — prediction error is information gain
  let calibrationBias: Record<string, number> | undefined;
  try {
    const { calibrationReport } = await import('./analysis.ts');
    const cal = await calibrationReport(home);
    calibrationBias = Object.fromEntries(cal.rows.map((r) => [r.actionType, 1 - r.reliability]));
  } catch { /* bias is best-effort; plain UCB still works */ }

  const engine = new ExplorationEngine(new UcbExplorationPolicy(undefined, opts.calibrationWeight ?? 0.2));
  const result = await engine.run({
    maxActions,
    maxCost,
    riskTolerance,
    ctx: { observation: obs, worldModel: wm, hypotheses, goalKeywords: opts.goalKeywords, calibrationBias },
    act: async (action) => {
      const prediction = wm.predict({ action });
      const started = Date.now();
      const r = await env!.act(action);
      const after = await env!.observe().catch(() => obs);
      wm.update({
        stateBefore: wm.worldState,
        action,
        observation: after,
        outcome: r.outcome === 'success' ? 'success' : r.outcome === 'failure' ? 'failure' : 'unknown',
        predictionId: prediction.id,
      });
      rec.record({
        action,
        outcome: r.outcome,
        evidence: [`exploration:${action.type}`],
        prediction: { claim: prediction.claim, confidence: prediction.confidence },
        durationMs: Date.now() - started,
      });
      return { outcome: r.outcome };
    },
  });

  await env.close().catch(() => undefined);
  const traj: CognitiveTrajectory = rec.finish(result.actionsTaken > 0);
  await store0(home, traj);
  const beliefs = wm.worldState.beliefs
    .filter((b) => b.id.startsWith('act:'))
    .map((b) => ({ actionType: b.id.slice(4), confidence: b.confidence, evidenceCount: b.evidenceCount }));
  return {
    result,
    trajectoryId: traj.id,
    hypotheses: hypotheses.all().map((h) => ({ claim: h.claim, status: h.status })),
    worldModelBeliefs: beliefs,
  };
}

async function store0(home: string, traj: CognitiveTrajectory): Promise<void> {
  const store = new TrajectoryStore(home);
  await store.append(traj);
  const mem = new CognitiveMemory(home);
  await mem.load();
  await mem.write({
    layer: 'episodic',
    content: `EXPLORE ${traj.environment.id}: ${traj.metrics.actions} actions, ${traj.metrics.recoveryCount} recoveries`,
    payload: { trajectoryId: traj.id },
    source: 'exploration-run',
    provenance: `trajectory:${traj.id}`,
    confidence: 0.7,
    environment: traj.environment.id,
    session: traj.sessionId,
    tags: ['explore', traj.environment.id],
  }).catch(() => undefined);
}
