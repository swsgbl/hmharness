/**
 * @hmharness/evolution - reward-model (V3 RL phase, ADR-0010)
 * A LEARNED reward model over run features, fit on the human star labels -
 * the blueprint's "Reward -> RL" step after the M11 gate opened.
 *
 * Design (grounded in the Agent Lightning lesson: the app defines the task
 * and the reward; the harness already produces rollouts):
 *  - features are what the harness already measures per session: outcome
 *    bucket, tool-failure rate, turns, tool uses (all z-free, reproducible)
 *  - the model is a tiny logistic regressor (zero deps, deterministic
 *    gradient descent) predicting the HUMAN score in [0,1]
 *  - the calibrated outcome-based reward (Spearman 0.981 vs human) is the
 *    prior; the learned model adds the fine, in-bucket distinctions the
 *    outcome signal cannot see (4-star vs 5-star runs)
 *  - weights persist to HMH_HOME/evolution/reward-model.json; refit as
 *    labels accumulate
 *
 * What this is NOT: a fine-tuned LLM. The blueprint explicitly defers
 * model fine-tuning; DPO pairs for an external trainer are exported
 * separately (exportDpoPairs).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HumanLabel } from './labels.ts';

export type { HumanLabel };

export interface RewardFeatures {
  /** outcome bucket: 2=ok, 1=turn-budget, 0=error */
  outcome: number;
  /** failed tool calls / total tool calls, 0..1 */
  toolFailRate: number;
  /** agent turns used, raw count */
  turns: number;
  /** tool calls issued, raw count */
  toolUses: number;
}

export interface RewardWeights {
  /** logistic weights over [outcome, toolFailRate, log1p(turns), log1p(toolUses), bias] */
  w: [number, number, number, number, number];
  trainedAt: string;
  nSamples: number;
  trainRmse: number;
  /** holdout RMSE when n >= 20 (80/20 split, deterministic) */
  holdoutRmse?: number;
}

const FEATURES: Array<(f: RewardFeatures) => number> = [
  (f) => f.outcome / 2,                    // 0..1
  (f) => f.toolFailRate,                   // 0..1
  (f) => Math.log1p(Math.min(f.turns, 200)) / Math.log(201),   // 0..1
  (f) => Math.log1p(Math.min(f.toolUses, 200)) / Math.log(201), // 0..1
];

function x(f: RewardFeatures): number[] {
  return [...FEATURES.map((fn) => fn(f)), 1];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Deterministic 80/20 split by index (no RNG - reproducible fits). */
function split<T>(rows: T[]): { train: T[]; hold: T[] } {
  const train: T[] = [];
  const hold: T[] = [];
  rows.forEach((r, i) => (i % 5 === 4 ? hold : train).push(r));
  return { train, hold };
}

function fitLinear(
  rows: Array<{ f: RewardFeatures; y: number }>,
  epochs = 4000,
  lr = 0.05,
  l2 = 0.01,
): number[] {
  const d = 5;
  let w = new Array(d).fill(0);
  const xs = rows.map((r) => x(r.f));
  if (xs.length === 0) return w;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(d).fill(0);
    for (let i = 0; i < rows.length; i++) {
      let z = 0;
      for (let k = 0; k < d; k++) z += w[k] * xs[i][k];
      const err = sigmoid(z) - rows[i].y; // logistic loss gradient
      for (let k = 0; k < d; k++) grad[k] += err * xs[i][k];
    }
    for (let k = 0; k < d; k++) w[k] -= lr * (grad[k] / rows.length + l2 * w[k]);
  }
  return w;
}

function rmse(w: number[], rows: Array<{ f: RewardFeatures; y: number }>): number {
  if (rows.length === 0) return 0;
  let s = 0;
  for (const r of rows) {
    let z = 0;
    const xv = x(r.f);
    for (let k = 0; k < w.length; k++) z += w[k] * xv[k];
    s += (sigmoid(z) - r.y) ** 2;
  }
  return Math.sqrt(s / rows.length);
}

/** Human label record: re-used from labels.ts (single source). */
/** Insight record fields the model joins on. */
export interface InsightLike {
  session: string;
  outcome: string;
  turns?: number;
  toolUses?: number;
}

/** Join labels with insights and map to training rows. Pure - testable. */
export function trainingRows(labels: HumanLabel[], insights: InsightLike[]): Array<{ f: RewardFeatures; y: number; session: string }> {
  const bySession = new Map<string, InsightLike>();
  for (const i of insights) if (!bySession.has(i.session)) bySession.set(i.session, i);
  const rows: Array<{ f: RewardFeatures; y: number; session: string }> = [];
  for (const l of labels) {
    const ins = bySession.get(l.session);
    if (!ins) continue;
    const uses = Number(ins.toolUses ?? 0);
    const outcome = ins.outcome === 'ok' ? 2 : ins.outcome === 'turn-budget' ? 1 : 0;
    rows.push({
      f: { outcome, toolFailRate: 0, turns: Number(ins.turns ?? 0), toolUses: uses },
      y: l.score / 5,
      session: l.session,
    });
  }
  return rows;
}

/** Fit the reward model on joined human labels. Deterministic. */
export function fitRewardModel(labels: HumanLabel[], insights: InsightLike[]): RewardWeights {
  const rows = trainingRows(labels, insights);
  const { train, hold } = split(rows);
  const w = fitLinear(train);
  return {
    w: w as RewardWeights['w'],
    trainedAt: new Date().toISOString(),
    nSamples: rows.length,
    trainRmse: Number(rmse(w, train).toFixed(4)),
    ...(hold.length >= 4 ? { holdoutRmse: Number(rmse(w, hold).toFixed(4)) } : {}),
  };
}

/** Score a run's features with fitted weights -> reward in [0,1]. */
export function scoreFeatures(w: RewardWeights['w'], f: RewardFeatures): number {
  const xv = x(f);
  let z = 0;
  for (let k = 0; k < w.length; k++) z += w[k] * xv[k];
  return sigmoid(z);
}

/** Persistence: HMH_HOME/evolution/reward-model.json. */
export async function saveRewardModel(home: string, m: RewardWeights): Promise<void> {
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'reward-model.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');
}

export async function loadRewardModel(home: string): Promise<RewardWeights | null> {
  try {
    return JSON.parse(await readFile(join(home, 'evolution', 'reward-model.json'), 'utf8')) as RewardWeights;
  } catch {
    return null;
  }
}

/** DPO preference pair for external fine-tuning. */
export interface DpoPair {
  prompt: string;
  chosen: string;
  rejected: string;
  /** provenance for auditability */
  chosenSession: string;
  rejectedSession: string;
  gap: number;
  /** preference provenance: who graded the sides (J1) - training data
   *  consumers must be able to tell human preference from judge preference */
  source?: 'human' | 'judge' | 'mixed';
}

/** Build DPO pairs from joined labels + insights. Two classes:
 *  (a) IN-BUCKET (gold): same outcome, >=2 star gap - human preference the
 *      outcome reward cannot see (4-vs-5 star distinctions);
 *  (b) CROSS-BUCKET (classic): ok-vs-degraded completions of the SAME task
 *      template (task prefix match) - the textbook chosen/rejected pair.
 *  Pure - testable. */
export function exportDpoPairs(
  labels: HumanLabel[],
  insights: InsightLike[],
  taskOf: (session: string) => string,
  answerOf: (session: string) => string,
  opts: { minInBucketGap?: number; crossBucketPrefix?: number; sources?: Map<string, 'human' | 'judge'> } = {},
): DpoPair[] {
  const minGap = opts.minInBucketGap ?? 0.4;
  const prefixLen = opts.crossBucketPrefix ?? 60;
  const rows = trainingRows(labels, insights);
  const insOf = new Map(insights.map((i) => [i.session, i]));
  const pairs: DpoPair[] = [];
  for (const a of rows) {
    for (const b of rows) {
      if (a.session >= b.session) continue;
      // round: 3/5 - 1/5 = 0.39999999999999997 in floats, and the epsilon
      // silently ate every 2-step in-bucket pair (★1 vs ★3) - the judge's
      // whole variance band
      // abs: rows iterate in label-file order - the lower score can come first
      // (judge labels do), which made a.y - b.y negative and silently dropped
      // the pair; rounding kills the 3/5-1/5 float epsilon
      const gap = Math.round(Math.abs(a.y - b.y) * 1000) / 1000;
      if (gap < minGap) continue;
      const hi = gap > 0 ? a : b;
      const lo = gap > 0 ? b : a;
      const hiIns = insOf.get(hi.session);
      const loIns = insOf.get(lo.session);
      if (!hiIns || !loIns) continue;
      const sameOutcome = hiIns.outcome === loIns.outcome;
      let ok = false;
      if (sameOutcome) {
        ok = true; // in-bucket gold
      } else {
        // cross-bucket: only pair completions of the SAME task template
        // (bench templates share long prefixes) - otherwise they teach
        // nothing transferable
        const ta = taskOf(hi.session);
        const tb = taskOf(lo.session);
        ok = ta.length >= prefixLen && ta.slice(0, prefixLen) === tb.slice(0, prefixLen);
      }
      if (!ok) continue;
      const srcHi = opts.sources?.get(hi.session);
      const srcLo = opts.sources?.get(lo.session);
      pairs.push({
        prompt: taskOf(hi.session),
        chosen: answerOf(hi.session),
        rejected: answerOf(lo.session),
        chosenSession: hi.session,
        rejectedSession: lo.session,
        gap: Number(gap.toFixed(2)),
        ...(srcHi && srcLo ? { source: srcHi === srcLo ? srcHi : 'mixed' } : {}),
      });
    }
  }
  return pairs;
}

/* ---------------- DPO dataset form (J1 follow-up) ---------------- */

/** Deterministic zero-dep FNV-1a - the split must not reshuffle between
 *  runs: a pair that was in eval yesterday must stay in eval today. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic ~80/20 split BY PROMPT (group split): bench templates
 *  mint many pairs per prompt, and a pair-level split leaked ~4.9k eval
 *  prompts into train (audit 2026-09-21) - every pair of one prompt must
 *  land on the same side or offline metrics are inflated. Pure. */
export function splitDpoPairs(pairs: DpoPair[], salt = 'dpo'): { train: DpoPair[]; eval: DpoPair[] } {
  const train: DpoPair[] = [];
  const evalP: DpoPair[] = [];
  for (const p of pairs) {
    (fnv1a(salt + '|' + p.prompt) % 5 === 0 ? evalP : train).push(p);
  }
  return { train, eval: evalP };
}

/** Exact-duplicate removal (same prompt+chosen+rejected): the 5-star army
 *  against the same few degraded sessions minted 11k+ permutation copies
 *  (audit 2026-09-21) - training would just over-weight those templates.
 *  Keeps the first occurrence (deterministic). Pure. */
export function dedupeDpoPairs(pairs: DpoPair[]): DpoPair[] {
  const seen = new Set<string>();
  const out: DpoPair[] = [];
  for (const p of pairs) {
    const key = p.prompt + '\u0000' + p.chosen + '\u0000' + p.rejected;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Leakage/quality audit before training consumes the pairs: empty sides,
 *  exact duplicates, and eval pairs whose prompt ALSO appears in train
 *  (prompt leakage inflates offline metrics). Pure. */
export function auditDpoPairs(train: DpoPair[], evalP: DpoPair[]): { emptyPrompt: number; emptyAnswer: number; duplicatePairs: number; evalPromptsLeakedIntoTrain: number } {
  let emptyPrompt = 0, emptyAnswer = 0;
  const seen = new Set<string>();
  let duplicatePairs = 0;
  for (const p of [...train, ...evalP]) {
    if (!p.prompt.trim()) emptyPrompt++;
    if (!p.chosen.trim() || !p.rejected.trim()) emptyAnswer++;
    const key = p.prompt + '\u0000' + p.chosen + '\u0000' + p.rejected;
    if (seen.has(key)) duplicatePairs++;
    else seen.add(key);
  }
  const trainPrompts = new Set(train.map((p) => p.prompt));
  let evalPromptsLeakedIntoTrain = 0;
  for (const p of evalP) if (trainPrompts.has(p.prompt)) evalPromptsLeakedIntoTrain++;
  return { emptyPrompt, emptyAnswer, duplicatePairs, evalPromptsLeakedIntoTrain };
}

/** The versioned manifest written beside the exported pairs file - the
 *  dataset's birth certificate: counts by source, split sizes, audit. */
export interface DpoManifest {
  version: string;
  pairsTotal: number;
  bySource: Record<string, number>;
  train: number;
  eval: number;
  audit: ReturnType<typeof auditDpoPairs>;
  exportedAt: string;
}
