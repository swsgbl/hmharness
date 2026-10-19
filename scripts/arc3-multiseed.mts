/**
 * ARC-AGI-3 world-model promotion check (2026-10-19): multiseed split-
 * robustness of the arc3 calibration gain — same protocol as
 * scripts/real-cycle-multiseed.mts (train/holdout 70/30, predict-only
 * scoring on holdout steps, world_model promotion bar: relative Brier
 * improvement >= 0.6), specialized to the arc3 corpus.
 */
import { loadTrajectories, WorldModel, type CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const SEEDS = 5;
const BAR = 0.6;

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const all = await loadTrajectories(HOME, 1000);
const pool = all.filter((t) => t.environment.id === 'arc3' && t.steps.length > 0);
console.log(`arc3 multiseed x${SEEDS} on ${pool.length} trajectories (bar: relative Brier improvement >= ${BAR})`);

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
/** predict-only scoring on holdout steps (no belief updates) */
function brier(wm: WorldModel, trajs: CognitiveTrajectory[]): number {
  let sum = 0;
  let n = 0;
  for (const traj of trajs) {
    for (const step of traj.steps) {
      const p = wm.predict({ action: step.action });
      const actual = step.outcome === 'success' ? 1 : 0;
      sum += (p.confidence - actual) ** 2;
      n++;
    }
  }
  return n > 0 ? sum / n : 1;
}

let promoted = 0;
const evidence: number[] = [];
for (let s = 1; s <= SEEDS; s++) {
  const rng = mulberry32(hashSeed('arc3-multiseed-' + s));
  const shuffled = [...pool].sort(() => rng() - 0.5);
  const cut = Math.floor(shuffled.length * 0.7);
  const train = shuffled.slice(0, cut);
  const holdout = shuffled.slice(cut);
  const trained = replay(train);
  const fresh = new WorldModel('arc3');
  const bTrained = brier(trained, holdout);
  const bFresh = brier(fresh, holdout);
  const rel = bFresh > 0 ? (bFresh - bTrained) / bFresh : 0;
  const ok = rel >= BAR && holdout.reduce((n, t) => n + t.steps.length, 0) >= 10;
  if (ok) promoted++;
  evidence.push(rel);
  console.log(`  seed ${s}: train ${train.length}/holdout ${holdout.length} — Brier trained ${bTrained.toFixed(4)} vs fresh ${bFresh.toFixed(4)} — relative ${rel.toFixed(3)} ${ok ? '✓' : '✗'}`);
}
const mean = evidence.reduce((a, b) => a + b, 0) / evidence.length;
const signP = promoted === SEEDS ? (1 / 2 ** SEEDS).toFixed(4) : 'n/a';
console.log(`\n${promoted}/${SEEDS} seeds promoted (mean relative improvement ${mean.toFixed(3)}${promoted === SEEDS ? `, sign-test p=${signP}` : ''})`);
console.log(promoted === SEEDS
  ? 'VERDICT: arc3 world-model calibration gain is split-robust — the harness-layer net contribution on ARC-AGI-3 replays.'
  : 'VERDICT: not split-robust yet — corpus still thin (31 trajectories); grow play data.');
