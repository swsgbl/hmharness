/**
 * @hmharness/cognitive - trajectory replay + data governance
 * (blueprint RD-010 replay UI backend; §18 可回放/可导出/可删除)
 *
 * replayTrajectory: one recorded run as an inspectable step list (action,
 * prediction, outcome, duration) — the dashboard's replay viewer backend.
 *
 * exportCognitiveState: single-file bundle of trajectories + memory + audit
 * (data governance: the user can ALWAYS take their data out, verbatim).
 *
 * purgeCognitiveState: deletes the cognitive store (trajectories/memory/
 * evolution audit/multi-agent log) after an explicit confirmation token —
 * the deletion side of governance; nothing else (sessions, insights,
 * evolution skills) is touched.
 */
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CognitiveTrajectory } from './index.ts';
import { loadTrajectories } from './analysis.ts';

export interface ReplayStepView {
  step: number;
  actionType: string;
  args: Record<string, unknown>;
  reason?: string;
  prediction?: { claim: string; confidence: number };
  outcome: 'success' | 'failure' | 'unknown';
  durationMs?: number;
  evidence: string[];
}

export interface ReplayView {
  trajectoryId: string;
  sessionId: string;
  environmentId: string;
  goal?: string;
  startedAt: string;
  steps: ReplayStepView[];
  metrics: CognitiveTrajectory['metrics'];
}

export async function listTrajectoryIds(home: string, limit = 50): Promise<Array<{ id: string; startedAt: string; actions: number; success: boolean; environmentId: string }>> {
  const all = await loadTrajectories(home, 500);
  return all
    .slice(-limit)
    .reverse()
    .map((t) => ({ id: t.id, startedAt: t.startedAt, actions: t.metrics.actions, success: t.metrics.success, environmentId: t.environment.id }));
}

export async function replayTrajectory(home: string, trajectoryId: string): Promise<ReplayView | null> {
  const all = await loadTrajectories(home, 500);
  const traj = all.find((t) => t.id === trajectoryId)
    ?? (trajectoryId === 'latest' ? all[all.length - 1] : undefined);
  if (!traj) return null;
  return {
    trajectoryId: traj.id,
    sessionId: traj.sessionId,
    environmentId: traj.environment.id,
    goal: traj.goal?.description,
    startedAt: traj.startedAt,
    steps: traj.steps.map((s) => ({
      step: s.step,
      actionType: s.action.type,
      args: s.action.args,
      reason: s.action.reason,
      prediction: s.prediction,
      outcome: s.outcome,
      durationMs: s.durationMs,
      evidence: s.evidence,
    })),
    metrics: traj.metrics,
  };
}

export interface CognitiveExport {
  exportedAt: string;
  home: string;
  trajectoryCount: number;
  memoryLineCount: number;
  auditLineCount: number;
  trajectories: CognitiveTrajectory[];
  memoryJsonl: string;
  evolutionAuditJsonl: string;
  multiAgentJsonl: string;
}

/** §18 data governance: full-fidelity single-file export (verbatim jsonl). */
export async function exportCognitiveState(home: string, outFile?: string): Promise<{ file: string; export: CognitiveExport }> {
  const read = async (p: string): Promise<string> => {
    try { return await readFile(p, 'utf8'); } catch { return ''; }
  };
  const exp: CognitiveExport = {
    exportedAt: new Date().toISOString(),
    home,
    trajectoryCount: 0,
    memoryLineCount: 0,
    auditLineCount: 0,
    trajectories: await loadTrajectories(home, 10_000),
    memoryJsonl: await read(join(home, 'cognitive', 'memory', 'memory.jsonl')),
    evolutionAuditJsonl: await read(join(home, 'cognitive', 'evolution', 'audit.jsonl')),
    multiAgentJsonl: await read(join(home, 'cognitive', 'multi-agent.jsonl')),
  };
  exp.trajectoryCount = exp.trajectories.length;
  exp.memoryLineCount = exp.memoryJsonl.split('\n').filter((l) => l.trim()).length;
  exp.auditLineCount = exp.evolutionAuditJsonl.split('\n').filter((l) => l.trim()).length;
  const file = outFile ?? join(home, `cognitive-export-${Date.now().toString(36)}.json`);
  await writeFile(file, JSON.stringify(exp, null, 1), 'utf8');
  return { file, export: exp };
}

/** §18 data governance: delete ONLY the cognitive store; the confirmation
 *  token must be exactly 'purge-cognitive' (no wildcard accepts). */
export async function purgeCognitiveState(home: string, confirm: string): Promise<{ ok: boolean; removed: string[]; error?: string }> {
  if (confirm !== 'purge-cognitive') {
    return { ok: false, removed: [], error: "refusing: pass confirm='purge-cognitive' explicitly" };
  }
  const removed: string[] = [];
  for (const dir of ['trajectories', 'memory', 'evolution']) {
    const p = join(home, 'cognitive', dir);
    await rm(p, { recursive: true, force: true }).catch(() => undefined);
    removed.push(`cognitive/${dir}`);
  }
  const ma = join(home, 'cognitive', 'multi-agent.jsonl');
  await rm(ma, { force: true }).catch(() => undefined);
  removed.push('cognitive/multi-agent.jsonl');
  // keep the cognitive/ dir itself (status/audit will recreate on demand)
  void readdir;
  return { ok: true, removed };
}
