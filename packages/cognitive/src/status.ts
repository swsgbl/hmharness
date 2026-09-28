/**
 * @hmharness/cognitive - status snapshot for CLI (`hmh cognitive status`)
 * and the web research dashboard (`/api/cognitive`).
 *
 * RD-001..008 seed: one call gathers registry state, memory layer stats,
 * evolution audit tail and bench/transfer readiness. Read-only, cheap,
 * honest — absent subsystems report absent, never zeros-that-lie.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CognitiveMemory, TrajectoryStore, type MemoryLayer } from './index.ts';

export interface CognitiveStatus {
  home: string;
  memory: Record<string, number>;
  memoryContradictions: number;
  trajectories: number;
  evolutionAuditEvents: number;
  evolutionLastEvent?: Record<string, unknown>;
  environments: Array<{ id: string; version: string }>;
  ready: { memory: boolean; trajectories: boolean; evolutionAudit: boolean };
  /** world-model digest replayed from recorded trajectories (blueprint M2) */
  worldModel?: {
    beliefs: Array<{ actionType: string; confidence: number; evidenceCount: number }>;
    plannerGate: { trusted: string[]; untrusted: string[]; unknown: string[] };
    calibration: { resolved: number; meanError: number | undefined };
    stepsReplayed: number;
  };
}

export async function cognitiveStatus(home: string): Promise<CognitiveStatus> {
  const mem = new CognitiveMemory(home);
  const loaded = await mem.load();
  const contradictions = mem.detectContradictions().length;
  let trajectories = 0;
  try {
    const files = await readdir(join(home, 'cognitive', 'trajectories')).catch(() => [] as string[]);
    trajectories = files.filter((f) => f.endsWith('.jsonl')).length;
  } catch { trajectories = 0; }
  void new TrajectoryStore(home); // store is instantiated per-write; count files instead
  let auditEvents = 0;
  let evolutionLastEvent: Record<string, unknown> | undefined;
  try {
    const text = await readFile(join(home, 'cognitive', 'evolution', 'audit.jsonl'), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    auditEvents = lines.length;
    if (lines.length) evolutionLastEvent = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  } catch { /* no audit yet */ }
  const environments = [
    { id: 'terminal', version: '1.0.0' },
    { id: 'harmonyos', version: '1.0.0' },
    { id: 'browser', version: '1.0.0' },
    { id: 'desktop', version: '1.0.0' },
    { id: 'arc3', version: '0.1.0' },
  ];
  void loaded;
  let worldModel: CognitiveStatus['worldModel'];
  try {
    const { analyzeWorldModel } = await import('./analysis.ts');
    const wm = await analyzeWorldModel(home);
    worldModel = {
      beliefs: wm.beliefs.slice(0, 10).map((b) => ({ actionType: b.actionType, confidence: b.confidence, evidenceCount: b.evidenceCount })),
      plannerGate: wm.plannerGate,
      calibration: wm.calibration,
      stepsReplayed: wm.stepsReplayed,
    };
  } catch { /* world model digest is best-effort */ }
  return {
    home,
    memory: mem.stats() as Record<string, number>,
    memoryContradictions: contradictions,
    trajectories,
    evolutionAuditEvents: auditEvents,
    evolutionLastEvent,
    environments,
    ready: {
      memory: loaded > 0,
      trajectories: trajectories > 0,
      evolutionAudit: auditEvents > 0,
    },
    worldModel,
  };
}

/** Human-facing one-pager (zh) for the CLI. */
export function formatCognitiveStatus(s: CognitiveStatus): string {
  const layers = (['working', 'episodic', 'semantic', 'procedural', 'world'] as MemoryLayer[])
    .map((l) => `${l}:${s.memory[l] ?? 0}`)
    .join('  ');
  const lines = [
    'HMH Cognitive OS 状态',
    `  记忆五层    ${layers}（矛盾待审 ${s.memoryContradictions}）`,
    `  轨迹库      ${s.trajectories} 条 episodic 记录`,
    `  进化审计    ${s.evolutionAuditEvents} 条事件${s.evolutionLastEvent ? `（最近: ${String(s.evolutionLastEvent.event)}）` : ''}`,
    `  环境注册表  ${s.environments.map((e) => e.id).join(' / ')}`,
  ];
  if (s.worldModel && s.worldModel.beliefs.length > 0) {
    const top = s.worldModel.beliefs.slice(0, 3).map((b) => `${b.actionType}≈${b.confidence.toFixed(1)}`).join(' ');
    const cal = s.worldModel.calibration;
    lines.push(`  世界模型    ${s.worldModel.stepsReplayed} 步回放，top 信念 ${top}${cal.meanError !== undefined ? `，校准误差 ${cal.meanError}` : ''}`);
  }
  const notReady = Object.entries(s.ready).filter(([, v]) => !v).map(([k]) => k);
  if (notReady.length) lines.push(`  未激活      ${notReady.join(', ')}（对应能力尚未产生第一条数据）`);
  else lines.push('  全部子系统已产生数据');
  return lines.join('\n');
}
