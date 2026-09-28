/**
 * @hmharness/cognitive - trajectory store (blueprint §23 + CL-001)
 *
 * Every cognitive run appends ONE JSONL trajectory: observation refs, actions
 * WITH reasons, optional pre-action predictions (confidence), outcomes,
 * rewards and evidence refs. Raw records are append-only — distillation
 * happens in other layers, never by rewriting here (blueprint §10: 精炼层
 * 不可覆盖原始记录).
 */
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTrajectory, type CognitiveTrajectory, type TrajectoryStep } from './protocol.ts';

export class TrajectoryStore {
  constructor(private home: string) {}

  private dir(): string {
    return join(this.home, 'cognitive', 'trajectories');
  }

  async append(traj: CognitiveTrajectory): Promise<{ ok: boolean; errors: string[]; file: string }> {
    const v = validateTrajectory(traj);
    if (!v.valid) return { ok: false, errors: v.errors, file: '' };
    await mkdir(this.dir(), { recursive: true });
    const file = join(this.dir(), `${traj.id}.jsonl`);
    await appendFile(file, JSON.stringify(traj) + '\n', 'utf8');
    return { ok: true, errors: [], file };
  }

  async load(id: string): Promise<CognitiveTrajectory[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir(), `${id}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CognitiveTrajectory);
  }
}

/** In-memory builder so callers never hand-assemble step arrays. */
export class TrajectoryRecorder {
  private steps: TrajectoryStep[] = [];
  private startedAt = new Date().toISOString();
  private recoveries = 0;
  private t0 = Date.now();

  constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly environment: { id: string; version: string },
    private goal?: { id: string; description: string },
  ) {}

  record(step: Omit<TrajectoryStep, 'step'>): void {
    if (this.steps.length > 0 && this.steps[this.steps.length - 1].outcome === 'failure' && step.outcome === 'success') {
      this.recoveries += 1;
    }
    this.steps.push({ ...step, step: this.steps.length + 1 });
  }

  finish(success: boolean): CognitiveTrajectory {
    return {
      id: this.id,
      sessionId: this.sessionId,
      environment: this.environment,
      goal: this.goal,
      steps: this.steps,
      metrics: {
        success,
        actions: this.steps.length,
        elapsedMs: Date.now() - this.t0,
        recoveryCount: this.recoveries,
        brierScore: brierScore(this.steps),
      },
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
    };
  }
}

/** Brier score over predicted steps: mean((confidence - outcome)^2).
 *  Lower is better; undefined when no predictions were made — an agent that
 *  never predicts cannot be scored on calibration (that absence is itself
 *  reported by the dashboard, not silently zeroed). */
export function brierScore(steps: TrajectoryStep[]): number | undefined {
  const predicted = steps.filter((s) => s.prediction);
  if (predicted.length === 0) return undefined;
  let sum = 0;
  for (const s of predicted) {
    const actual = s.outcome === 'success' ? 1 : 0;
    const c = Math.min(1, Math.max(0, s.prediction!.confidence));
    sum += (c - actual) ** 2;
  }
  return Number((sum / predicted.length).toFixed(4));
}

/** Deterministic replay check: re-run recorded actions against a fresh
 *  environment and report divergence. Used by WM-009 and BENCH tracks. */
export async function replay(
  traj: CognitiveTrajectory,
  fresh: { act(a: TrajectoryStep['action']): Promise<{ outcome: string }> },
): Promise<{ divergedAt: number | null; mismatches: Array<{ step: number; recorded: string; replayed: string }> }> {
  const mismatches: Array<{ step: number; recorded: string; replayed: string }> = [];
  let divergedAt: number | null = null;
  for (const s of traj.steps) {
    const r = await fresh.act(s.action);
    if (r.outcome !== s.outcome) {
      mismatches.push({ step: s.step, recorded: s.outcome, replayed: r.outcome });
      if (divergedAt === null) divergedAt = s.step;
    }
  }
  return { divergedAt, mismatches };
}
