/**
 * ARC-AGI-3 per-action-type analysis (2026-10-22): the lens the three-arm
 * verdict kept suggesting ("per-action-type analysis") and never got. For
 * each ACTION type in the arc3 corpus: corpus volume, success rate, and the
 * world model's calibration ON that type (trained on all, scored predict-
 * only per type). Reveals WHERE the calibration lives and where the
 * residual uncertainty concentrates — the actionable next-probe map.
 */
import { loadTrajectories, WorldModel, type CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 2000);
const pool = all.filter((t) => t.environment.id === 'arc3' && t.steps.length > 0);
console.log(`arc3 per-action analysis on ${pool.length} trajectories / ${pool.reduce((n, t) => n + t.steps.length, 0)} steps`);

// temporal split: train on first 70%, score on last 30% (deployment form)
const sorted = [...pool].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const cut = Math.floor(sorted.length * 0.7);
const train = sorted.slice(0, cut);
const holdout = sorted.slice(cut);

function replay(trajs: CognitiveTrajectory[]): WorldModel {
  const wm = new WorldModel('arc3');
  for (const traj of trajs) {
    for (const step of traj.steps) {
      const pred = wm.predict({ action: step.action });
      wm.update({
        stateBefore: wm.worldState,
        action: step.action,
        observation: { environmentId: 'arc3', timestamp: traj.startedAt, state: null, availableActions: [] },
        outcome: step.outcome,
        predictionId: pred.id,
      });
    }
  }
  return wm;
}
const wm = replay(train);

interface Row { type: string; trainN: number; holdN: number; succRate: number; brier: number; belief: number }
const rows: Row[] = [];
const types = new Set<string>();
for (const t of train) for (const s of t.steps) types.add(String((s.action as { type?: unknown }).type ?? '?'));
for (const t of holdout) for (const s of t.steps) types.add(String((s.action as { type?: unknown }).type ?? '?'));

for (const type of [...types].sort()) {
  const trainSteps = train.flatMap((t) => t.steps).filter((s) => String((s.action as { type?: unknown }).type) === type);
  const holdSteps = holdout.flatMap((t) => t.steps).filter((s) => String((s.action as { type?: unknown }).type) === type);
  if (holdSteps.length === 0 && trainSteps.length === 0) continue;
  const succRate = holdSteps.length ? holdSteps.filter((s) => s.outcome === 'success').length / holdSteps.length : trainSteps.filter((s) => s.outcome === 'success').length / Math.max(trainSteps.length, 1);
  let brier = 1;
  let belief = 0;
  if (holdSteps.length > 0) {
    let sum = 0;
    for (const s of holdSteps) {
      const p = wm.predict({ action: s.action });
      belief = p.confidence;
      sum += (p.confidence - (s.outcome === 'success' ? 1 : 0)) ** 2;
    }
    brier = sum / holdSteps.length;
  } else {
    const p = wm.predict({ action: { type } });
    belief = p.confidence;
  }
  rows.push({ type, trainN: trainSteps.length, holdN: holdSteps.length, succRate, brier, belief });
}

console.log('\ntype     | train | hold | succ-rate | WM belief | holdout Brier');
console.log('---------|-------|------|-----------|-----------|--------------');
for (const r of rows.sort((a, b) => b.trainN - a.trainN)) {
  console.log(`${r.type.padEnd(8)} | ${String(r.trainN).padStart(5)} | ${String(r.holdN).padStart(4)} | ${r.succRate.toFixed(3)}     | ${r.belief.toFixed(3)}     | ${r.holdN ? r.brier.toFixed(4) : 'n/a'}`);
}
const worst = rows.filter((r) => r.holdN > 0).sort((a, b) => b.brier - a.brier)[0];
if (worst) console.log(`\nresidual uncertainty concentrates in: ${worst.type} (Brier ${worst.brier.toFixed(4)}) — the next-probe target`);
