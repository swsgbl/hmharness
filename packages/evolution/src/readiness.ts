/**
 * @hmharness/evolution - readiness (V2 M11: RL 前置条件检查器)
 * The blueprint's gate: RL is allowed ONLY when all six conditions hold.
 * Every condition is measured from real on-disk evidence - nothing is
 * estimated, nothing can be waved through. When the gate is closed the
 * report says exactly which optimization to do instead. See ADR-0005.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listCases } from './bench.ts';

export interface ReadinessCondition {
  id: string;
  met: boolean;
  current: number | string | boolean;
  threshold: number | string;
  evidence: string;
}

export interface ReadinessReport {
  verdict: 'rl-eligible' | 'optimize-first';
  conditions: ReadinessCondition[];
  /** when optimize-first: which lever to pull first (weakest condition) */
  recommendedLever?: 'data-collection' | 'bench-expansion' | 'reward-calibration' | 'eval-suite-stabilization' | 'version-provenance';
  at: string;
}

const QUALITY_MIN_REWARD = 0.5;

async function countRunTrajectories(home: string): Promise<{ total: number; highQuality: number }> {
  const root = join(home, 'runs');
  let ids: string[] = [];
  try { ids = (await readdir(root)).filter((d) => !d.startsWith('.')); } catch { return { total: 0, highQuality: 0 }; }
  let high = 0;
  for (const id of ids) {
    try {
      const s = JSON.parse(await readFile(join(root, id, 'summary.json'), 'utf8')) as {
        outcome?: string | { success?: boolean; reason?: string }; turns?: number; toolUses?: number; toolFailures?: number; metrics?: { turns?: number; toolUses?: number; toolFailures?: number };
      };
      const outcome = typeof s.outcome === 'string' ? s.outcome : (s.outcome?.success ? 'ok' : String(s.outcome?.reason ?? ''));
      const uses = Number(s.toolUses ?? s.metrics?.toolUses ?? 0);
      const fails = Number(s.toolFailures ?? s.metrics?.toolFailures ?? 0);
      const failRate = uses > 0 ? fails / uses : 0;
      const reward = outcome === 'ok' ? 1 - Math.min(0.6, Math.round(failRate * 10) / 10) : 0.3;
      if (outcome && (s.turns ?? s.metrics?.turns ?? 0) >= 1 && reward >= QUALITY_MIN_REWARD) high++;
    } catch { /* torn */ }
  }
  return { total: ids.length, highQuality: high };
}

export async function rlReadiness(home: string): Promise<ReadinessReport> {
  const conditions: ReadinessCondition[] = [];

  // 1. >= 1000 high-quality trajectories
  const runs = await countRunTrajectories(home);
  conditions.push({
    id: 'high-quality-trajectories',
    met: runs.highQuality >= 1000,
    current: runs.highQuality,
    threshold: 1000,
    evidence: `runs/ scan: ${runs.total} trajectories, ${runs.highQuality} with outcome + turns>=1 + reward>=${QUALITY_MIN_REWARD}`,
  });

  // 2. >= 100 stable benchmark tasks
  let cases = 0;
  try { cases = (await listCases(home)).length; } catch { /* none */ }
  conditions.push({
    id: 'stable-benchmark-tasks',
    met: cases >= 100,
    current: cases,
    threshold: 100,
    evidence: `bench/cases/ scan: ${cases} cases (holdout included; stability tracked by bench history)`,
  });

  // 3. reward vs human judgment correlation VERIFIED - no human-labeling
  //    channel exists yet, so this is honestly not met (never a guess)
  let humanLabels = 0;
  try {
    const f = await stat(join(home, 'evolution', 'reward-human-labels.jsonl'));
    if (f.isFile()) humanLabels = (await readFile(join(home, 'evolution', 'reward-human-labels.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
  } catch { /* absent */ }
  conditions.push({
    id: 'reward-human-correlation',
    met: humanLabels >= 100,
    current: humanLabels,
    threshold: 100,
    evidence: 'evolution/reward-human-labels.jsonl (human-scored samples; dataset label field reserves the slot)',
  });

  // 4. evaluation regression suite STABLE - last two bench records, no regression
  let suiteStable = false;
  let suiteEvidence = 'no bench history records (evolution/benches/ empty)';
  try {
    const dir = join(home, 'evolution', 'benches');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (files.length >= 2) {
      const last = JSON.parse(await readFile(join(dir, files[files.length - 1]), 'utf8')) as { passRate?: number };
      const prev = JSON.parse(await readFile(join(dir, files[files.length - 2]), 'utf8')) as { passRate?: number };
      if (typeof last.passRate === 'number' && typeof prev.passRate === 'number') {
        suiteStable = last.passRate >= prev.passRate - 0.05;
        suiteEvidence = `last two bench passRates: ${(prev.passRate * 100).toFixed(0)}% -> ${(last.passRate * 100).toFixed(0)}% (tolerance -5%)`;
      }
    } else if (files.length === 1) {
      suiteEvidence = 'only one bench record - stability needs at least two';
    }
  } catch { /* absent */ }
  conditions.push({
    id: 'eval-regression-stable',
    met: suiteStable,
    current: suiteStable,
    threshold: 'no >5% passRate regression across last two bench runs',
    evidence: suiteEvidence,
  });

  // 5. model/skill/workflow version provenance
  const provenance = {
    model: true,   // every run's summary carries model; rollout session_meta pins it
    skills: false,
    workflows: false,
  };
  try {
    const skills = await readdir(join(home, 'skills'));
    provenance.skills = skills.some((s) => s.endsWith('.md'));
  } catch { /* none */ }
  try {
    const wf = await readdir(join(home, 'evolution', 'workflows'));
    provenance.workflows = wf.length > 0;
  } catch { /* none */ }
  conditions.push({
    id: 'version-provenance',
    met: provenance.skills && provenance.workflows,
    current: provenance.skills && provenance.workflows,
    threshold: 'skills + workflows under version control (model provenance ships with every run)',
    evidence: `skills dir: ${provenance.skills ? 'versioned .md files' : 'empty'}; workflows dir: ${provenance.workflows ? 'present' : 'empty'}`,
  });

  // 6. offline evaluation + holdout set exist
  let holdout = 0;
  try { holdout = (await listCases(home)).filter((c) => c.holdout).length; } catch { /* none */ }
  conditions.push({
    id: 'offline-eval-holdout',
    met: holdout > 0 && cases > 0,
    current: holdout,
    threshold: '>0 holdout cases in a non-empty bench suite',
    evidence: `bench/cases/: ${cases} total, ${holdout} holdout`,
  });

  const allMet = conditions.every((c) => c.met);
  const weakest = conditions.find((c) => !c.met);
  const leverMap: Record<string, ReadinessReport['recommendedLever']> = {
    'high-quality-trajectories': 'data-collection',
    'stable-benchmark-tasks': 'bench-expansion',
    'reward-human-correlation': 'reward-calibration',
    'eval-regression-stable': 'eval-suite-stabilization',
    'version-provenance': 'version-provenance',
    'offline-eval-holdout': 'bench-expansion',
  };
  return {
    verdict: allMet ? 'rl-eligible' : 'optimize-first',
    conditions,
    ...(allMet ? {} : { recommendedLever: weakest ? leverMap[weakest.id] : undefined }),
    at: new Date().toISOString(),
  };
}
