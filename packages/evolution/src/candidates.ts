/**
 * @hmharness/evolution - candidates (V2 M9: Evolution 泛化)
 * Blueprint M9: a typed candidate registry (prompt/skill/context/tool_policy/
 * model_router/workflow/harness), a Control/Treatment experiment runner,
 * statistical comparison, and gated promotion/rollback. See ADR-0003.
 *
 * 红线 (blueprint 14.3, enforced here, not by convention):
 *  - 无实验报告(promote-eligible)不晋升 —— no baseline, no improvement claim
 *  - 激活前必写 previous 指针 —— no rollback, no promotion
 *  - origin=agent 的 prompt/harness 候选需人工标记才可激活 —— agents never
 *    self-modify the production prompt
 *  - 晋升判据是双比例检验,LLM self-report 无效力 —— M2 证据阶梯双保险
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchCase } from './bench.ts';
import { screenForPoison } from './evolve.ts';

export type CandidateTarget =
  | 'prompt'
  | 'skill'
  | 'context'
  | 'tool_policy'
  | 'model_router'
  | 'workflow'
  | 'harness';

export const CANDIDATE_TARGETS: CandidateTarget[] = [
  'prompt', 'skill', 'context', 'tool_policy', 'model_router', 'workflow', 'harness',
];

export interface EvolutionCandidate {
  id: string;
  target: CandidateTarget;
  /** the version this candidate is measured against (baseline pointer) */
  baseVersion: string;
  candidateVersion: string;
  hypothesis: string;
  /** metric the experiment reports on, e.g. 'bench.passRate' */
  expectedMetric: string;
  /** target-specific payload: skill markdown, prompt delta, router table… */
  payload?: string;
  /** who proposed it - 'agent' proposals on prompt/harness need human sign-off */
  origin?: string;
  createdAt: string;
}

/* ---------------- registry ---------------- */

function candDir(home: string): string {
  return join(home, 'evolution', 'candidates');
}

export async function registerCandidate(home: string, cand: Omit<EvolutionCandidate, 'id' | 'createdAt'> & { id?: string }): Promise<EvolutionCandidate> {
  if (!CANDIDATE_TARGETS.includes(cand.target)) throw new Error(`unknown candidate target: ${cand.target}`);
  if (!cand.hypothesis.trim() || !cand.candidateVersion.trim()) throw new Error('candidate needs a hypothesis and a candidateVersion');
  const poison = screenForPoison(cand.hypothesis + '\n' + (cand.payload ?? ''));
  if (poison) throw new Error(`candidate rejected by safety screen: ${poison}`);
  const full: EvolutionCandidate = {
    ...cand,
    id: cand.id ?? `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  await mkdir(candDir(home), { recursive: true });
  await writeFile(join(candDir(home), `${full.id}.json`), JSON.stringify(full, null, 2) + '\n', 'utf8');
  return full;
}

export async function listCandidates(home: string): Promise<EvolutionCandidate[]> {
  let files: string[] = [];
  try { files = (await readdir(candDir(home))).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: EvolutionCandidate[] = [];
  for (const f of files) {
    try { out.push(JSON.parse(await readFile(join(candDir(home), f), 'utf8')) as EvolutionCandidate); } catch { /* skip torn */ }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getCandidate(home: string, id: string): Promise<EvolutionCandidate | null> {
  try { return JSON.parse(await readFile(join(candDir(home), `${id}.json`), 'utf8')) as EvolutionCandidate; } catch { return null; }
}

/* ---------------- statistics ---------------- */

/** Standard normal CDF, Zelen & Severo approximation of A&S 26.2.17 (|err|<7.5e-8). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = d * poly; // P(Z > |z|) tail
  return z >= 0 ? 1 - upper : upper;
}

/** Two-proportion two-sided test (treatment vs control pass rates). */
export function twoProportionTest(
  control: { pass: number; n: number },
  treatment: { pass: number; n: number },
): { z: number; p: number; diff: number } {
  if (control.n <= 0 || treatment.n <= 0) return { z: 0, p: 1, diff: 0 };
  const pc = control.pass / control.n;
  const pt = treatment.pass / treatment.n;
  const pool = (control.pass + treatment.pass) / (control.n + treatment.n);
  const se = Math.sqrt(pool * (1 - pool) * (1 / control.n + 1 / treatment.n));
  const z = se > 0 ? (pt - pc) / se : 0;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))), diff: pt - pc };
}

/* ---------------- experiment runner ---------------- */

export interface ArmResult {
  pass: boolean;
  /** token cost of the arm run (cost-cap honesty, same currency as estTokens) */
  tokens: number;
}

/** Injected by the caller: run one bench case under one arm. The runner owns
 *  the actual injection point (skills block, memory config, router table…). */
export type ArmRunner = (c: BenchCase, arm: 'control' | 'treatment') => Promise<ArmResult>;

export interface ExperimentArm {
  pass: number;
  n: number;
  passRate: number;
  tokens: number;
}

export interface ExperimentReport {
  candidateId: string;
  ranAt: string;
  cases: number;
  control: ExperimentArm;
  treatment: ExperimentArm;
  diff: number;
  z: number;
  p: number;
  verdict: 'promote-eligible' | 'reject' | 'needs-data';
  reason: string;
}

/** Per-arm minimum before any verdict counts (aligned with impact.ts canary
 *  threshold: >=8 sessions, and blueprint "one success is not significance"). */
export const MIN_ARM_N = 8;

export function verdictFor(
  control: { pass: number; n: number },
  treatment: { pass: number; n: number },
): { verdict: ExperimentReport['verdict']; reason: string; z: number; p: number; diff: number } {
  const { z, p, diff } = twoProportionTest(control, treatment);
  if (control.n < MIN_ARM_N || treatment.n < MIN_ARM_N) {
    return { verdict: 'needs-data', reason: `samples below ${MIN_ARM_N} per arm (control ${control.n}, treatment ${treatment.n})`, z, p, diff };
  }
  if (p < 0.05 && diff >= 0.10) return { verdict: 'promote-eligible', reason: `significant lift (p=${p.toFixed(4)}, diff=${(diff * 100).toFixed(1)}%)`, z, p, diff };
  if ((p < 0.05 && diff <= -0.05) || diff <= -0.10) {
    return { verdict: 'reject', reason: `regression (p=${p.toFixed(4)}, diff=${(diff * 100).toFixed(1)}%)`, z, p, diff };
  }
  return { verdict: 'needs-data', reason: `no significant difference (p=${p.toFixed(4)}, diff=${(diff * 100).toFixed(1)}%)`, z, p, diff };
}

export async function runCandidateExperiment(
  home: string,
  candidateId: string,
  opts: { runCase: ArmRunner; cases: BenchCase[]; maxCases?: number },
): Promise<ExperimentReport> {
  const cand = await getCandidate(home, candidateId);
  if (!cand) throw new Error(`no candidate: ${candidateId}`);
  // holdout cases are excluded from promotion gates (bench.ts anti-memorization)
  const gate = opts.cases.filter((c) => !c.holdout).slice(0, Math.max(1, opts.maxCases ?? 12));
  let cPass = 0, cTok = 0, tPass = 0, tTok = 0;
  for (const c of gate) {
    const ctl = await opts.runCase(c, 'control');
    if (ctl.pass) cPass++;
    cTok += ctl.tokens;
    const trt = await opts.runCase(c, 'treatment');
    if (trt.pass) tPass++;
    tTok += trt.tokens;
  }
  const v = verdictFor({ pass: cPass, n: gate.length }, { pass: tPass, n: gate.length });
  const report: ExperimentReport = {
    candidateId,
    ranAt: new Date().toISOString(),
    cases: gate.length,
    control: { pass: cPass, n: gate.length, passRate: gate.length ? cPass / gate.length : 0, tokens: cTok },
    treatment: { pass: tPass, n: gate.length, passRate: gate.length ? tPass / gate.length : 0, tokens: tTok },
    ...v,
  };
  const dir = join(home, 'evolution', 'experiments', candidateId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${report.ranAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

/** Latest experiment report for a candidate (promotion evidence). */
export async function latestExperiment(home: string, candidateId: string): Promise<ExperimentReport | null> {
  const dir = join(home, 'evolution', 'experiments', candidateId);
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
  if (files.length === 0) return null;
  try { return JSON.parse(await readFile(join(dir, files[files.length - 1]), 'utf8')) as ExperimentReport; } catch { return null; }
}

/* ---------------- active versions / promotion / rollback ---------------- */

export interface ActiveVersion {
  target: CandidateTarget;
  version: string;
  candidateId: string;
  since: string;
  reportAt?: string;
}

const activeDir = (home: string) => join(home, 'evolution', 'active');

export async function activeVersions(home: string): Promise<Record<string, ActiveVersion>> {
  const out: Record<string, ActiveVersion> = {};
  let files: string[] = [];
  try { files = await readdir(activeDir(home)); } catch { return out; }
  for (const f of files.filter((f) => f.endsWith('.json') && !f.endsWith('.previous.json'))) {
    try {
      const v = JSON.parse(await readFile(join(activeDir(home), f), 'utf8')) as ActiveVersion;
      out[v.target] = v;
    } catch { /* skip torn */ }
  }
  return out;
}

export interface PromoteResult {
  ok: boolean;
  error?: string;
  active?: ActiveVersion;
}

/** Blueprint gates, enforced: latest report must be promote-eligible, a
 *  previous pointer is written BEFORE activation, agent-origin prompt/harness
 *  candidates need approvedByHuman. Skill promotions ride the existing
 *  promoteSkill canary channel. */
export async function promoteCandidate(
  home: string,
  candidateId: string,
  opts: { approvedByHuman?: boolean } = {},
): Promise<PromoteResult> {
  const cand = await getCandidate(home, candidateId);
  if (!cand) return { ok: false, error: `no candidate: ${candidateId}` };
  const report = await latestExperiment(home, candidateId);
  if (!report) return { ok: false, error: 'no experiment report - run the experiment first (no baseline, no promotion)' };
  if (report.verdict !== 'promote-eligible') {
    return { ok: false, error: `latest report verdict is ${report.verdict} (${report.reason}) - not promotable` };
  }
  if ((cand.target === 'prompt' || cand.target === 'harness') && cand.origin === 'agent' && !opts.approvedByHuman) {
    return { ok: false, error: 'agent-origin prompt/harness candidate requires approvedByHuman (production prompt is not agent-writable)' };
  }
  await mkdir(activeDir(home), { recursive: true });
  const cur = await activeVersions(home);
  const previous = cur[cand.target];
  if (previous) {
    await writeFile(join(activeDir(home), `${cand.target}.previous.json`), JSON.stringify(previous, null, 2) + '\n', 'utf8');
  }
  if (cand.target === 'skill') {
    // payload = skill name; the audited canary channel stays the only skill path
    const { promoteSkill } = await import('./skills.ts');
    if (!cand.payload) return { ok: false, error: 'skill candidate has no payload (skill name)' };
    await promoteSkill(home, cand.payload, { canary: true });
  }
  const active: ActiveVersion = {
    target: cand.target,
    version: cand.candidateVersion,
    candidateId: cand.id,
    since: new Date().toISOString(),
    reportAt: report.ranAt,
  };
  await writeFile(join(activeDir(home), `${cand.target}.json`), JSON.stringify(active, null, 2) + '\n', 'utf8');
  return { ok: true, active };
}

export async function rollbackCandidate(home: string, target: CandidateTarget): Promise<{ ok: boolean; error?: string }> {
  const dir = activeDir(home);
  const prevPath = join(dir, `${target}.previous.json`);
  let previous: ActiveVersion | null = null;
  try { previous = JSON.parse(await readFile(prevPath, 'utf8')) as ActiveVersion; } catch { /* no previous */ }
  if (!previous) return { ok: false, error: `no previous pointer for ${target} - nothing to roll back to` };
  if (target === 'skill') {
    const { rollbackSkill } = await import('./skills.ts');
    await rollbackSkill(home, previous.version);
  }
  await writeFile(join(dir, `${target}.json`), JSON.stringify(previous, null, 2) + '\n', 'utf8');
  return { ok: true };
}
