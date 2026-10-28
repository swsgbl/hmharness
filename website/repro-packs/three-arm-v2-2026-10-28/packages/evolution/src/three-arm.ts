/**
 * @hmharness/evolution - three-arm main experiment (Issue #22, P1, 2026-10-27)
 *
 * The question: does ONE persistable harness/skill change raise task
 * success under a FROZEN base model, without breaking the protection set?
 * Three arms, everything else pinned:
 *   A  Baseline          - the harness as-is (frozen skill-library snapshot)
 *   B  Task-adaptive     - per-task temporary adaptation block, discarded
 *                          after the task (built from TRAIN failures only)
 *   C  Persistent-evolved - the candidate skill, deployed only after passing
 *                          the real evolution gate, injected everywhere
 *
 * This module is the PURE core: task selection, judging, injection
 * building, and the pre-registered statistics. All model IO lives in the
 * driver scripts. The promotion gate thresholds are constants here so the
 * analysis cannot tune them after seeing results (pre-registration rule).
 */
import { createHash } from 'node:crypto';

/* ---------------- pre-registered constants (frozen before any run) ---------------- */

export const EXPERIMENT_ID = 'three-arm-main-experiment-2026-10-27';

/** Family quotas for the train subset. Families are the first '-' segment of
 *  the bench case id. toolchain-* and reply-determinism are excluded (they
 *  need the live toolchain, i.e. an unfreezable environment). */
export const FAMILY_QUOTAS: Record<string, number> = { beh: 8, cjk: 6, adv: 6, train: 6, fadv: 3, teach: 3 };
/** beh + behave-* are one family (both are read-file-then-answer cases). */
export const FAMILY_ALIASES: Record<string, string> = { behave: 'beh' };

export const SEEDS = [1, 2, 3] as const;
export const SHUFFLE_SEED_MATERIAL = EXPERIMENT_ID + ':exec-order';
/** gate split of the train subset: last 8 shuffled tasks become gate-val */
export const GATE_VAL_SIZE = 8;

/** Promotion gate (pre-registered; the task brief's suggested bars):
 *  significance = bootstrap 95% CI of the paired task-level diff excludes 0
 *  OR any per-seed exact McNemar p < 0.05 on the MAIN endpoint only
 *  (protect-set C-vs-A; the other three comparisons are exploratory).
 *  AND protect fallback <= 3pp, AND total-token growth <= 10%. */
export const GATE = {
  ciLevel: 0.95,
  mcnemarAlpha: 0.05,
  maxProtectFallback: 0.03,
  maxCostGrowth: 0.10,
  minTasksPerSplit: 15,
  minDiscordantCells: 8,
} as const;

/* ---------------- tasks ---------------- */

export interface ExperimentTask {
  id: string;
  prompt: string;
  /** the full original assertion spec (all modes) — judging input */
  assertion: { expect: string[]; expectExact?: string; expectRegex?: string; expectNone?: string[]; expectAny?: string[] };
  tools: boolean;
  holdout: boolean;
  split: 'train' | 'protect';
  family: string;
  /** sha256 of the original .task file bytes — content identity */
  fileSha: string;
}

export function familyOf(id: string): string {
  const seg = id.split('-')[0] ?? id;
  return FAMILY_ALIASES[seg] ?? seg;
}

/** Deterministic stratified selection: per family, seededOrder(quota). */
export function selectTasks(
  all: Array<{ id: string; holdout: boolean; tools: boolean }>,
  seed: number,
): { train: string[]; protect: string[]; excluded: Array<{ id: string; why: string }> } {
  const excluded: Array<{ id: string; why: string }> = [];
  const eligible: string[] = [];
  for (const c of all) {
    if (c.id.startsWith('toolchain-')) { excluded.push({ id: c.id, why: 'needs the live HarmonyOS toolchain (unfreezable environment)' }); continue; }
    if (c.id === 'reply-determinism') { excluded.push({ id: c.id, why: 'not in a sampled family' }); continue; }
    eligible.push(c.id);
  }
  const train: string[] = [];
  for (const [fam, quota] of Object.entries(FAMILY_QUOTAS)) {
    const pool = eligible.filter((id) => familyOf(id) === fam && !all.find((c) => c.id === id)?.holdout);
    const picked = seededOrderStr(pool, seed).slice(0, quota);
    if (picked.length < quota) excluded.push({ id: `(${fam} family)`, why: `only ${picked.length}/${quota} train cases available` });
    train.push(...picked);
  }
  train.sort();
  const protect = eligible.filter((id) => all.find((c) => c.id === id)?.holdout).sort();
  return { train, protect, excluded };
}

function seededOrderStr(items: string[], seed: number): string[] {
  // mulberry32 from a string seed — same contract as evalset.seededOrder
  let a = createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** datasetHash: sha256 over the canonical registered task set (tasks sorted
 *  by id; the FULL assertion spec serialized into evalset's assertion.expect
 *  so the hash is content-sensitive to every mode, not just the primary). */
export function buildTaskSetHash(tasks: ExperimentTask[]): { setId: string; datasetHash: string; canonical: string } {
  const rows = [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({ id: t.id, prompt: t.prompt, assertion: { kind: primaryKind(t), expect: JSON.stringify(t.assertion) }, holdout: t.split === 'protect' }));
  const canonical = JSON.stringify({ kind: 'hmharness-eval-taskset', version: 1, id: 'three-arm-2026-10-27', revision: 1, tasks: rows });
  return { setId: 'three-arm-2026-10-27', datasetHash: createHash('sha256').update(canonical).digest('hex'), canonical };
}

function primaryKind(t: ExperimentTask): 'expect-exact' | 'expect-regex' | 'expect-any' | 'expect-none' | 'expect' {
  if (t.assertion.expectExact) return 'expect-exact';
  if (t.assertion.expectRegex) return 'expect-regex';
  if (t.assertion.expectAny?.length) return 'expect-any';
  if (t.assertion.expectNone?.length) return 'expect-none';
  return 'expect';
}

/* ---------------- judging (environment-truth, never model self-report) ---------------- */

/** Same fence convention as bench.matchCase: assertions test the fenced
 *  inner body when the reply is a fenced block. Re-implemented here (not
 *  imported) so the judge is a self-contained, unit-testable unit. */
export function fenceInner(output: string): string {
  const m = output.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/);
  return m ? m[1]! : output;
}

export interface JudgeVerdict {
  pass: boolean;
  detail: string;
  /** claimed-done-but-failed: assertion failed AND the reply contains a
   *  completion marker (pre-registered false-completion definition) */
  falseCompletion: boolean;
}

const DONE_RE = /(已完成|完成|done|已处理|passed|成功)/i;

export function judgeOutput(output: string, t: Pick<ExperimentTask, 'assertion'>): JudgeVerdict {
  const body = fenceInner(output);
  const a = t.assertion;
  if (a.expectExact !== undefined && body.trim() !== a.expectExact.trim()) {
    return { pass: false, detail: `exact mismatch: got "${body.trim().slice(0, 80)}"`, falseCompletion: DONE_RE.test(body) };
  }
  if (a.expectRegex !== undefined) {
    try {
      if (!new RegExp(a.expectRegex).test(body)) return { pass: false, detail: `regex mismatch: /${a.expectRegex.slice(0, 60)}/`, falseCompletion: DONE_RE.test(body) };
    } catch {
      return { pass: false, detail: `invalid regex in case: ${a.expectRegex.slice(0, 40)}`, falseCompletion: false };
    }
  }
  if (a.expectNone && a.expectNone.some((e) => body.toLowerCase().includes(e.toLowerCase()))) {
    return { pass: false, detail: `forbidden marker present: ${a.expectNone.join(' && ')}`, falseCompletion: DONE_RE.test(body) };
  }
  if (a.expectAny && !a.expectAny.some((e) => body.toLowerCase().includes(e.toLowerCase()))) {
    return { pass: false, detail: `none of the allowed markers found: ${a.expectAny.join(' || ')}`, falseCompletion: DONE_RE.test(body) };
  }
  const missing = a.expect.filter((e) => !body.toLowerCase().includes(e.toLowerCase()));
  if (missing.length > 0) {
    return { pass: false, detail: `missing "${missing.join('" && "')}" in output`, falseCompletion: DONE_RE.test(body) };
  }
  return { pass: true, detail: 'ok', falseCompletion: false };
}

/* ---------------- arm injections ---------------- */

export interface SkillSnapshotEntry { name: string; description: string }

/** The A-arm / gate-baseline injection: the frozen skill-library snapshot
 *  (same shape as skills.skillsToPrompt). */
export function snapshotToPrompt(entries: SkillSnapshotEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}

/** The C-arm / gate-candidate injection: snapshot + the candidate draft,
 *  byte-identical in construction to evolve.ts's candidateInjection. */
export function candidateInjection(snapshot: SkillSnapshotEntry[], draftName: string, draftMd: string): string {
  const base = snapshotToPrompt(snapshot);
  const draftBlock = `## Draft skill under evaluation: ${draftName}\n\n${draftMd.slice(0, 4000)}`;
  return base ? `${base}\n${draftBlock}` : draftBlock;
}

export interface TaskLesson {
  taskId: string;
  promptHead: string;
  failedOutputHead: string;
  failureDetail: string;
}

/** The B-arm adaptation block: deterministic lessons from TRAIN-only null
 *  failures of the SAME family (never protect tasks — no leakage), max 3.
 *  Task-scoped by construction: the driver injects it into this task's
 *  system prompt only and drops it afterwards. */
export function buildAdaptiveBlock(family: string, lessons: TaskLesson[]): string {
  if (lessons.length === 0) return '';
  const lines = lessons.slice(0, 3).map((l, i) =>
    `${i + 1}. Task ${l.taskId} asked: "${l.promptHead}" — the attempt replied "${l.failedOutputHead}" and FAILED its assertion (${l.failureDetail}).`,
  );
  return [
    '## Task adaptation (temporary — this task only, not persisted)',
    `Lessons from failed attempts at similar tasks (family: ${family}):`,
    ...lines,
    'Apply the lesson: make the final reply satisfy exactly what the task asks for.',
  ].join('\n');
}

/* ---------------- record schema (one line per run) ---------------- */

export interface RunRecord {
  experimentId: string;
  repoCommit: string;
  datasetHash: string;
  baseModel: { provider: string; id: string; sampling: string };
  arm: 'A' | 'B' | 'C';
  seed: number;
  taskId: string;
  holdoutClass: 'train' | 'protect';
  outcome: { success: boolean | null; environmentDeltaHash: string };
  metrics: {
    cost: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; usd: null };
    wallMs: number;
    toolCalls: number;
    recoveries: number;
    crashes: number;
    falseCompletion: number;
    predictedP: number | null;
    brier: number | null;
  };
  safety: { backend: string; isolationLevel: string };
  decision: 'measured' | 'crash';
  reason: string;
}

/* ---------------- statistics ---------------- */

/** Exact two-sided binomial p (McNemar on discordant pairs). */
export function mcnemarExactP(aOnly: number, bOnly: number): { p: number; discordant: number } {
  const n = aOnly + bOnly;
  if (n === 0) return { p: 1, discordant: 0 };
  const k = Math.min(aOnly, bOnly);
  const logChoose = (nn: number, kk: number): number => {
    let s = 0;
    for (let i = 1; i <= kk; i++) s += Math.log(nn - kk + i) - Math.log(i);
    return s;
  };
  const pmf = (i: number) => Math.exp(logChoose(n, i) + i * Math.log(0.5) + (n - i) * Math.log(0.5));
  const pk = pmf(k);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= pk + 1e-12) sum += pmf(i);
  return { p: Math.min(1, Number(sum.toFixed(6))), discordant: n };
}

/** Deterministic bootstrap (seeded PRNG so the CI is reproducible) of the
 *  mean task-level paired difference. Analysis unit = task; each task's
 *  diff = mean over seeds of (armX success) − mean over seeds of (armY). */
export function bootstrapPairedCI(
  diffs: number[],
  opts: { level?: number; iters?: number; seed?: number } = {},
): { mean: number; ciLo: number; ciHi: number; width: number; nTasks: number } {
  const iters = opts.iters ?? 10_000;
  const level = opts.level ?? 0.95;
  let a = createHash('sha256').update(String(opts.seed ?? 0)).digest().readUInt32BE(0);
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rand() * diffs.length)]!;
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor(((1 - level) / 2) * iters)]!;
  const hi = means[Math.ceil((1 + level) / 2 * iters) - 1]!;
  return { mean: Number(mean.toFixed(4)), ciLo: Number(lo.toFixed(4)), ciHi: Number(hi.toFixed(4)), width: Number((hi - lo).toFixed(4)), nTasks: diffs.length };
}

export interface ComparisonResult {
  comparison: string;
  split: 'train' | 'protect';
  armX: 'A' | 'B' | 'C';
  armY: 'A' | 'B' | 'C';
  rateX: number;
  rateY: number;
  diff: number;
  bootstrap: ReturnType<typeof bootstrapPairedCI>;
  mcnemarPerSeed: Array<{ seed: number; p: number; discordant: number; xOnly: number; yOnly: number }>;
  discordantCells: number;
  significant: boolean;
  needsData: string[];
}

/** One arm-vs-arm comparison on one split. Records for the two arms must
 *  cover the same (seed, taskId) cells — the paired discipline. */
export function compareArms(records: RunRecord[], armX: 'A' | 'B' | 'C', armY: 'A' | 'B' | 'C', split: 'train' | 'protect'): ComparisonResult {
  const xs = new Map(records.filter((r) => r.arm === armX && r.holdoutClass === split && r.decision === 'measured').map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const ys = new Map(records.filter((r) => r.arm === armY && r.holdoutClass === split && r.decision === 'measured').map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const cellKeys = [...xs.keys()].filter((k) => ys.has(k));
  const byTask = new Map<string, { x: number[]; y: number[] }>();
  const mcnemarPerSeed: ComparisonResult['mcnemarPerSeed'] = [];
  for (const seed of SEEDS) {
    let xOnly = 0, yOnly = 0;
    for (const k of cellKeys) {
      const [s, task] = k.split(':');
      if (Number(s) !== seed) continue;
      const x = xs.get(k)!, y = ys.get(k)!;
      if (x && !y) xOnly++;
      else if (!x && y) yOnly++;
      const t = byTask.get(task) ?? { x: [], y: [] };
      t.x.push(x ? 1 : 0);
      t.y.push(y ? 1 : 0);
      byTask.set(task, t);
    }
    const { p, discordant } = mcnemarExactP(xOnly, yOnly);
    mcnemarPerSeed.push({ seed, p, discordant, xOnly, yOnly });
  }
  const diffs = [...byTask.values()].map((t) => avg(t.x) - avg(t.y));
  const rateX = cellKeys.filter((k) => xs.get(k)).length / Math.max(1, cellKeys.length);
  const rateY = cellKeys.filter((k) => ys.get(k)).length / Math.max(1, cellKeys.length);
  const bootstrap = bootstrapPairedCI(diffs, { level: GATE.ciLevel, seed: 42 });
  const discordantCells = mcnemarPerSeed.reduce((s, m) => s + m.discordant, 0);
  const needsData: string[] = [];
  if (diffs.length < GATE.minTasksPerSplit) needsData.push(`only ${diffs.length} paired tasks (<${GATE.minTasksPerSplit})`);
  if (discordantCells < GATE.minDiscordantCells) needsData.push(`only ${discordantCells} discordant cells (<${GATE.minDiscordantCells}) — exact test underpowered`);
  const significant = bootstrap.ciLo > 0 || bootstrap.ciHi < 0 || mcnemarPerSeed.some((m) => m.p < GATE.mcnemarAlpha);
  return {
    comparison: `${armX}-vs-${armY}`,
    split, armX, armY,
    rateX: Number(rateX.toFixed(4)), rateY: Number(rateY.toFixed(4)),
    diff: Number((rateX - rateY).toFixed(4)),
    bootstrap, mcnemarPerSeed, discordantCells, significant, needsData,
  };
}

function avg(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / xs.length; }

/** A-arm flip rate across seeds (the null/control variance estimate): share
 *  of tasks whose outcome is not identical across all null runs. */
export function nullFlux(records: RunRecord[], split: 'train' | 'protect'): { flipRate: number; tasks: number; flippedTaskIds: string[] } {
  const byTask = new Map<string, Set<boolean>>();
  for (const r of records) {
    if (r.arm !== 'A' || r.holdoutClass !== split) continue;
    const s = byTask.get(r.taskId) ?? new Set<boolean>();
    s.add(r.outcome.success === true);
    byTask.set(r.taskId, s);
  }
  const flipped = [...byTask.entries()].filter(([, s]) => s.size > 1).map(([id]) => id);
  return { flipRate: byTask.size ? Number((flipped.length / byTask.size).toFixed(4)) : 0, tasks: byTask.size, flippedTaskIds: flipped.sort() };
}

/** The pre-registered promotion gate over the analysis inputs. */
export function evaluateGate(main: ComparisonResult, protectFallback: number, costRatioGrowth: number): { verdict: 'PROMOTE' | 'REJECT' | 'NEEDS-DATA'; gates: Array<{ name: string; pass: boolean; detail: string }>; reason: string } {
  const gates: Array<{ name: string; pass: boolean; detail: string }> = [];
  const supportOK = main.needsData.length === 0;
  gates.push({ name: 'significance (95% CI excludes 0 OR exact McNemar p<0.05)', pass: main.significant && supportOK, detail: `CI=[${main.bootstrap.ciLo},${main.bootstrap.ciHi}] diff=${main.diff}; McNemar per seed: ${main.mcnemarPerSeed.map((m) => `p=${m.p}`).join(', ')}` });
  gates.push({ name: `protect fallback <= ${(GATE.maxProtectFallback * 100).toFixed(0)}pp`, pass: protectFallback >= -GATE.maxProtectFallback, detail: `protect diff (C-A) = ${protectFallback}` });
  gates.push({ name: `cost growth <= ${(GATE.maxCostGrowth * 100).toFixed(0)}%`, pass: costRatioGrowth <= GATE.maxCostGrowth, detail: `token growth = ${(costRatioGrowth * 100).toFixed(2)}%` });
  const allPass = gates.every((g) => g.pass);
  const verdict = !supportOK ? 'NEEDS-DATA' : allPass ? 'PROMOTE' : 'REJECT';
  return { verdict, gates, reason: supportOK ? gates.filter((g) => !g.pass).map((g) => `${g.name}: ${g.detail}`).join('; ') || 'all gates passed' : `low support: ${main.needsData.join('; ')}` };
}
