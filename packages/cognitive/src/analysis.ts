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

/* ---- ARC-AGI-3 metrics (blueprint §14 / ARC-005) ---- */

export interface Arc3PlayMetrics {
  trajectoryId: string;
  gameId?: string;
  actions: number;
  levelsCompleted: number;
  levelCount: number;
  /** levels advanced per action (action efficiency) */
  actionEfficiency: number;
  /** fraction of the offered action space actually probed (exploration efficiency) */
  explorationEfficiency: number;
  /** recoveries per failed action (resilience) */
  recoveryRate: number;
  finishedAt: string;
}

export interface Arc3MetricsReport {
  plays: number;
  totalActions: number;
  totalLevelsCompleted: number;
  meanActionEfficiency: number;
  meanExplorationEfficiency: number;
  meanRecoveryRate: number;
  perPlay: Arc3PlayMetrics[];
}

/** ARC-005: aggregate the blueprint's action/exploration efficiency and
 *  recovery metrics over recorded ARC-AGI-3 plays (trajectories + episodic
 *  summaries). Honest on empty: null, never zeros-that-lie. */
export async function arc3Metrics(home: string, limit = 100): Promise<Arc3MetricsReport | null> {
  const trajectories = (await loadTrajectories(home, limit)).filter((t) => t.environment.id === 'arc3');
  if (trajectories.length === 0) return null;
  const perPlay: Arc3PlayMetrics[] = [];
  for (const traj of trajectories) {
    const actionTypes = new Set(traj.steps.map((s) => s.action.type));
    const failures = traj.steps.filter((s) => s.outcome === 'failure').length;
    const levels = traj.goal?.description?.match(/game ([\w-]+)/)?.[1];
    perPlay.push({
      trajectoryId: traj.id,
      gameId: levels,
      actions: traj.metrics.actions,
      // levels come from the episodic summary written at close; the trajectory
      // itself records actions — levels default 0 when the summary is absent
      levelsCompleted: 0,
      levelCount: 0,
      actionEfficiency: Number((0 / Math.max(1, traj.metrics.actions)).toFixed(3)),
      explorationEfficiency: Number((actionTypes.size / 7).toFixed(3)),
      recoveryRate: failures ? Number((traj.metrics.recoveryCount / failures).toFixed(3)) : 0,
      finishedAt: traj.endedAt ?? traj.startedAt,
    });
  }
  // enrich with episodic summaries ("ARC3 PLAY game: L/N levels in M actions")
  const mem = new (await import('./memory.ts')).CognitiveMemory(home);
  await mem.load();
  const summaries = mem.retrieve({ layer: 'episodic', text: 'ARC3 PLAY', limit: 200 });
  for (const p of perPlay) {
    const s = summaries.find((e) => (e.payload as { trajectoryId?: string } | undefined)?.trajectoryId === p.trajectoryId);
    if (!s) continue;
    const m = s.content.match(/([\w-]+): (\d+)\/(\d+) levels in (\d+) actions/);
    if (!m) continue;
    p.gameId = m[1];
    p.levelsCompleted = Number(m[2]);
    p.levelCount = Number(m[3]);
    p.actionEfficiency = Number((Number(m[2]) / Math.max(1, Number(m[4]))).toFixed(3));
  }
  const avg = (pick: (p: Arc3PlayMetrics) => number): number => Number((perPlay.reduce((s, p) => s + pick(p), 0) / perPlay.length).toFixed(3));
  return {
    plays: perPlay.length,
    totalActions: perPlay.reduce((s, p) => s + p.actions, 0),
    totalLevelsCompleted: perPlay.reduce((s, p) => s + p.levelsCompleted, 0),
    meanActionEfficiency: avg((p) => p.actionEfficiency),
    meanExplorationEfficiency: avg((p) => p.explorationEfficiency),
    meanRecoveryRate: avg((p) => p.recoveryRate),
    perPlay,
  };
}

/* ---- context advisor (blueprint M3: the planner consumes the world model) ---- */

/** Compact world-model digest for the SYSTEM PROMPT. The model sees which
 *  tool types history trusts, which keep failing, and what the diagnosis
 *  layer currently suggests — perception feeding action, capped hard so it
 *  can never bloat the prompt (max ~500 chars). */
export async function buildContextDigest(home: string, maxChars = 500): Promise<string> {
  try {
    const wm = await analyzeWorldModel(home);
    if (wm.stepsReplayed < 3) return ''; // too little evidence to advise on
    const lines: string[] = [];
    const untrusted = wm.beliefs.filter((b) => b.confidence < 0.5 && b.evidenceCount >= 2);
    if (untrusted.length > 0) {
      lines.push(`Flaky tools historically (verify carefully when using): ${untrusted.slice(0, 3).map((b) => `${b.actionType}(${Math.round(b.confidence * 100)}%)`).join(', ')}.`);
    }
    const trusted = wm.beliefs.filter((b) => b.confidence >= 0.7 && b.evidenceCount >= 3);
    if (trusted.length > 0) {
      lines.push(`Reliable tools: ${trusted.slice(0, 3).map((b) => b.actionType).join(', ')}.`);
    }
    const { opportunities } = await diagnoseOpportunities(home);
    const opp = opportunities[0];
    if (opp) lines.push(`Learning focus right now: ${opp.signal.slice(0, 120)}.`);
    const text = lines.join(' ');
    return text.length > maxChars ? text.slice(0, maxChars - 3) + '...' : text;
  } catch {
    return ''; // advising is best-effort; never block context assembly
  }
}

/* ---- goal drift over recorded trajectories (blueprint GOAL-005 on live data) ---- */

export interface GoalDriftView {
  trajectoryId: string;
  goalDescription: string;
  driftScore: number;
  signals: string[];
  recommendation: string;
}

/** GOAL-005 on live data: for every recorded trajectory that carried a goal,
 *  compare its actions against the goal's keywords and report drift.
 *  order='score' (default) ranks worst-first; order='time' is the timeline
 *  view (oldest→newest) the dashboard renders as a trend. */
export async function analyzeGoalDrift(home: string, limit = 100, order: 'score' | 'time' = 'score'): Promise<GoalDriftView[]> {
  const { GoalManager } = await import('./goal.ts');
  const gm = new GoalManager();
  const trajectories = (await loadTrajectories(home, limit)).filter((t) => t.goal?.description);
  const out: Array<GoalDriftView & { startedAt: string }> = [];
  for (const traj of trajectories) {
    const goal = gm.propose({
      id: traj.goal!.id,
      description: traj.goal!.description,
      source: 'user',
      priority: 1,
      constraints: [],
      successCriteria: [],
    });
    const transitions = traj.steps.map((s) => ({
      stateBefore: {} as never,
      action: s.action,
      observation: { environmentId: traj.environment.id, timestamp: traj.startedAt, state: null, availableActions: [] },
      outcome: s.outcome,
    }));
    const report = gm.detectDrift(goal, transitions, { sessionId: traj.sessionId, actionsTaken: traj.steps.length });
    out.push({
      trajectoryId: traj.id,
      goalDescription: traj.goal!.description,
      driftScore: report.driftScore,
      signals: report.signals,
      recommendation: report.recommendation,
      startedAt: traj.startedAt,
    });
  }
  if (order === 'time') out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  else out.sort((a, b) => b.driftScore - a.driftScore);
  return out;
}

/* ---- skill candidates from real trajectories (blueprint M7 on live data) ---- */

export interface SkillCandidateView {
  id: string;
  name: string;
  procedure: string[];
  evidenceTrajectories: number;
  status: string;
}

/** SK-002 on live data: mine repeated successful action runs from the
 *  trajectory store into skill CANDIDATES (promotion still requires the
 *  benchmark gate — this only surfaces what the history suggests). */
export async function skillCandidatesFromHistory(home: string, opts?: { minRepeat?: number }): Promise<SkillCandidateView[]> {
  const { SkillCompiler } = await import('./skill-compiler.ts');
  const compiler = new SkillCompiler();
  const trajectories = await loadTrajectories(home);
  const candidates = await compiler.compile(trajectories, opts);
  return candidates.map((c) => ({
    id: c.id,
    name: c.name,
    procedure: c.procedure.map((s) => s.ref),
    evidenceTrajectories: c.evidence.length,
    status: c.status,
  }));
}
