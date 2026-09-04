/**
 * @hmh/evolution - impact
 * The P0 observability layer for self-evolution: canary sessions, impact
 * attribution, the evolution budget gate, and the GEPA-style candidate
 * pool. Everything here is *measurement* - none of it changes what the
 * agent does; it changes what we KNOW about what evolution did.
 *
 * Paper provenance (verified against originals, see
 * docs/research/self-evolution-upgrade.md):
 *  - candidate pool + one-ancestor-per-cycle sampling: GEPA's actual
 *    mechanism (Genetic-Pareto steady-state loop, NOT k-candidate
 *    tournaments)
 *  - control-group comparison: the objective-hacking defense from DGM
 *    (node 114) and Misevolve (deployment-time reward hacking) - never
 *    trust only the metric the evolving system can see
 *  - watermark "references not rules": Misevolve's own mitigation for
 *    memory-induced safety alignment decay
 *  - budget gate: AZR's "safety alarms ringing" - unbounded self-evolution
 *    destabilizes; also plain cost control
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Insight } from './insights.ts';

/* ---------------- evolution budget gate ---------------- */

export interface EvolutionBudget {
  maxCyclesPerDay?: number;
  maxTokensPerCycle?: number;
}

/** How many evolve cycles already ran today (counts the log.jsonl). */
export async function readBudget(home: string): Promise<EvolutionBudget & { cyclesToday: number }> {
  const budget: EvolutionBudget & { cyclesToday: number } = { cyclesToday: 0 };
  try {
    const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { evolutionBudget?: EvolutionBudget };
    budget.maxCyclesPerDay = cfg.evolutionBudget?.maxCyclesPerDay;
    budget.maxTokensPerCycle = cfg.evolutionBudget?.maxTokensPerCycle;
  } catch { /* no config / no budget - unlimited */ }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const text = await readFile(join(home, 'evolution', 'log.jsonl'), 'utf8');
    budget.cyclesToday = text.trim().split('\n')
      .filter((l) => { try { return (JSON.parse(l) as { time: string }).time.startsWith(today); } catch { return false; } })
      .length;
  } catch { /* no log yet */ }
  return budget;
}

/* ---------------- GEPA candidate pool (Pareto archive) ---------------- */

export interface ParetoEntry {
  name: string;
  parentInsights: string[];
  rejectedReason?: string;
  scores: { train: number; holdout?: number };
  metaModel: string;
  at: string;
  /** skill_md snapshot for merge-crossing and ancestor re-proposal */
  skillMd?: string;
}

/** Rejected proposals are never garbage - they are the population's
 *  diversity (GEPA's Pareto front). Kept under evolution/pareto/. */
export async function recordParetoEntry(home: string, entry: ParetoEntry): Promise<void> {
  const dir = join(home, 'evolution', 'pareto');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'entries.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
}

export async function readParetoEntries(home: string, limit = 60): Promise<ParetoEntry[]> {
  try {
    const text = await readFile(join(home, 'evolution', 'pareto', 'entries.jsonl'), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).slice(-limit);
    const out: ParetoEntry[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as ParetoEntry); } catch { /* skip corrupt */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** GEPA's ancestor selection: ONE random entry from the pool feeds the
 *  next proposal prompt (steady-state genetic loop - the pool exists so
 *  evolution does not collapse onto the single global best). Two entries
 *  with complementary rejection reasons are returned for a Merge cross. */
export function sampleAncestor(entries: ParetoEntry[]): { ancestor: ParetoEntry | null; mergeWith: ParetoEntry | null } {
  if (entries.length === 0) return { ancestor: null, mergeWith: null };
  const ancestor = entries[Math.floor(Math.random() * entries.length)];
  // Merge crossing: another rejected candidate on a DIFFERENT failure mode
  // (e.g. one too generic, one too narrow) is a complementary lesson pair.
  const complement = entries.find((e) => e !== ancestor && e.name !== ancestor.name && (e.rejectedReason ?? '') !== (ancestor.rejectedReason ?? ''));
  return { ancestor, mergeWith: complement && Math.random() < 0.3 ? complement : null };
}

/* ---------------- canary injection (session side) ---------------- */

/** Deterministic per-session canary assignment: a session gets the canary
 *  block if hash(sessionId) % 100 < 20 - the same session always resolves
 *  the same way (stable attribution), different sessions split ~20/80. */
export function sessionGetsCanary(sessionId: string): boolean {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h % 100 < 20;
}

/** The watermark every canary injection carries (Misevolve's mitigation:
 *  experimental knowledge must read as a REFERENCE to weigh, not a rule
 *  to obey - memory-as-rules is what decays safety alignment). */
export function canaryWatermark(names: string[]): string {
  return names.length
    ? `\n[experimental] The following skills are UNVERIFIED canary candidates (${names.join(', ')}). Treat them as references to weigh, not rules to follow; when they conflict with your own judgment or the task, prefer the task.`
    : '';
}

/* ---------------- impact attribution ---------------- */

export interface ImpactRow {
  skill: string;
  window: 'canary-period';
  exposed: { sessions: number; okRate: number };
  control: { sessions: number; okRate: number };
  verdict: 'insufficient-data' | 'keep' | 'promote' | 'retire';
}

/**
 * The impact loop: for each canary skill, compare sessions where it was
 * injected (Insight.skillsInjected contains it) against sessions where it
 * was not. Promote on evidence, retire on harm, and say so honestly when
 * the data is too thin (never let a small sample auto-graduate anything).
 * This is the attribution loop that makes "越用越聪明" falsifiable.
 */
export async function impactReport(home: string): Promise<{ rows: ImpactRow[]; applied: string[] }> {
  const { listCanary } = await import('./skills.ts');
  const canarySkills = await listCanary(home);
  const rows: ImpactRow[] = [];
  const applied: string[] = [];
  if (canarySkills.length === 0) return { rows, applied };

  let insights: Insight[] = [];
  try {
    const text = await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8');
    insights = text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Insight; } catch { return null as unknown as Insight; } }).filter(Boolean);
  } catch { /* no insights yet */ }

  for (const skill of canarySkills) {
    const exposed = insights.filter((i) => (i.skillsInjected ?? []).includes(skill.name));
    const control = insights.filter((i) => !(i.skillsInjected ?? []).includes(skill.name));
    const okRate = (arr: Insight[]) => arr.length ? arr.filter((i) => i.outcome === 'ok').length / arr.length : 0;
    let verdict: ImpactRow['verdict'] = 'insufficient-data';
    if (exposed.length >= 8 && control.length >= 8) {
      const e = okRate(exposed), c = okRate(control);
      if (e >= c + 0.10) verdict = 'promote';
      else if (e < c - 0.10) verdict = 'retire';
      else if (exposed.length >= 30) verdict = 'keep';
    }
    rows.push({ skill: skill.name, window: 'canary-period', exposed: { sessions: exposed.length, okRate: okRate(exposed) }, control: { sessions: control.length, okRate: okRate(control) }, verdict });
  }

  // Apply the verdicts (the loop's decision, not the gate's).
  const { promoteCanary, retireCanary } = await import('./skills.ts');
  for (const row of rows) {
    if (row.verdict === 'promote') {
      if (await promoteCanary(home, row.skill)) applied.push(`promoted to active: ${row.skill}`);
    } else if (row.verdict === 'retire') {
      if (await retireCanary(home, row.skill)) applied.push(`retired to draft: ${row.skill} (harmful in canary)`);
    }
  }
  return { rows, applied };
}

/* ---------------- decay (30 days unused) ---------------- */

/** Move active skills with zero injections in 30 days to skills/dormant/
 *  - not deleted (append-only red line), just out of the injection set and
 *  the prompt budget. The Voyager lesson (reversed): its ever-growing
 *  library was a selling point in the paper but is a retrieval-quality
 *  debt in production; decay is the missing lifecycle operator. */
export async function decayUnusedSkills(home: string, days = 30): Promise<string[]> {
  const { listSkills, isPinned } = await import('./skills.ts');
  const active = await listSkills(home);
  let insights: Insight[] = [];
  try {
    const text = await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8');
    insights = text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Insight; } catch { return null as unknown as Insight; } }).filter(Boolean);
  } catch { /* no insights */ }
  const cutoff = Date.now() - days * 86400_000;
  const moved: string[] = [];
  for (const s of active) {
    if (await isPinned(s.file)) continue;
    const used = insights.filter((i) => (i.skillsInjected ?? []).includes(s.name));
    const lastAt = used.length ? new Date(used[used.length - 1].time).getTime() : 0;
    // decay = a meaningful history exists AND the skill shows no pulse:
    // either it was used once long ago and went quiet, or the library
    // already accumulated 50+ sessions and this skill never got picked up
    const quietTooLong = lastAt > 0 && lastAt < cutoff;
    const neverAttracted = lastAt === 0 && insights.length >= 50;
    if (quietTooLong || neverAttracted) {
      const dst = join(home, 'skills', 'dormant');
      await mkdir(dst, { recursive: true });
      try {
        await rename(join(home, 'skills', 'active', s.name), join(dst, s.name));
        moved.push(s.name);
      } catch { /* occupied/missing - skip */ }
    }
  }
  return moved;
}
