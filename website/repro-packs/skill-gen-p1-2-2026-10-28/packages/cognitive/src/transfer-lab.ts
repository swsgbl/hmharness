/**
 * @hmharness/cognitive - transfer lab (blueprint §17 / TR-001..006)
 *
 * A CONTROLLED experiment, not a dashboard decoration: does knowledge
 * learned in a SOURCE environment measurably improve exploration in a
 * TARGET environment?
 *
 *   with-transfer arm : the exploration policy consults a world model whose
 *                       beliefs were replayed from SOURCE-env history
 *   from-scratch arm  : identical run against an empty world model
 *
 * Both arms use the SAME environment instance sequence, budgets and seeds —
 * only the belief table differs. Transfer Score = relative success gain
 * (TR-006); negative transfer (carried beliefs HURT) is a first-class
 * result and is reported, never hidden.
 *
 * Honesty rules:
 *  - source and target usually expose DIFFERENT affordances; the carried
 *    beliefs only transfer where action types overlap. The report shows the
 *    overlap so a 0-overlap pair never pretends to be a transfer test.
 *  - small N is small N: verdicts below are labelled with sample counts.
 */
import type { Environment } from './index.ts';
import { TrajectoryStore, TrajectoryRecorder, brierScore, type TrajectoryStep } from './index.ts';
import { WorldModel } from './world-model.ts';
import { ExplorationEngine, UcbExplorationPolicy, HypothesisRegistry, type ExplorationResult } from './exploration.ts';
import { loadTrajectories, replayIntoWorldModel } from './analysis.ts';
import { transferScore, transferVerdict, type TransferCell } from './benchmark.ts';
import { abstractOf, type AbstractAction } from './abstract-actions.ts';

/** belief-key mapping used by BOTH arms: '@write' when the action type has
 *  an abstract intent, the literal type otherwise. Symmetric mapping keeps
 *  the arms comparable — only the seeded KNOWLEDGE differs. */
function mappedKey(actionType: string): string {
  const a = abstractOf(actionType);
  return a ? `@${a}` : actionType;
}

export interface TransferArmResult {
  successes: number;
  runs: number;
  totalActions: number;
  details: Array<ExplorationResult>;
}

export interface TransferExperimentReport {
  sourceEnv: string;
  targetEnv: string;
  runsPerArm: number;
  actionOverlap: string[];
  withTransfer: number;
  fromScratch: number;
  score: number;
  verdict: 'positive' | 'neutral' | 'negative';
  trajectoryIds: string[];
  /** calibration: mean Brier per arm (lower = better predicted). The seeded
   *  arm should predict overlapping actions better than the empty arm even
   *  when success rates tie — that is real carried knowledge. */
  brierWith?: number;
  brierWithout?: number;
  /** positive = seeded arm better calibrated (its Brier is lower) */
  calibrationDelta?: number;
}

/** one exploration run against `env`, optionally seeded by `wm` */
async function exploreOnce(
  env: Environment,
  wm: WorldModel,
  opts: { maxActions: number; maxCost: number; rec: TrajectoryRecorder; home: string },
): Promise<ExplorationResult & { successfulActions: number }> {
  const hypotheses = new HypothesisRegistry();
  hypotheses.register({ claim: 'affordances can be exercised successfully', expectedEvidence: 'probing an action succeeds', refutingEvidence: 'probing actions fails' });
  const obs = await env.reset({});
  const engine = new ExplorationEngine(new UcbExplorationPolicy());
  const result = await engine.run({
    maxActions: opts.maxActions,
    maxCost: opts.maxCost,
    riskTolerance: 0.6,
    ctx: { observation: obs, worldModel: wm, hypotheses },
    act: async (action) => {
      // translate to the abstract key layer so source-env beliefs can hit
      const keyAction = { ...action, type: mappedKey(action.type) };
      const prediction = wm.predict({ action: keyAction });
      const r = await env.act(action);
      const after = await env.observe().catch(() => obs);
      wm.update({
        stateBefore: wm.worldState,
        action: keyAction,
        observation: after,
        outcome: r.outcome === 'success' ? 'success' : r.outcome === 'failure' ? 'failure' : 'unknown',
        predictionId: prediction.id,
      });
      opts.rec.record({ action, outcome: r.outcome, evidence: [`transfer:${action.type}`], prediction: { claim: prediction.claim, confidence: prediction.confidence } });
      return { outcome: r.outcome };
    },
  });
  const successfulActions = engine.outcomeLog.filter((o) => o.result.outcome === 'success').length;
  return { ...result, successfulActions };
}

async function runArm(
  home: string,
  makeEnv: () => Environment,
  wmSeed: WorldModel | null,
  runs: number,
  maxActions: number,
  envId: string,
  armLabel: string,
): Promise<TransferArmResult & { wm: WorldModel; successfulActions: number; meanBrier: number | undefined }> {
  const store = home === 'NOREC' ? null : new TrajectoryStore(home);
  const details: ExplorationResult[] = [];
  let successfulActions = 0;
  let totalActions = 0;
  const allSteps: TrajectoryStep[] = [];
  const wm = wmSeed ?? new WorldModel(envId);
  // each run gets a FRESH environment (no cross-run state leakage) but the
  // SAME world model — that is the "carried knowledge" being measured
  for (let i = 0; i < runs; i++) {
    const env = makeEnv();
    const rec = new TrajectoryRecorder(`trj-transfer-${armLabel}-${Date.now().toString(36)}-${i}`, `transfer-${armLabel}`, { id: envId, version: '1' });
    const result = await exploreOnce(env, wm, { maxActions, maxCost: maxActions * 4, rec, home });
    details.push(result);
    totalActions += result.actionsTaken;
    successfulActions += result.successfulActions;
    const traj = rec.finish(result.actionsTaken > 0);
    allSteps.push(...traj.steps);
    await store?.append(traj).catch(() => undefined);
    await env.close().catch(() => undefined);
  }
  return { successes: successfulActions, runs, totalActions, details, wm, successfulActions, meanBrier: brierScore(allSteps) };
}

export async function runTransferExperiment(
  home: string,
  opts: {
    sourceEnv: string;
    targetEnv: string;
    makeTargetEnv: () => Environment;
    runsPerArm?: number;
    maxActions?: number;
    /** skip persisting arm trajectories (pure experiment) */
    record?: boolean;
  },
): Promise<TransferExperimentReport> {
  const runsPerArm = Math.min(Math.max(opts.runsPerArm ?? 3, 1), 10);
  const maxActions = Math.min(Math.max(opts.maxActions ?? 4, 1), 10);
  const home2 = opts.record === false ? 'NOREC' : home;
  // seed: replay SOURCE-env history, then REKEY beliefs onto the abstract
  // action layer (@write/@run/...) so knowledge crosses environment borders
  const history = await loadTrajectories(home);
  const literal = replayIntoWorldModel(history, opts.sourceEnv);
  const seeded = new WorldModel(opts.targetEnv);
  const byAbstract = new Map<AbstractAction | string, { conf: number; n: number }>();
  for (const b of literal.worldState.beliefs) {
    if (!b.id.startsWith('act:')) continue;
    const key = mappedKey(b.id.slice(4));
    const prev = byAbstract.get(key) ?? { conf: 0, n: 0 };
    const total = prev.n + b.evidenceCount;
    byAbstract.set(key, { conf: (prev.conf * prev.n + b.confidence * b.evidenceCount) / Math.max(1, total), n: total });
  }
  for (const [key, v] of byAbstract) {
    for (let i = 0; i < v.n; i++) {
      seeded.update({
        stateBefore: seeded.worldState,
        action: { id: `seed-${key}-${i}`, type: key, args: {} },
        observation: { environmentId: opts.targetEnv, timestamp: new Date().toISOString(), state: null, availableActions: [] },
        outcome: v.conf >= 0.5 ? 'success' : 'failure',
      });
    }
  }
  // abstract overlap: target affordances whose intent has seeded knowledge
  const probeEnv = opts.makeTargetEnv();
  const probeObs = await probeEnv.reset({});
  await probeEnv.close().catch(() => undefined);
  const seededKeys = new Set(byAbstract.keys());
  const overlap = [...new Set(probeObs.availableActions.map((a) => mappedKey(a.type)).filter((k) => seededKeys.has(k)))];

  const withArm = await runArm(home2, opts.makeTargetEnv, seeded, runsPerArm, maxActions, opts.targetEnv, 'with');
  const withoutArm = await runArm(home2, opts.makeTargetEnv, null, runsPerArm, maxActions, opts.targetEnv, 'without');

  // ACTION-LEVEL success rate: the seeded arm should spend its budget on
  // affordances it already believes in — wasted probes on failing actions
  // are exactly what carried knowledge should prevent
  const withRate = withArm.totalActions ? withArm.successfulActions / withArm.totalActions : 0;
  const withoutRate = withoutArm.totalActions ? withoutArm.successfulActions / withoutArm.totalActions : 0;
  const cell: TransferCell = {
    sourceEnv: opts.sourceEnv,
    targetEnv: opts.targetEnv,
    withTransfer: Number(withRate.toFixed(4)),
    fromScratch: Number(withoutRate.toFixed(4)),
    samplesWith: withArm.totalActions,
    samplesWithout: withoutArm.totalActions,
  };
  const report: TransferExperimentReport = {
    sourceEnv: opts.sourceEnv,
    targetEnv: opts.targetEnv,
    runsPerArm,
    actionOverlap: overlap,
    withTransfer: Number(cell.withTransfer.toFixed(3)),
    fromScratch: Number(cell.fromScratch.toFixed(3)),
    score: transferScore(cell),
    verdict: transferVerdict(cell),
    trajectoryIds: [],
    brierWith: withArm.meanBrier,
    brierWithout: withoutArm.meanBrier,
    calibrationDelta:
      withArm.meanBrier !== undefined && withoutArm.meanBrier !== undefined
        ? Number((withoutArm.meanBrier - withArm.meanBrier).toFixed(4))
        : undefined,
  };
  // experiments persist (RD-009 matrix data source) — best-effort, never blocks
  if (opts.record !== false) {
    try {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const { join: j } = await import('node:path');
      const dir = j(home, 'cognitive');
      await mkdir(dir, { recursive: true });
      await appendFile(j(dir, 'transfer.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...report }) + '\n', 'utf8');
    } catch { /* persistence is best-effort */ }
  }
  return report;
}
