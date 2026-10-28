/**
 * @hmharness/cognitive - GeneralBench schema + Transfer lab (blueprint §12/§13/§17)
 *
 * GeneralBench (BENCH-001..012): a track registry where every track is a
 * runnable suite with UNIFORM metrics — success, action efficiency,
 * recovery, calibration, transfer delta, cost, latency (blueprint §12 指标
 * must-include list). Tracks are host-supplied; the runner computes the
 * uniform metric layer so cross-track comparison is honest.
 *
 * Transfer lab (TR-001..007): Transfer Score = performance gain in a TARGET
 * environment given skills/policy learned in a SOURCE environment, vs a
 * from-scratch baseline. Negative transfer (learned policy hurts) is a
 * first-class outcome, not an error.
 */
import type { CognitiveTrajectory } from './protocol.ts';

export type BenchTrackId =
  | 'software' | 'computer-use' | 'research' | 'planning' | 'exploration'
  | 'memory' | 'world-model' | 'long-horizon' | 'transfer' | 'open-ended';

export interface BenchCase {
  id: string;
  track: BenchTrackId;
  /** the task as given to the agent */
  prompt: string;
  environmentId: string;
  /** host-resolved checker: the ground truth, never the agent's own word */
  verify: (traj: CognitiveTrajectory) => Promise<{ pass: boolean; note?: string }>;
  /** action-count budget before efficiency starts decaying */
  actionBudget: number;
}

export interface UniformMetrics {
  success: number;          // 0/1
  actionEfficiency: number; // budget/actions, capped at 1
  recoveryRate: number;     // recoveries / failures (0 when nothing failed)
  calibration: number;      // 1 - brier when predictions exist, else 0 with predicted=false
  predicted: boolean;
  costUnits: number;
  latencyMs: number;
}

export interface CaseRun {
  caseId: string;
  metrics: UniformMetrics;
  note?: string;
}

export interface TrackReport {
  track: BenchTrackId;
  runs: CaseRun[];
  aggregate: Record<string, number>;
}

/** BENCH-001. The registry: tracks register cases; the runner normalizes. */
export class GeneralBench {
  private cases = new Map<string, BenchCase>();

  register(case_: BenchCase): void {
    if (this.cases.has(case_.id)) throw new Error(`bench case ${case_.id} already registered`);
    this.cases.set(case_.id, case_);
  }

  list(): BenchCase[] {
    return [...this.cases.values()];
  }

  listByTrack(track: BenchTrackId): BenchCase[] {
    return this.list().filter((c) => c.track === track);
  }

  async runCase(caseId: string, traj: CognitiveTrajectory): Promise<CaseRun> {
    const c = this.cases.get(caseId);
    if (!c) throw new Error(`unknown bench case ${caseId}`);
    const verdict = await c.verify(traj);
    const metrics = uniformMetrics(traj, c.actionBudget);
    return { caseId, metrics, note: verdict.note };
  }

  async runTrack(track: BenchTrackId, trajectories: Map<string, CognitiveTrajectory>): Promise<TrackReport> {
    const runs: CaseRun[] = [];
    for (const c of this.listByTrack(track)) {
      const traj = trajectories.get(c.id);
      if (!traj) continue;
      runs.push(await this.runCase(c.id, traj));
    }
    return { track, runs, aggregate: aggregate(runs) };
  }
}

export function uniformMetrics(traj: CognitiveTrajectory, actionBudget: number): UniformMetrics {
  const actions = Math.max(1, traj.metrics.actions);
  const failures = traj.steps.filter((s) => s.outcome === 'failure').length;
  return {
    success: traj.metrics.success ? 1 : 0,
    actionEfficiency: Number(Math.min(1, actionBudget / actions).toFixed(3)),
    recoveryRate: failures ? Number(Math.min(1, traj.metrics.recoveryCount / failures).toFixed(3)) : 0,
    calibration: traj.metrics.brierScore !== undefined ? Number((1 - traj.metrics.brierScore).toFixed(3)) : 0,
    predicted: traj.metrics.brierScore !== undefined,
    costUnits: traj.steps.reduce((s, x) => s + (x.durationMs ?? 0) / 1_000, 0),
    latencyMs: traj.metrics.elapsedMs,
  };
}

function aggregate(runs: CaseRun[]): Record<string, number> {
  if (runs.length === 0) return {};
  const keys: Array<keyof UniformMetrics> = ['success', 'actionEfficiency', 'recoveryRate', 'calibration', 'costUnits', 'latencyMs'];
  const out: Record<string, number> = { cases: runs.length };
  for (const k of keys) {
    out[k] = Number((runs.reduce((s, r) => s + Number(r.metrics[k]), 0) / runs.length).toFixed(3));
  }
  return out;
}

/* ---- Transfer lab (blueprint §17 / TR-001..007) ---- */

export interface TransferCell {
  sourceEnv: string;
  targetEnv: string;
  /** success rate in target WITH the source-learned policy/skill/memory */
  withTransfer: number;
  /** success rate in target from scratch (no carry-over) */
  fromScratch: number;
  samplesWith: number;
  samplesWithout: number;
}

export interface TransferMatrix {
  cells: TransferCell[];
}

/** TR-006. Transfer Score = relative gain; negative means the carried-over
 *  policy HURT (TR-007 negative transfer is a first-class result). */
export function transferScore(cell: TransferCell): number {
  if (cell.fromScratch === 0) return cell.withTransfer > 0 ? 1 : 0;
  return Number(((cell.withTransfer - cell.fromScratch) / cell.fromScratch).toFixed(3));
}

export function transferVerdict(cell: TransferCell): 'positive' | 'neutral' | 'negative' {
  const s = transferScore(cell);
  if (s > 0.1) return 'positive';
  if (s < -0.1) return 'negative';
  return 'neutral';
}

/** TR-001. Build the matrix from per-cell measurements. */
export function buildTransferMatrix(cells: TransferCell[]): TransferMatrix & { summary: Record<string, number> } {
  const scores = cells.map(transferScore);
  return {
    cells,
    summary: {
      cells: cells.length,
      meanTransfer: scores.length ? Number((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(3)) : 0,
      positive: cells.filter((c) => transferVerdict(c) === 'positive').length,
      negative: cells.filter((c) => transferVerdict(c) === 'negative').length,
      neutral: cells.filter((c) => transferVerdict(c) === 'neutral').length,
    },
  };
}
