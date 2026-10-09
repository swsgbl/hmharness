/**
 * Prediction-to-Action v2 (v33 pack P1 v0.24): the three-arm instrument now
 * reports TASK-LEVEL outcomes alongside calibration, per the audit's demand
 * that calibration gains and task performance be reported SEPARATELY.
 *
 * The v0.23.30 instrument showed the learned WM's gate discriminates doomed
 * from fine actions (the PLANNER would change its choices). This extension
 * asks the next question: on holdout TRAJECTORIES, does gating low-confidence
 * actions (defer/verify) correlate with better task outcomes? We measure:
 *
 *   For each holdout trajectory, the share of steps the arm would have
 *   GATED (confidence < threshold). Then compare: trajectories where the
 *   learned-WM gate flags MORE steps vs fewer - do the "more flagged"
 *   trajectories have worse outcomes? If yes, the gate identifies
 *   AT-RISK trajectories, not just at-risk steps.
 *
 * This is still observational (we don't re-run tasks with a live gate),
 * but it connects prediction quality to task-level outcomes - the bridge
 * the audit demands. A full interventional test (actually re-running tasks
 * with the gate live) requires the runtime experiment that v0.24 specifies.
 */
import {
  loadTrajectories,
  WorldModel,
  replayIntoWorldModel,
  type CognitiveTrajectory,
} from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const GATE = 0.5;
const SEEDS = 3;

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0);
const byEnv = new Map<string, number>();
for (const t of usable) byEnv.set(t.environment.id, (byEnv.get(t.environment.id) ?? 0) + 1);
const env = [...byEnv.entries()].sort((a, b) => b[1] - a[1])[0][0];
const pool = usable.filter((t) => t.environment.id === env);
console.log(`p2a-task-outcomes x${SEEDS} on '${env}' (${pool.length}), gate=${GATE}`);

interface TrajGate {
  id: string;
  success: boolean;
  totalSteps: number;
  gatedSteps: number;
  gatedFailSteps: number; // steps that were BOTH gated AND failed
  failSteps: number;
  recoveryCount: number;
  actions: number;
}
function measureTraj(wm: WorldModel, traj: CognitiveTrajectory): TrajGate {
  let gated = 0, gatedFail = 0, fails = 0;
  for (const step of traj.steps) {
    const p = wm.predict({ action: step.action });
    const isGated = p.confidence < GATE;
    if (isGated) gated++;
    if (step.outcome === 'failure') { fails++; if (isGated) gatedFail++; }
  }
  return {
    id: traj.id,
    success: traj.metrics.success,
    totalSteps: traj.steps.length,
    gatedSteps: gated,
    gatedFailSteps: gatedFail,
    failSteps: fails,
    recoveryCount: traj.metrics.recoveryCount ?? 0,
    actions: traj.metrics.actions ?? traj.steps.length,
  };
}

const allResults: Array<{ seed: string; correlation: number; successHighGate: number; successLowGate: number; failedHighGate: number; failedLowGate: number; meanGateShareSuccess: number; meanGateShareFailed: number; earlyWarningPrecision: number }> = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = `p2a-task-${i + 1}`;
  const rand = mulberry32(hashSeed(seed));
  const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const cut = Math.floor(shuffled.length * 0.7);
  const train = shuffled.slice(0, cut);
  const holdout = shuffled.slice(cut);
  const learned = replayIntoWorldModel(train, env);

  const rows = holdout.map((t) => measureTraj(learned, t));
  // Task-level analysis: does the gate share correlate with task failure?
  const successes = rows.filter((r) => r.success);
  const failures = rows.filter((r) => !r.success);
  const gateShare = (r: TrajGate) => r.totalSteps > 0 ? r.gatedSteps / r.totalSteps : 0;
  const meanShare = (rs: TrajGate[]) => rs.length > 0 ? Number((rs.reduce((s, r) => s + gateShare(r), 0) / rs.length).toFixed(3)) : 0;
  // split at median gate share: "high-gate" vs "low-gate" trajectories
  const shares = rows.map(gateShare).sort((a, b) => a - b);
  const median = shares[Math.floor(shares.length / 2)] ?? 0;
  const highGate = rows.filter((r) => gateShare(r) > median);
  const lowGate = rows.filter((r) => gateShare(r) <= median);
  // early-warning precision: of gated steps, how many actually failed?
  const totalGated = rows.reduce((s, r) => s + r.gatedSteps, 0);
  const totalGatedFail = rows.reduce((s, r) => s + r.gatedFailSteps, 0);
  const precision = totalGated > 0 ? Number((totalGatedFail / totalGated).toFixed(3)) : 0;
  // point-biserial-ish: mean gate share in failed vs succeeded tasks
  const ms = meanShare(successes);
  const mf = meanShare(failures);
  const correlation = ms + mf > 0 ? Number(((mf - ms) / (mf + ms)).toFixed(3)) : 0;

  allResults.push({
    seed,
    correlation,
    successHighGate: highGate.filter((r) => r.success).length,
    successLowGate: lowGate.filter((r) => r.success).length,
    failedHighGate: highGate.filter((r) => !r.success).length,
    failedLowGate: lowGate.filter((r) => !r.success).length,
    meanGateShareSuccess: ms,
    meanGateShareFailed: mf,
    earlyWarningPrecision: precision,
  });
  console.log(`\n${seed}:`);
  console.log(`  gate-share in SUCCEEDED tasks: ${ms} vs FAILED: ${mf} (correlation ${correlation})`);
  console.log(`  high-gate group: ${allResults[i].successHighGate} success / ${allResults[i].failedHighGate} failed`);
  console.log(`  low-gate group:  ${allResults[i].successLowGate} success / ${allResults[i].failedLowGate} failed`);
  console.log(`  early-warning precision (gated steps that actually failed): ${(precision * 100).toFixed(1)}%`);
}

// aggregate verdict
const posCorr = allResults.filter((r) => r.correlation > 0).length;
const meanCorr = allResults.reduce((s, r) => s + r.correlation, 0) / allResults.length;
const meanPrec = allResults.reduce((s, r) => s + r.earlyWarningPrecision, 0) / allResults.length;
console.log(`\n=== TASK-LEVEL SUMMARY ===`);
console.log(`correlation > 0 (more gating → more failure): ${posCorr}/${SEEDS} seeds`);
console.log(`mean correlation: ${meanCorr.toFixed(3)}`);
console.log(`mean early-warning precision: ${(meanPrec * 100).toFixed(1)}%`);
console.log(posCorr >= SEEDS - 1 && meanCorr > 0.1
  ? 'VERDICT: the learned WM identifies at-risk TRAJECTORIES, not just at-risk steps - prediction connects to task outcomes'
  : posCorr > SEEDS / 2
    ? 'VERDICT: majority direction - the gate flags risky trajectories, effect size modest'
    : 'VERDICT: no robust trajectory-level signal - HONEST NEGATIVE (calibration ≠ task success, reported separately per audit)');
