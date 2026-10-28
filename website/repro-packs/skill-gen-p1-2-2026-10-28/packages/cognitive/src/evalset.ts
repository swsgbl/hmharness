/**
 * @hmharness/cognitive - versioned eval task sets (2026-10-04 audit EVAL-IND)
 *
 * The audit's verdict on benchmarks: "framework, not corpus" — runs could
 * not pin WHICH tasks they ran, in what order, or which were holdout.
 * This module is the missing discipline:
 *
 *   EvalTaskSet   a versioned, hash-pinned task set. The dataset hash is
 *                sha256 over the CANONICAL form (tasks sorted by id), so
 *                set identity is order-independent and content-sensitive.
 *   seededOrder   deterministic task order from an explicit seed — the same
 *                seed always produces the same order (zero-dep PRNG).
 *   holdout gate  holdout tasks may never appear in a train-side arm
 *                report; reports carry the split they used.
 *   EvalRunReport an evaluation run that NAMES its datasetHash + seed +
 *                split — two reports are comparable ONLY when all three
 *                match (comparing across datasets is the classic
 *                apples-to-oranges self-evaluation failure).
 */
import { createHash } from 'node:crypto';

/* ---------------- task set ---------------- */

export interface EvalTask {
  id: string;
  prompt: string;
  /** assertion spec resolved by the host evaluator (expect-exact/regex/none/any) */
  assertion: { kind: 'expect-exact' | 'expect-regex' | 'expect-none' | 'expect-any'; expect: string };
  /** true = holdout: promotion gates may never train on it */
  holdout?: boolean;
}

export interface EvalTaskSet {
  kind: 'hmharness-eval-taskset';
  version: 1;
  /** stable set id (e.g. 'generALBench-core'); content changes bump revision */
  id: string;
  revision: number;
  createdAt: string;
  tasks: EvalTask[];
}

/** Canonical JSON: tasks sorted by id, key order fixed — the hash basis. */
export function canonicalTaskSet(set: Omit<EvalTaskSet, 'createdAt'> & { createdAt?: string }): string {
  const tasks = [...set.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ kind: set.kind, version: set.version, id: set.id, revision: set.revision, tasks: tasks.map((t) => ({ id: t.id, prompt: t.prompt, assertion: t.assertion, holdout: t.holdout === true })) });
}

/** sha256 over the canonical form — order-independent, content-sensitive. */
export function datasetHash(set: Omit<EvalTaskSet, 'createdAt'> & { createdAt?: string }): string {
  return createHash('sha256').update(canonicalTaskSet(set)).digest('hex');
}

/* ---------------- deterministic order ---------------- */

/** Zero-dep PRNG (mulberry32) — same seed, same sequence, everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic shuffle: same (tasks, seed) -> same order. */
export function seededOrder<T>(items: T[], seed: number): T[] {
  const rand = seededRandom(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Stable seed from a string (dataset id + explicit seed material). */
export function seedFromString(s: string): number {
  const h = createHash('sha256').update(s).digest();
  return h.readUInt32BE(0);
}

/* ---------------- holdout gate ---------------- */

export interface EvalSplit {
  train: EvalTask[];
  holdout: EvalTask[];
}

export function splitSet(set: EvalTaskSet): EvalSplit {
  return {
    train: set.tasks.filter((t) => !t.holdout),
    holdout: set.tasks.filter((t) => t.holdout === true),
  };
}

/** The discipline gate: a train-side arm must contain ZERO holdout task ids. */
export function holdoutDisciplineOK(armTaskIds: string[], split: EvalSplit): { ok: boolean; violations: string[] } {
  const holdoutIds = new Set(split.holdout.map((t) => t.id));
  const violations = armTaskIds.filter((id) => holdoutIds.has(id));
  return { ok: violations.length === 0, violations };
}

/* ---------------- run report ---------------- */

export interface EvalRunReport {
  kind: 'hmharness-eval-run';
  version: 1;
  datasetHash: string;
  setId: string;
  revision: number;
  seed: number;
  split: 'train' | 'holdout';
  arm: string;
  perTask: Array<{ id: string; pass: boolean }>;
  passed: number;
  total: number;
  finishedAt: string;
}

/** Two reports are comparable ONLY when datasetHash + seed + split match. */
export function reportsComparable(a: EvalRunReport, b: EvalRunReport): boolean {
  return a.datasetHash === b.datasetHash && a.seed === b.seed && a.split === b.split;
}

/** Build a report from a run (the host provides per-task pass flags). */
export function buildRunReport(set: EvalTaskSet, opts: { seed: number; split: 'train' | 'holdout'; arm: string; perTask: Array<{ id: string; pass: boolean }> }): EvalRunReport {
  const split = splitSet(set);
  const allowed = opts.split === 'train' ? split.train : split.holdout;
  const allowedIds = new Set(allowed.map((t) => t.id));
  // a report may ONLY contain tasks from its declared split
  const perTask = opts.perTask.filter((r) => allowedIds.has(r.id));
  if (perTask.length !== opts.perTask.length) {
    throw new Error(`report contains ${opts.perTask.length - perTask.length} task(s) outside the declared '${opts.split}' split — refuse to build a mislabeled report`);
  }
  return {
    kind: 'hmharness-eval-run',
    version: 1,
    datasetHash: datasetHash(set),
    setId: set.id,
    revision: set.revision,
    seed: opts.seed,
    split: opts.split,
    arm: opts.arm,
    perTask,
    passed: perTask.filter((r) => r.pass).length,
    total: perTask.length,
    finishedAt: new Date().toISOString(),
  };
}

/* ---------------- paired statistical test (the audit's 统计检验) ---------------- */

/** exact two-sided binomial p-value: P(X <= k) + P(X >= n-k) mirrored, n small */
function binomTwoSidedP(n: number, k: number, p = 0.5): number {
  const logChoose = (a: number, b: number): number => {
    let s = 0;
    for (let i = 1; i <= b; i++) s += Math.log(a - b + i) - Math.log(i);
    return s;
  };
  const pmf = (i: number): number => Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  // observed tail + opposite tail at least as extreme (classic exact method)
  const pk = pmf(k);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= pk + 1e-12) sum += pmf(i);
  return Math.min(1, Number(sum.toFixed(6)));
}

export interface SignificanceVerdict {
  /** comparable precondition failed? then NOTHING else is filled */
  comparable: boolean;
  refusalReason?: string;
  /** discordant pairs: only tasks where the two arms DISAGREE carry signal */
  discordant: { armOnlyPassed: number; armBPassed: number; agreed: number };
  /** exact McNemar two-sided p-value over the discordant pairs */
  pValue?: number;
  significant?: boolean;
  /** the audit discipline: a fixed alpha, stated on every verdict */
  alpha: 0.05;
}

/**
 * McNemar exact test for two PAIRED arms on the same task set. Refuses
 * non-comparable reports outright (datasetHash+seed+split must all match);
 * significance = discordant pairs are lopsided enough that a fair coin
 * would rarely produce them (exact binomial, no normal approximation —
 * eval sets are small). This is the 统计检验 the audit demanded so a
 * "7/10 vs 5/10" delta can never again be read as an effect.
 */
export function pairedSignificance(a: EvalRunReport, b: EvalRunReport): SignificanceVerdict {
  if (!reportsComparable(a, b)) {
    return {
      comparable: false,
      refusalReason: `reports are not comparable (datasetHash/seed/split must all match; got ${a.setId}@r${a.revision} seed ${a.seed} ${a.split} vs ${b.setId}@r${b.revision} seed ${b.seed} ${b.split})`,
      discordant: { armOnlyPassed: 0, armBPassed: 0, agreed: 0 },
      alpha: 0.05,
    };
  }
  const bBy = new Map(b.perTask.map((r) => [r.id, r.pass]));
  let armOnlyPassed = 0;
  let armBPassed = 0;
  let agreed = 0;
  for (const t of a.perTask) {
    const other = bBy.get(t.id);
    if (other === undefined) continue; // unpaired task carries no signal
    if (t.pass && !other) armOnlyPassed += 1;
    else if (!t.pass && other) armBPassed += 1;
    else agreed += 1;
  }
  const n = armOnlyPassed + armBPassed;
  if (n === 0) {
    return { comparable: true, discordant: { armOnlyPassed, armBPassed, agreed }, pValue: 1, significant: false, alpha: 0.05 };
  }
  const pValue = binomTwoSidedP(n, Math.min(armOnlyPassed, armBPassed));
  return {
    comparable: true,
    discordant: { armOnlyPassed, armBPassed, agreed },
    pValue,
    significant: pValue < 0.05,
    alpha: 0.05,
  };
}
