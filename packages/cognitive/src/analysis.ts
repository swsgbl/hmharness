/**
 * @hmharness/cognitive - analysis (blueprint M2/M8/M11: the data flywheel)
 *
 * Turns the trajectory store that the live runner has been filling into the
 * three things the cognitive layers consume:
 *
 *  - loadWorldModel: replay every recorded step THROUGH the world model
 *    (predict-then-update), so beliefs, calibration and planner gates are
 *    built from REAL run history, not synthetic examples
 *  - diagnoseOpportunities: LearningController.diagnose over the real
 *    trajectory dataset — failure clusters, calibration gaps, recovery and
 *    efficiency opportunities (CL-003 wired to live data)
 *  - benchFromTrajectories: GeneralBench uniform metrics aggregated over
 *    recorded runs per environment (BENCH seed on real samples)
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorldModel, type CognitiveTrajectory } from './index.ts';
import { LearningController, type LearningOpportunity } from './continual.ts';
import { uniformMetrics, type UniformMetrics } from './benchmark.ts';

export async function loadTrajectories(home: string, limit = 500): Promise<CognitiveTrajectory[]> {
  const dir = join(home, 'cognitive', 'trajectories');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: CognitiveTrajectory[] = [];
  for (const f of files.slice(-limit)) {
    try {
      const text = await readFile(join(dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as CognitiveTrajectory);
        } catch { /* skip torn tail lines */ }
      }
    } catch { /* unreadable file: skip */ }
  }
  return out;
}

export interface WorldModelSummary {
  environmentId: string;
  beliefs: Array<{ actionType: string; confidence: number; evidenceCount: number; claim: string }>;
  plannerGate: { trusted: string[]; untrusted: string[]; unknown: string[] };
  calibration: { resolved: number; meanError: number | undefined };
  trajectoriesReplayed: number;
  stepsReplayed: number;
}

/** Replay recorded trajectories through a fresh WorldModel. Every step is
 *  predicted BEFORE it is applied, so prediction-vs-actual calibration is
 *  measured on history the model never saw coming (no leakage). */
export function replayIntoWorldModel(trajectories: CognitiveTrajectory[], environmentId = 'terminal'): WorldModel {
  const wm = new WorldModel(environmentId);
  for (const traj of trajectories) {
    if (traj.environment.id !== environmentId) continue;
    for (const step of traj.steps) {
      const prediction = wm.predict({ action: step.action });
      wm.update({
        stateBefore: wm.worldState,
        action: step.action,
        observation: { environmentId, timestamp: traj.startedAt, state: null, availableActions: [] },
        outcome: step.outcome,
        predictionId: prediction.id,
      });
    }
  }
  return wm;
}

export function summarizeWorldModel(wm: WorldModel, trajectoriesReplayed: number, stepsReplayed: number): WorldModelSummary {
  const state = wm.worldState;
  return {
    environmentId: state.environmentId,
    beliefs: state.beliefs
      .filter((b) => b.id.startsWith('act:'))
      .map((b) => ({ actionType: b.id.slice(4), confidence: b.confidence, evidenceCount: b.evidenceCount, claim: b.claim }))
      .sort((a, b) => b.evidenceCount - a.evidenceCount),
    plannerGate: wm.plannerConfidence(0.6),
    calibration: wm.calibration(),
    trajectoriesReplayed,
    stepsReplayed,
  };
}

/** Full pipeline for one home: load -> replay -> summarize. */
export async function analyzeWorldModel(home: string, environmentId = 'terminal'): Promise<WorldModelSummary> {
  const trajectories = await loadTrajectories(home);
  const steps = trajectories.filter((t) => t.environment.id === environmentId).reduce((s, t) => s + t.steps.length, 0);
  const wm = replayIntoWorldModel(trajectories, environmentId);
  return summarizeWorldModel(wm, trajectories.length, steps);
}

/** CL-003 over live data: what kind of learning would pay off right now? */
export async function diagnoseOpportunities(home: string): Promise<{ opportunities: LearningOpportunity[]; trajectories: number }> {
  const trajectories = await loadTrajectories(home);
  const lc = new LearningController(); // diagnosis only: no trainer needed
  for (const t of trajectories) await lc.collect(t);
  return { opportunities: await lc.diagnose(lc.dataset()), trajectories: trajectories.length };
}

export interface BenchReport {
  environmentId: string;
  runs: number;
  aggregate: UniformMetrics & { successRate: number };
}

/** BENCH seed: uniform metrics aggregated over recorded runs (action budget
 *  = the run's own step count +1, so efficiency measures consistency, and
 *  honest runs with retries score below clean one-shot runs). */
export async function benchFromTrajectories(home: string, environmentId = 'terminal', limit = 200): Promise<BenchReport | null> {
  const trajectories = (await loadTrajectories(home, limit)).filter((t) => t.environment.id === environmentId);
  if (trajectories.length === 0) return null;
  const metrics = trajectories.map((t) => uniformMetrics(t, t.metrics.actions + 1));
  const avg = (pick: (m: UniformMetrics) => number): number => Number((metrics.reduce((s, m) => s + pick(m), 0) / metrics.length).toFixed(3));
  return {
    environmentId,
    runs: trajectories.length,
    aggregate: {
      success: avg((m) => m.success),
      actionEfficiency: avg((m) => m.actionEfficiency),
      recoveryRate: avg((m) => m.recoveryRate),
      calibration: avg((m) => m.calibration),
      predicted: metrics.some((m) => m.predicted),
      costUnits: avg((m) => m.costUnits),
      latencyMs: avg((m) => m.latencyMs),
      successRate: avg((m) => m.success),
    },
  };
}
