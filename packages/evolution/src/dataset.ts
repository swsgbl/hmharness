/**
 * @hmharness/evolution - dataset (V2 M10: Trajectory → Dataset Version)
 * Pure data engineering, zero model calls. Pipeline per blueprint:
 *   Trajectory → Filter → Deduplicate → Label → Evidence Attach → Reward
 *   → Dataset Version → Train/Eval Split
 * Source of truth: HMH_HOME/runs/<run-id>/ (M1 trajectory recorder's
 * summary.json + trajectory.jsonl). Output: versioned, redacted, split
 * under evolution/datasets/<version>/. See ADR-0004.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from './insights.ts';

export interface DatasetSample {
  runId: string;
  task: string;
  outcome: string;
  turns: number;
  toolUses: number;
  toolFailRate: number;
  toolsUsed: string[];
  model: string;
  /** evidence rank from the M2 ladder when the run was evaluated (0 = none) */
  evidenceRank: number;
  /** interpretable reward in [0,1]; llm-judged runs never reach 1.0 (M2 cap) */
  reward: number;
  /** evaluation notes / failure snippets attach here (bounded) */
  evidence?: string;
  split: 'train' | 'eval';
}

export interface DatasetManifest {
  version: string;
  createdAt: string;
  /** inclusive run-id scan window (first..last seen, lexicographic) */
  runWindow: { first: string | null; last: string | null };
  filterFingerprint: string;
  splitSeed: number;
  splitRatio: number;
  counts: { scanned: number; kept: number; dropped: number; duplicates: number; train: number; eval: number };
  rewardHistogram: Record<string, number>;
}

export interface DatasetBuildResult {
  manifest: DatasetManifest;
  dir: string;
}

const RUNS_DIR = 'runs';

/** Interpretable reward mapping (ADR-0004): ok runs start at 1.0 and lose
 *  0.1 per 20% tool-failure rate; non-ok runs cap at 0.3. Evidence rank
 *  from the M2 ladder nudges confidence but never creates a free perfect. */
export function rewardFor(outcome: string, toolFailRate: number, evidenceRank = 0): number {
  let r: number;
  if (outcome === 'ok') {
    r = 1.0 - Math.min(0.6, Math.round(toolFailRate * 10) / 10);
  } else {
    r = Math.max(0, 0.3 - Math.round(toolFailRate * 10) / 10);
  }
  // llm-judge ladder ranks (5+) can never mint a perfect sample
  if (evidenceRank >= 5) r = Math.min(r, 0.7);
  return Math.max(0, Math.min(1, r));
}

/** Stable fingerprint of the filter config - manifest must be reproducible. */
export function filterFingerprint(opts: { keepOutcome?: string[]; minTurns?: number }): string {
  return createHash('sha256').update(JSON.stringify({
    keepOutcome: opts.keepOutcome ?? ['ok', 'turn-budget', 'error'],
    minTurns: opts.minTurns ?? 1,
    redact: true,
  })).digest('hex').slice(0, 12);
}

interface RunSummary {
  runId?: string;
  task?: string;
  model?: string;
  /** M1 recorder schema: outcome is an object {success, reason, error} */
  outcome?: string | { success?: boolean; reason?: string; error?: string };
  turns?: number;
  toolUses?: number;
  toolFailures?: number;
  toolsUsed?: string[];
  metrics?: { turns?: number; toolUses?: number; toolFailures?: number };
  evidence?: { rank?: number; detail?: string };
}

/** Normalize both the recorder schema (outcome object + metrics block) and
 *  the flat test/hand-written shape into one view. */
function normalizeSummary(s: RunSummary): {
  task: string; outcome: string; turns: number; toolUses: number;
  toolFailures: number; toolsUsed: string[]; model: string; rank: number; detail: string;
} {
  const outcome = typeof s.outcome === 'string'
    ? s.outcome
    : (s.outcome?.success ? 'ok' : String(s.outcome?.reason ?? ''));
  return {
    task: String(s.task ?? ''),
    outcome,
    turns: Number(s.turns ?? s.metrics?.turns ?? 0),
    toolUses: Number(s.toolUses ?? s.metrics?.toolUses ?? 0),
    toolFailures: Number(s.toolFailures ?? s.metrics?.toolFailures ?? 0),
    toolsUsed: s.toolsUsed ?? [],
    model: String(s.model ?? ''),
    rank: Number(s.evidence?.rank ?? 0),
    detail: String(s.evidence?.detail ?? ''),
  };
}

async function readRunSummaries(home: string): Promise<Array<{ runId: string; summary: RunSummary }>> {
  const root = join(home, RUNS_DIR);
  let ids: string[] = [];
  try { ids = (await readdir(root)).filter((d) => !d.startsWith('.')); } catch { return []; }
  ids.sort();
  const out: Array<{ runId: string; summary: RunSummary }> = [];
  for (const id of ids) {
    try {
      const s = JSON.parse(await readFile(join(root, id, 'summary.json'), 'utf8')) as RunSummary;
      out.push({ runId: id, summary: s });
    } catch { /* torn or absent summary - not a dataset candidate */ }
  }
  return out;
}

/** Deterministic hash-based split (same run always lands in the same half). */
export function splitFor(runId: string, seed: number, evalRatio = 0.2): 'train' | 'eval' {
  const h = createHash('sha256').update(`${seed}:${runId}`).digest();
  const v = h.readUInt32BE(0) / 0xffffffff;
  return v < evalRatio ? 'eval' : 'train';
}

export interface BuildDatasetOptions {
  version?: string;
  /** outcomes to keep; default keeps everything labeled */
  keepOutcome?: string[];
  minTurns?: number;
  evalRatio?: number;
  splitSeed?: number;
}

export async function buildDataset(home: string, opts: BuildDatasetOptions = {}): Promise<DatasetBuildResult> {
  const keep = opts.keepOutcome ?? ['ok', 'turn-budget', 'error'];
  const minTurns = opts.minTurns ?? 1;
  const evalRatio = opts.evalRatio ?? 0.2;
  const seed = opts.splitSeed ?? 20260913;
  const runs = await readRunSummaries(home);
  const fp = filterFingerprint({ keepOutcome: keep, minTurns });

  const byFingerprint = new Map<string, { runId: string; summary: RunSummary }>();
  let dropped = 0;
  let duplicates = 0;
  for (const { runId, summary } of runs) {
    const n = normalizeSummary(summary);
    if (!n.outcome || !keep.includes(n.outcome) || n.turns < minTurns) { dropped++; continue; }
    const fpRun = createHash('sha256').update(
      `${n.task}|${n.outcome}|${n.turns}|${n.toolsUsed.join(',')}`,
      'utf8',
    ).digest('hex').slice(0, 16);
    if (byFingerprint.has(fpRun)) { duplicates++; continue; } // keep first (oldest) - newest is a rerun of the same shape
    byFingerprint.set(fpRun, { runId, summary });
  }

  const samples: DatasetSample[] = [];
  const histogram: Record<string, number> = {};
  for (const { runId, summary } of byFingerprint.values()) {
    const n = normalizeSummary(summary);
    const failRate = n.toolUses > 0 ? n.toolFailures / n.toolUses : 0;
    const reward = rewardFor(n.outcome, failRate, n.rank);
    const bucket = reward.toFixed(1);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    samples.push({
      runId,
      task: redactSecrets(n.task),
      outcome: n.outcome,
      turns: n.turns,
      toolUses: n.toolUses,
      toolFailRate: Math.round(failRate * 100) / 100,
      toolsUsed: n.toolsUsed,
      model: n.model,
      evidenceRank: n.rank,
      reward,
      ...(n.detail ? { evidence: redactSecrets(n.detail).slice(0, 400) } : {}),
      split: splitFor(runId, seed, evalRatio),
    });
  }
  samples.sort((a, b) => (a.runId < b.runId ? -1 : 1));

  const version = opts.version ?? `v-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const dir = join(home, 'evolution', 'datasets', version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''), 'utf8');
  const manifest: DatasetManifest = {
    version,
    createdAt: new Date().toISOString(),
    runWindow: { first: runs[0]?.runId ?? null, last: runs[runs.length - 1]?.runId ?? null },
    filterFingerprint: fp,
    splitSeed: seed,
    splitRatio: evalRatio,
    counts: {
      scanned: runs.length,
      kept: samples.length,
      dropped,
      duplicates,
      train: samples.filter((s) => s.split === 'train').length,
      eval: samples.filter((s) => s.split === 'eval').length,
    },
    rewardHistogram: histogram,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, dir };
}

export async function listDatasets(home: string): Promise<DatasetManifest[]> {
  const root = join(home, 'evolution', 'datasets');
  let vers: string[] = [];
  try { vers = (await readdir(root)).filter((d) => d.startsWith('v-')); } catch { return []; }
  vers.sort();
  const out: DatasetManifest[] = [];
  for (const v of vers) {
    try { out.push(JSON.parse(await readFile(join(root, v, 'manifest.json'), 'utf8')) as DatasetManifest); } catch { /* skip torn */ }
  }
  return out;
}

export async function loadDataset(home: string, version: string, split?: 'train' | 'eval'): Promise<DatasetSample[]> {
  const file = join(home, 'evolution', 'datasets', version, 'samples.jsonl');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as DatasetSample)
    .filter((s) => !split || s.split === split);
}
