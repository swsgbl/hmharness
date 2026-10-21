/**
 * ARC-AGI-3 temporal learning curve (2026-10-21): the five-scale sweep used
 * RANDOM splits (i.i.d. assumption); this is the deployment-honest TEMPORAL
 * form — trajectories sorted by startedAt, bucketed into equal fifths, the
 * world model trains on everything BEFORE each bucket and is scored
 * predict-only ON that bucket. A falling Brier across buckets = the harness
 * genuinely learns from its own past to predict its future.
 */
import { loadTrajectories, WorldModel, type CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const BUCKETS = 5;

const all = await loadTrajectories(HOME, 1000);
const pool = all
  .filter((t) => t.environment.id === 'arc3' && t.steps.length > 0)
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
console.log(`arc3 temporal curve: ${pool.length} trajectories, ${BUCKETS} chronological buckets`);

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
function brier(wm: WorldModel, trajs: CognitiveTrajectory[]): { b: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const traj of trajs) {
    for (const step of traj.steps) {
      const p = wm.predict({ action: step.action });
      sum += (p.confidence - (step.outcome === 'success' ? 1 : 0)) ** 2;
      n++;
    }
  }
  return { b: n > 0 ? sum / n : 1, n };
}

const size = Math.floor(pool.length / BUCKETS);
console.log('\nbucket | window | steps | trained-Brier | fresh-Brier');
const trainedBs: number[] = [];
for (let i = 0; i < BUCKETS; i++) {
  const bucket = pool.slice(i * size, i === BUCKETS - 1 ? pool.length : (i + 1) * size);
  const past = pool.slice(0, i * size);
  const trained = replay(past);
  const fresh = new WorldModel('arc3');
  const bt = brier(trained, bucket);
  const bf = brier(fresh, bucket);
  trainedBs.push(bt.b);
  console.log(`  ${i + 1}    | ${bucket[0].startedAt.slice(0, 10)}~${bucket[bucket.length - 1].startedAt.slice(0, 10)} | ${String(bt.n).padStart(4)} | ${bt.b.toFixed(4)}        | ${bf.b.toFixed(4)}`);
}
const first = trainedBs[0];
const last = trainedBs[trainedBs.length - 1];
const monotone = trainedBs.every((b, i) => i === 0 || b <= trainedBs[i - 1] * 1.1);
console.log(`\ntrained-Brier first→last: ${first.toFixed(4)} → ${last.toFixed(4)} (${last < first ? 'IMPROVING' : 'NOT improving'}${monotone ? ', ~monotone' : ''})`);
console.log(last < first
  ? 'VERDICT: the world model learns from its own past — temporal (deployment-form) calibration improvement on ARC-AGI-3.'
  : 'VERDICT: no temporal improvement — honest negative.');
