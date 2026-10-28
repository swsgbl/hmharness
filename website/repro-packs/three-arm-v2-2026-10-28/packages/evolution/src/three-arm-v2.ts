/**
 * @hmharness/evolution - three-arm v2: expanded-sample rerun (2026-10-28).
 *
 * Continuation of three-arm-main-experiment-2026-10-27 (verdict NEEDS-DATA).
 * v2 changes over v1, frozen BEFORE any run (the v1 REPORT §六 next-step):
 *   1. GEPA-style candidate POPULATION: phase-0 TRAIN failures are typed by
 *      failure class; each class proposes its own candidates (2 per class),
 *      and the WHOLE population enters the same real evolution gate.
 *   2. Expanded sample: protect set 23 -> 69 tasks (23 existing hmb holdouts +
 *      the 46 offline-judgeable HarmonyBench v1.0.0 cases), seeds 3 -> 5.
 *   3. Everything else - gate thresholds, statistics protocol, cArmRule,
 *      crashRule, arm construction - is inherited from v1 verbatim.
 *
 * Pure core again: constants, failure typing, HarmonyBench task mapping,
 * seeds-parameterized statistics. All model IO stays in the driver scripts.
 */
import { createHash } from 'node:crypto';
import {
  GATE, mcnemarExactP, bootstrapPairedCI, type ExperimentTask, type RunRecord, type ComparisonResult,
} from './three-arm.ts';

export const EXPERIMENT_ID_V2 = 'three-arm-v2-2026-10-28';

/** Seeds 3 -> 5 (the v1 report's power recommendation). */
export const SEEDS_V2 = [1, 2, 3, 4, 5] as const;

/** Promotion gate: same bars as v1 (inherited by value, not by reference to
 *  keep the v1 module frozen for its own reproduction). */
export const GATE_V2 = GATE;

/** Execution-order shuffle material (per-seed). */
export const SHUFFLE_SEED_MATERIAL_V2 = EXPERIMENT_ID_V2 + ':exec-order';

/* ---------------- protect-set expansion (hmb + HarmonyBench) ---------------- */

/** The shape the evaluation package's HarmonyBench cases are read into. */
export interface HarmonyBenchSourceCase {
  id: string;
  prompt: string;
  assertion: { type: 'exact' | 'contains' | 'not_contains' | 'regex'; value: string };
  category: string;
  needsTools: boolean;
}

/** Serialize a HarmonyBench case into the bench .task format so the protect
 *  copy on disk is byte-identical to what fileSha/datasetHash were built
 *  from (deterministic, single source of truth for its bytes). expect-exact
 *  is written UNQUOTED: the .task parser strips only surrounding quotes, so
 *  quoting a value that itself contains quotes would break the round-trip. */
export function harmonyBenchTaskBytes(c: HarmonyBenchSourceCase): string {
  const lines = [c.prompt];
  if (c.assertion.type === 'exact') lines.push(`expect-exact: ${c.assertion.value}`);
  else if (c.assertion.type === 'regex') lines.push(`expect-regex: ${c.assertion.value}`);
  else if (c.assertion.type === 'contains') lines.push(`expect: ${c.assertion.value}`);
  else lines.push(`expect-none: ${c.assertion.value}`);
  lines.push('holdout: true');
  return lines.join('\n') + '\n';
}

/** Map one HarmonyBench case to an experiment protect task. Returns null for
 *  needsTools cases: the experiment's frozen tool whitelist (read_file /
 *  list_dir) cannot serve them — same exclusion rationale as v1's
 *  toolchain-* cases (unfreezable environment), pre-registered here. */
export function harmonyBenchToTask(c: HarmonyBenchSourceCase): ExperimentTask | null {
  if (c.needsTools) return null;
  const raw = harmonyBenchTaskBytes(c);
  return {
    id: `hb-${c.id}`,
    prompt: c.prompt,
    assertion:
      c.assertion.type === 'exact' ? { expect: [], expectExact: c.assertion.value }
      : c.assertion.type === 'regex' ? { expect: [], expectRegex: c.assertion.value }
      : c.assertion.type === 'contains' ? { expect: [c.assertion.value] }
      : { expect: [], expectNone: [c.assertion.value] },
    tools: false,
    holdout: true,
    split: 'protect',
    family: `hb-${c.category}`,
    fileSha: createHash('sha256').update(raw).digest('hex'),
  };
}

/* ---------------- failure typing (GEPA population input) ---------------- */

/** Failure classes for candidate generation. Deterministic on (task, record):
 *  judge detail prefixes + the toolCalls signal. Empirical anchor from v1
 *  phase-0: the only beh failure (beh-t8-n) had toolCalls=0 — the model
 *  answered without reading the file it was told to read. */
export type FailureClass = 'exact-output' | 'format' | 'content-marker' | 'tool-use' | 'forbidden';

export const FAILURE_CLASSES: readonly FailureClass[] = ['exact-output', 'format', 'content-marker', 'tool-use', 'forbidden'];

export function classifyFailure(
  task: Pick<ExperimentTask, 'tools'>,
  r: Pick<RunRecord, 'reason'> & { outcome: { success: boolean | null }; metrics: { toolCalls: number } },
): FailureClass | null {
  if (r.outcome.success === true) return null;
  // a tools-required task that never called a tool: answered from nothing
  if (task.tools && r.metrics.toolCalls === 0) return 'tool-use';
  const d = r.reason;
  if (d.startsWith('exact mismatch')) return 'exact-output';
  if (d.startsWith('regex mismatch')) return 'format';
  if (d.startsWith('missing')) return 'content-marker';
  if (d.startsWith('none of the allowed markers')) return 'content-marker';
  if (d.startsWith('forbidden marker')) return 'forbidden';
  // tools tasks that DID call tools but still failed an exact/marker check
  if (task.tools) return 'tool-use';
  return 'exact-output';
}

/* ---------------- population rule (pre-registered) ---------------- */

export const POPULATION_RULE = {
  perClassCandidates: 2,
  classSelection: 'classes ordered by distinct failed-task count (desc), tie by class name; top classes taken, all with >=1 failed task eligible',
  maxClasses: FAILURE_CLASSES.length,
  minTasksPerClassPrompt: 1,
  gate: 'the whole population enters ONE runEvolution call as presetProposals with maxProposals = population size; thresholds unchanged (quality floor 0.6, zero bench regression, double sampling, holdout re-verification, cost cap)',
  cArmPick: 'if any candidate is promoted: deploy the one with the highest gate train pass rate; tie broken by lexicographically smallest name (deterministic, pre-registered)',
  allRejected: 'population fully rejected => C arm not deployable, main endpoint NEEDS-DATA (honest outcome, same as v1 cArmRule)',
} as const;

/* ---------------- datasetHash (v2 canonical) ---------------- */

export function buildTaskSetHashV2(tasks: ExperimentTask[]): { setId: string; datasetHash: string; canonical: string } {
  const primaryKind = (t: ExperimentTask): string =>
    t.assertion.expectExact !== undefined ? 'expect-exact'
    : t.assertion.expectRegex !== undefined ? 'expect-regex'
    : t.assertion.expectAny?.length ? 'expect-any'
    : t.assertion.expectNone?.length ? 'expect-none'
    : 'expect';
  const rows = [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({ id: t.id, prompt: t.prompt, assertion: { kind: primaryKind(t), expect: JSON.stringify(t.assertion) }, holdout: t.split === 'protect' }));
  const canonical = JSON.stringify({ kind: 'hmharness-eval-taskset', version: 1, id: 'three-arm-v2-2026-10-28', revision: 1, tasks: rows });
  return { setId: 'three-arm-v2-2026-10-28', datasetHash: createHash('sha256').update(canonical).digest('hex'), canonical };
}

/* ---------------- statistics (v1 protocol, seeds parameterized) ---------------- */

/** compareArms with the seed list as a parameter (v1 hardcodes [1,2,3]; the
 *  bootstrap/McNemar/gate logic is byte-for-byte the v1 protocol). */
export function compareArmsV2(
  records: RunRecord[],
  armX: 'A' | 'B' | 'C',
  armY: 'A' | 'B' | 'C',
  split: 'train' | 'protect',
  seeds: readonly number[] = SEEDS_V2,
): ComparisonResult {
  const xs = new Map(records.filter((r) => r.arm === armX && r.holdoutClass === split && r.decision === 'measured').map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const ys = new Map(records.filter((r) => r.arm === armY && r.holdoutClass === split && r.decision === 'measured').map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const cellKeys = [...xs.keys()].filter((k) => ys.has(k));
  const byTask = new Map<string, { x: number[]; y: number[] }>();
  const mcnemarPerSeed: ComparisonResult['mcnemarPerSeed'] = [];
  for (const seed of seeds) {
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
  const bootstrap = bootstrapPairedCI(diffs, { level: GATE_V2.ciLevel, seed: 42 });
  const discordantCells = mcnemarPerSeed.reduce((s, m) => s + m.discordant, 0);
  const needsData: string[] = [];
  if (diffs.length < GATE_V2.minTasksPerSplit) needsData.push(`only ${diffs.length} paired tasks (<${GATE_V2.minTasksPerSplit})`);
  if (discordantCells < GATE_V2.minDiscordantCells) needsData.push(`only ${discordantCells} discordant cells (<${GATE_V2.minDiscordantCells}) — exact test underpowered`);
  const significant = bootstrap.ciLo > 0 || bootstrap.ciHi < 0 || mcnemarPerSeed.some((m) => m.p < GATE_V2.mcnemarAlpha);
  return {
    comparison: `${armX}-vs-${armY}`,
    split, armX, armY,
    rateX: Number(rateX.toFixed(4)), rateY: Number(rateY.toFixed(4)),
    diff: Number((rateX - rateY).toFixed(4)),
    bootstrap, mcnemarPerSeed, discordantCells, significant, needsData,
  };
}

function avg(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / xs.length; }
