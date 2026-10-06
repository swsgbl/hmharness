/**
 * Multi-seed statistical hardening of the real learning cycle (the
 * single-seed caveat's clearance). Runs the world_model target across N
 * independent seeded splits of the REAL trajectory store and reports the
 * paired outcome: per-seed promote/reject + evidence, the sign-test style
 * summary (how many seeds promoted), and mean/min evidence. A claim that
 * survives all seeds with a healthy minimum is robust to split luck; a
 * claim that flips across seeds was split luck.
 *
 * Honesty rules unchanged: per-seed the holdout is used exactly once
 * (single split per seed, no reuse), the evaluator is predict-only, and
 * the summary NEVER claims causation - it reports split-robustness of an
 * observational association.
 */
import {
  loadTrajectories,
  LearningTargetRegistry,
  registerWorldModelTarget,
  type CognitiveTrajectory,
  type LearningDataset,
} from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const SEEDS = (process.argv[2] ? Number(process.argv[2]) : 5);

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0);
const byEnv = new Map<string, number>();
for (const t of usable) byEnv.set(t.environment.id, (byEnv.get(t.environment.id) ?? 0) + 1);
const env = [...byEnv.entries()].sort((a, b) => b[1] - a[1])[0][0];
const pool = usable.filter((t) => t.environment.id === env);
console.log(`multi-seed x${SEEDS} on '${env}' (${pool.length} trajectories of ${usable.length})`);

const results: Array<{ seed: string; decision: string; evidence: number; brierTrained: number; brierFresh: number; checked: number }> = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = `multiseed-${i + 1}`;
  const rand = mulberry32(hashSeed(seed));
  const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const cut = Math.floor(shuffled.length * 0.7);
  const train: LearningDataset = { trajectories: shuffled.slice(0, cut) };
  const holdoutList: CognitiveTrajectory[] = shuffled.slice(cut);

  const registry = new LearningTargetRegistry();
  registerWorldModelTarget(registry, { environmentId: env, holdout: async () => ({ trajectories: holdoutList }) });
  const out = await registry.runCycle({ opportunityId: seed, target: 'world_model', payload: {} } as never, train);
  const m = out.evalResult?.metrics ?? {};
  const row = { seed, decision: out.decision, evidence: Number(m.evidence ?? 0), brierTrained: Number(m.brierTrained ?? 1), brierFresh: Number(m.brierFresh ?? 1), checked: Number(m.checked ?? 0) };
  results.push(row);
  console.log(`  ${seed}: ${row.decision}  evidence=${row.evidence}  brier ${row.brierTrained} vs ${row.brierFresh} (n=${row.checked})`);
}

const promoted = results.filter((r) => r.decision === 'promote');
const evidences = results.map((r) => r.evidence);
const mean = evidences.reduce((s, x) => s + x, 0) / evidences.length;
const min = Math.min(...evidences);
// sign-test style: P(promote on >= k of N seeds) under the fair coin H0
const binomUpper = (k: number, n: number): number => {
  let p = 0;
  for (let j = k; j <= n; j++) {
    let c = 1;
    for (let i = 0; i < j; i++) c = (c * (n - i)) / (i + 1);
    p += c * Math.pow(0.5, n);
  }
  return Number(p.toFixed(4));
};
console.log(`\nSUMMARY: ${promoted.length}/${SEEDS} seeds promoted; evidence mean=${mean.toFixed(3)} min=${min.toFixed(3)}`);
if (promoted.length > 0) console.log(`sign-test one-sided p (fair-coin H0, >=${promoted.length} of ${SEEDS}): ${binomUpper(promoted.length, SEEDS)}`);
console.log(promoted.length === SEEDS && min >= 0.6
  ? 'VERDICT: split-robust across all seeds - the association is not split luck'
  : promoted.length > SEEDS / 2
    ? 'VERDICT: majority-promote but not split-robust - treat as promising, not proven'
    : 'VERDICT: split-luck territory - no robustness claim');
