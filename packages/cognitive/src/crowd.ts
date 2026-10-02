/**
 * @hmharness/cognitive - crowd loop (federated-by-file first slice)
 *
 * The self-evolution loop is local-first: every user's world model, skills
 * and calibration live in THEIR HMH_HOME and nothing phones home. This
 * module is the privacy-safe bridge for users who WANT to contribute:
 *
 *   crowdSummary(): an anonymous, content-free aggregate of the local
 *     trajectory store — per (environment × actionType) success rates and
 *     durations plus the machine's COARSE environment fingerprint
 *     (os/arch/node-major/shell-family). No task text, no paths, no args,
 *     no URLs — nothing that could identify the user or leak their work.
 *
 *   absorbCrowdSummary(): the inverse — merge such a summary (shared by
 *     file, PR, or a future opt-in registry) into the local world model as
 *     PRIOR evidence, blended under local evidence so real experience on
 *     this machine always dominates. Priors only apply when the summary's
 *     fingerprint matches this machine's os+arch (a win32/x64 crowd stat
 *     must not steer a linux/arm64 user).
 *
 * Design rule: contribution is opt-in and offline by default — the file
 * round-trip is the whole mechanism; there is no telemetry endpoint here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTrajectories } from './analysis.ts';
import { CognitiveMemory } from './memory.ts';

/* ---------------- fingerprint ---------------- */

export interface EnvironmentFingerprint {
  os: string;
  arch: string;
  nodeMajor: number;
  /** coarse shell family the agent's tools target (win: cmd, else unix) */
  shell: 'cmd' | 'unix';
}

export function environmentFingerprint(): EnvironmentFingerprint {
  return {
    os: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]) || 0,
    shell: process.platform === 'win32' ? 'cmd' : 'unix',
  };
}

/** two fingerprints are compatible when the load-bearing fields match:
 *  os+arch must be equal; release/node major may drift (tool behavior
 *  rarely flips on a Node minor). */
export function fingerprintCompatible(a: EnvironmentFingerprint, b: EnvironmentFingerprint): boolean {
  return a.os === b.os && a.arch === b.arch && a.shell === b.shell;
}

/* ---------------- summary ---------------- */

export interface CrowdStat {
  environmentId: string;
  actionType: string;
  n: number;
  successRate: number;
  meanDurationMs: number;
}

export interface CrowdSummary {
  kind: 'hmharness-crowd-summary';
  version: 1;
  fingerprint: EnvironmentFingerprint;
  generatedAt: string;
  trajectoryCount: number;
  stats: CrowdStat[];
}

/** Aggregate the local trajectory store into a content-free summary.
 *  Everything derived from step metadata ONLY (action type, outcome,
 *  duration) — a summary shared publicly cannot leak what you worked on. */
export async function crowdSummary(home: string): Promise<CrowdSummary> {
  const trajectories = await loadTrajectories(home, 10_000);
  const table = new Map<string, { n: number; ok: number; ms: number }>();
  for (const traj of trajectories) {
    for (const s of traj.steps) {
      const key = `${traj.environment.id}|${s.action.type}`;
      const agg = table.get(key) ?? { n: 0, ok: 0, ms: 0 };
      agg.n += 1;
      agg.ok += s.outcome === 'success' ? 1 : 0;
      agg.ms += s.durationMs ?? 0;
      table.set(key, agg);
    }
  }
  const stats: CrowdStat[] = [...table.entries()]
    .map(([key, v]) => {
      const [environmentId, actionType] = key.split('|');
      return { environmentId, actionType, n: v.n, successRate: Number((v.ok / v.n).toFixed(3)), meanDurationMs: Math.round(v.ms / v.n) };
    })
    .sort((a, b) => b.n - a.n);
  return {
    kind: 'hmharness-crowd-summary',
    version: 1,
    fingerprint: environmentFingerprint(),
    generatedAt: new Date().toISOString(),
    trajectoryCount: trajectories.length,
    stats,
  };
}

/** Write the summary to a file (default: HMH_HOME/crowd-summary.json). */
export async function writeCrowdSummary(home: string, outFile?: string): Promise<{ file: string; summary: CrowdSummary }> {
  const summary = await crowdSummary(home);
  const file = outFile ?? join(home, 'crowd-summary.json');
  await writeFile(file, JSON.stringify(summary, null, 1), 'utf8');
  return { file, summary };
}

/* ---------------- absorb (merge priors) ---------------- */

export interface CrowdPriors {
  kind: 'hmharness-crowd-priors';
  version: 1;
  /** sources absorbed so far (dedupe key: fingerprint + generatedAt) */
  sources: Array<{ fingerprint: EnvironmentFingerprint; generatedAt: string; stats: number }>;
  /** merged per (environment|action) prior; local evidence blends over it */
  priors: Record<string, { n: number; successRate: number; source: string }>;
}

async function readPriors(home: string): Promise<CrowdPriors> {
  try {
    const j = JSON.parse(await readFile(join(home, 'cognitive', 'crowd-priors.json'), 'utf8')) as CrowdPriors;
    if (j && j.kind === 'hmharness-crowd-priors' && j.priors && Array.isArray(j.sources)) return j;
  } catch { /* absent/corrupt = empty */ }
  return { kind: 'hmharness-crowd-priors', version: 1, sources: [], priors: {} };
}

/** Merge a crowd summary into the local prior store. Fingerprint-
 *  incompatible summaries are refused (return why) — a mismatched crowd
 *  would actively mislead this machine's world model. Re-absorbing the
 *  same source is a no-op (dedupe). */
export async function absorbCrowdSummary(home: string, summaryFile: string): Promise<{ ok: boolean; absorbed: number; error?: string; skipped?: string }> {
  let summary: CrowdSummary;
  try {
    const raw = JSON.parse(await readFile(summaryFile, 'utf8')) as CrowdSummary;
    if (!raw || raw.kind !== 'hmharness-crowd-summary' || !Array.isArray(raw.stats) || !raw.fingerprint) {
      return { ok: false, absorbed: 0, error: 'not a crowd summary (kind/version mismatch)' };
    }
    summary = raw;
  } catch (e) {
    return { ok: false, absorbed: 0, error: 'unreadable file: ' + String(e).slice(0, 80) };
  }
  const mine = environmentFingerprint();
  if (!fingerprintCompatible(mine, summary.fingerprint)) {
    return { ok: false, absorbed: 0, skipped: `fingerprint mismatch: summary is ${summary.fingerprint.os}/${summary.fingerprint.arch}, this machine is ${mine.os}/${mine.arch}` };
  }
  const dedupeKey = `${summary.fingerprint.os}/${summary.fingerprint.arch}/n${summary.fingerprint.nodeMajor}@${summary.generatedAt}`;
  const priors = await readPriors(home);
  if (priors.sources.some((s) => `${s.fingerprint.os}/${s.fingerprint.arch}/n${s.fingerprint.nodeMajor}@${s.generatedAt}` === dedupeKey)) {
    return { ok: true, absorbed: 0, skipped: 'source already absorbed (dedupe)' };
  }
  let absorbed = 0;
  for (const st of summary.stats) {
    const key = `${st.environmentId}|${st.actionType}`;
    const prev = priors.priors[key];
    if (!prev) {
      priors.priors[key] = { n: st.n, successRate: st.successRate, source: dedupeKey };
    } else {
      // weighted merge: bigger sample wins proportionally
      const total = prev.n + st.n;
      priors.priors[key] = {
        n: total,
        successRate: Number(((prev.successRate * prev.n + st.successRate * st.n) / total).toFixed(3)),
        source: dedupeKey,
      };
    }
    absorbed++;
  }
  priors.sources.push({ fingerprint: summary.fingerprint, generatedAt: summary.generatedAt, stats: summary.stats.length });
  // best-effort dir + write
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(join(home, 'cognitive', 'crowd-priors.json'), JSON.stringify(priors, null, 1), 'utf8');
  // episodic index entry so the contribution is auditable locally
  const mem = new CognitiveMemory(home);
  await mem.load();
  await mem.write({
    layer: 'semantic',
    content: `CROWD-ABSORB ${absorbed} action stats from ${summary.fingerprint.os}/${summary.fingerprint.arch} (n=${summary.stats.reduce((s, x) => s + x.n, 0)} steps)`,
    payload: { source: dedupeKey, stats: absorbed },
    source: 'crowd-loop',
    provenance: 'crowd-priors.json',
    confidence: 0.6,
    environment: 'terminal',
    session: 'crowd',
    tags: ['crowd', 'priors'],
  }).catch(() => undefined);
  return { ok: true, absorbed };
}

/** Load the local prior store for world-model seeding (used by the digest
 *  and explore runner). Returns {} when nothing was ever absorbed. */
export async function loadCrowdPriors(home: string): Promise<CrowdPriors> {
  return readPriors(home);
}
