/**
 * Skill Generalization P1-2 — single-factor A/B experiment (2026-10-28).
 *
 * Preregistered at website/evidence/experiments/skill-gen-p1-2-2026-10-28/
 * manifest.json BEFORE this driver was written. Factor: precondition-aware
 * trigger matching. Arm A = 现状 (mineWorkflows order top-1, env-only
 * trigger, preconditions []). Arm B = same pool + train-only structured
 * precondition mining + hasContextSignal selection gate + triggerMatchScore
 * (tau 0.5). Both arms' procedure bodies stay pure contiguous n-grams.
 *
 * Corpus-replay: zero LLM tokens; wallclock recorded. Holdout is read
 * exactly once, in this run phase, by the frozen scorer (no-look rule).
 */
import {
  loadTrajectories,
  mineWorkflows,
  toSkillSpecV2,
  compileSkillWithPreconditions,
  selectByPreconditionStability,
  triggerMatchScore,
  minePreconditions,
  type CognitiveTrajectory,
  type WorkflowCandidate,
} from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const EVID = join(import.meta.dirname, '..', 'website', 'evidence', 'experiments', 'skill-gen-p1-2-2026-10-28');
const FAMILIES = ['terminal', 'harmonyos', 'browser'] as const;
const TAU = 0.5;

/* byte-identical to the 0.26 lab's split so terminal-family arm A is
 * same-口径 comparable with the measured 0.39 */
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function splitFamily(pool: CognitiveTrajectory[]): { train: CognitiveTrajectory[]; holdout: CognitiveTrajectory[] } {
  const rand = mulberry32(hashSeed('real-cycle-2026-10-07'));
  const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const cut = Math.floor(shuffled.length * 0.7);
  return { train: shuffled.slice(0, cut), holdout: shuffled.slice(cut) };
}

function containsContiguous(seq: string[], gram: string[]): boolean {
  outer: for (let i = 0; i + gram.length <= seq.length; i++) {
    for (let j = 0; j < gram.length; j++) if (seq[i + j] !== gram[j]) continue outer;
    return true;
  }
  return false;
}

/** exact McNemar two-sided (same semantics as evalset.binomTwoSidedP) */
function mcnemarExact(nA: number, nB: number): number {
  const n = nA + nB;
  if (n === 0) return 1;
  const logChoose = (a: number, b: number): number => {
    let s = 0;
    for (let i = 1; i <= b; i++) s += Math.log(a - b + i) - Math.log(i);
    return s;
  };
  const k = Math.min(nA, nB);
  const pmf = (i: number) => Math.exp(logChoose(n, i) + i * Math.log(0.5) + (n - i) * Math.log(0.5));
  const pk = pmf(k);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= pk + 1e-12) sum += pmf(i);
  return Math.min(1, Number(sum.toFixed(6)));
}

function bootstrapDiffCI(pairs: Array<{ a: boolean; b: boolean }>, seed: string): { lo: number; hi: number } {
  const rand = mulberry32(hashSeed(seed));
  const diffs = pairs.map((p) => (p.b ? 1 : 0) - (p.a ? 1 : 0));
  const means: number[] = [];
  for (let r = 0; r < 10_000; r++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)]!;
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.ceil(p * means.length) - 1))]!;
  return { lo: Number((q(0.025) * 100).toFixed(2)), hi: Number((q(0.975) * 100).toFixed(2)) };
}

interface CaseRow {
  family: string; id: string;
  containsA: boolean; containsB: boolean;
  matchedB: boolean; scoreB: number; satisfiedB: number; totalChecksB: number; vacuousB: boolean; anchorB: number;
}
interface FamResult {
  family: string;
  usable: number; trainN: number; holdoutN: number; holdoutSuccesses: number;
  lowPower: boolean;
  poolEmpty: boolean; degenerate: boolean;
  aSkill: { id: string; steps: string[]; support: number } | null;
  bSkill: { id: string; steps: string[]; support: number; preconditions: string[]; signalPoolSize: number } | null;
  contA: number | null; contB: number | null;
  diffPP: number | null;
  mcnemarP: number | null; ci: { lo: number; hi: number } | null;
  discordant: { aOnly: number; bOnly: number } | null;
  m1: number | null; pAtTau: number | null; rAtTau: number | null;
  gateA: boolean | null; gateB: boolean | null;
  /** diagnostic: did the signal gate actually change the pick vs arm A? */
  selectionChanged: boolean;
}

const t0 = Date.now();
const all = await loadTrajectories(HOME, 2000);
const usable = all.filter((t) => t.steps.length > 0);
console.log(`corpus: ${all.length} loaded, ${usable.length} usable`);

const cases: CaseRow[] = [];
const fams: FamResult[] = [];
for (const fam of FAMILIES) {
  const pool = usable.filter((t) => t.environment.id === fam);
  const { train, holdout } = splitFamily(pool);
  const holdoutSuccesses = holdout.filter((t) => t.metrics.success);
  const seqOf = (t: CognitiveTrajectory) => t.steps.filter((s) => s.outcome === 'success').map((s) => s.action.type);

  const candidates = mineWorkflows(train, { minSupport: 2, nMin: 2, nMax: 4 });
  const aCand: WorkflowCandidate | undefined = candidates[0];
  const sel = selectByPreconditionStability(candidates, train);
  const bCand = sel.selected;
  const poolEmpty = candidates.length === 0;
  const degenerate = sel.degenerate;

  const aSkill = aCand ? toSkillSpecV2(aCand) : null;
  const bSkill = bCand ? compileSkillWithPreconditions(bCand, train) : null;

  let hitA = 0, hitB = 0, matched = 0, matchedAndContained = 0;
  let nA = 0, nB = 0;
  const pairs: Array<{ a: boolean; b: boolean }> = [];
  for (const t of holdoutSuccesses) {
    const seq = seqOf(t);
    const cA = aSkill ? containsContiguous(seq, aCand!.steps) : false;
    const cB = bSkill ? containsContiguous(seq, bCand!.steps) : false;
    const m = bSkill ? triggerMatchScore(bSkill, t, { threshold: TAU }) : null;
    if (cA) hitA++;
    if (cB) hitB++;
    if (m?.matched) matched++;
    if (m?.matched && cB) matchedAndContained++;
    if (cA && !cB) nA++; else if (!cA && cB) nB++;
    pairs.push({ a: cA, b: cB });
    cases.push({
      family: fam, id: t.id, containsA: cA, containsB: cB,
      matchedB: m?.matched ?? false, scoreB: m?.score ?? 0, satisfiedB: m?.satisfied ?? 0,
      totalChecksB: m?.total ?? 0, vacuousB: m?.vacuous ?? false, anchorB: m?.anchor ?? -1,
    });
  }
  const n = holdoutSuccesses.length;
  const contA = n > 0 ? hitA / n : null;
  const contB = n > 0 ? hitB / n : null;
  fams.push({
    family: fam, usable: pool.length, trainN: train.length, holdoutN: holdout.length, holdoutSuccesses: n,
    lowPower: n < 10, poolEmpty, degenerate,
    aSkill: aCand ? { id: aCand.steps.join('|'), steps: aCand.steps, support: aCand.support } : null,
    bSkill: bCand ? { id: bCand.steps.join('|'), steps: bCand.steps, support: bCand.support, preconditions: bSkill!.preconditions.map((p) => p.check), signalPoolSize: sel.signalPool.length } : null,
    contA, contB,
    diffPP: contA !== null && contB !== null ? Number(((contB - contA) * 100).toFixed(2)) : null,
    mcnemarP: n > 0 ? mcnemarExact(nA, nB) : null,
    ci: n > 0 ? bootstrapDiffCI(pairs, `skillgen-p1-2-${fam}`) : null,
    discordant: { aOnly: nA, bOnly: nB },
    m1: n > 0 ? matched / n : null,
    pAtTau: matched > 0 ? matchedAndContained / matched : null,
    rAtTau: hitB > 0 ? matchedAndContained / hitB : null,
    gateA: contA !== null ? contA >= 0.6 : null,
    gateB: contB !== null ? contB >= 0.6 : null,
    selectionChanged: aCand !== undefined && bCand !== undefined && aCand.steps.join('|') !== bCand.steps.join('|'),
  });
  console.log(`${fam}: n=${n} contA=${contA?.toFixed(3)} contB=${contB?.toFixed(3)} diff=${contA !== null && contB !== null ? ((contB - contA) * 100).toFixed(1) : '?'}pp p=${fams[fams.length - 1]!.mcnemarP} M1=${fams[fams.length - 1]!.m1?.toFixed(3)} P@tau=${fams[fams.length - 1]!.pAtTau?.toFixed(3)} degenerate=${degenerate}`);
}

/* ---- verdict per the frozen enum (order: NEEDS-DATA > NEGATIVE > POSITIVE > WEAK-POSITIVE > MIXED) ---- */
const scored = fams.filter((f) => !f.poolEmpty);
const lowPowerN = fams.filter((f) => f.lowPower || f.poolEmpty).length;
const ge = fams.filter((f) => f.diffPP !== null && f.diffPP >= 0);
const worsened = fams.filter((f) => f.diffPP !== null && f.diffPP < -5);
const sigImprove = fams.filter((f) => (f.diffPP ?? 0) > 0 && (f.mcnemarP ?? 1) < 0.05 && !f.lowPower);
const lt = fams.filter((f) => f.diffPP !== null && f.diffPP < 0);
let verdict: string;
if (lowPowerN >= 2) verdict = 'NEEDS-DATA';
else if (lt.length >= 2) verdict = 'NEGATIVE';
else if (ge.length >= 2 && worsened.length === 0 && sigImprove.length >= 1) verdict = 'POSITIVE';
else if (ge.length >= 2 && worsened.length === 0) verdict = 'WEAK-POSITIVE';
else verdict = 'MIXED';

const secEffective = fams.filter((f) => (f.pAtTau ?? 0) > (f.contA ?? 1) && (f.m1 ?? 0) >= 0.2);
const secondary = secEffective.length >= 2 ? 'effective' : 'not-effective';

mkdirSync(join(EVID, 'phases'), { recursive: true });
const wallMs = Date.now() - t0;
writeFileSync(join(EVID, 'phases', 'run.json'), JSON.stringify({ generatedAt: new Date().toISOString(), tau: TAU, families: fams, cases }, null, 2));
writeFileSync(join(EVID, 'phases', 'analysis.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  verdict, secondaryEndpoint: secondary,
  counts: { familiesImproving: ge.length, familiesWorsening: lt.length, worsenedBeyond5pp: worsened.length, significantNonLowPower: sigImprove.length, lowPowerOrEmpty: lowPowerN },
  llmTokens: 0, wallclockMs: wallMs,
  note: 'corpus-replay experiment: zero LLM tokens; no API calls (429 rule structurally inapplicable — preregistered)',
}, null, 2));

const lines = [
  '# skill-gen-p1-2 machine verdict (enum-locked)',
  '',
  `VERDICT: ${verdict}`,
  `secondary (trigger precision): ${secondary} (${secEffective.length}/3 families P@tau > contA with M1>=0.2)`,
  `selectionChanged: ${fams.filter((f) => f.selectionChanged).length}/3 families (unchanged picks make the main endpoint structurally zero-diff)`,
  '',
  '| family | n | contA | contB | diff pp | McNemar p | 95% CI pp | M1 | P@tau | R@tau | gateA | gateB |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...fams.map((f) => `| ${f.family}${f.lowPower ? ' (low-power)' : ''}${f.degenerate ? ' (degenerate)' : ''} | ${f.holdoutSuccesses} | ${f.contA?.toFixed(3) ?? '—'} | ${f.contB?.toFixed(3) ?? '—'} | ${f.diffPP ?? '—'} | ${f.mcnemarP ?? '—'} | [${f.ci?.lo ?? '—'}, ${f.ci?.hi ?? '—'}] | ${f.m1?.toFixed(3) ?? '—'} | ${f.pAtTau?.toFixed(3) ?? '—'} | ${f.rAtTau?.toFixed(3) ?? '—'} | ${f.gateA} | ${f.gateB} |`),
];
writeFileSync(join(EVID, 'machine-verdict.md'), lines.join('\n') + '\n');
console.log(`\nVERDICT: ${verdict} | secondary: ${secondary} | wallclock ${wallMs}ms | zero LLM tokens`);
