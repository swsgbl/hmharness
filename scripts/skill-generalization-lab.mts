/**
 * Skill Generalization Lab - first analysis (weekly pack 0.26).
 *
 * The 0.23.29 real cycle rejected the skill target at 0.39 < 0.6: the top
 * mined workflow replayed in only 39% of holdout successes. The pack asks
 * WHICH axis failed (precondition / variables / procedure / verification /
 * coverage) - and forbids lowering the bar to hide the failure. This
 * instrument attributes the misses: for every holdout success that does
 * NOT contain the workflow gram, measure the longest common PREFIX with
 * the gram (where the sequences diverge) and whether the gram's steps are
 * all present but OUT OF ORDER. That separates:
 *   - early divergence  -> the workflow's opening doesn't generalize (trigger/precondition axis)
 *   - late divergence   -> the opening generalizes, the tail varies (procedure-tail axis)
 *   - steps present, order differs -> variable-binding/ordering axis
 *   - steps absent      -> coverage axis (holdout does different work)
 */
import { loadTrajectories, mineWorkflows, type CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const successSequence = (t: CognitiveTrajectory): string[] => t.steps.filter((s) => s.outcome === 'success').map((s) => s.action.type);

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0);
const byEnv = new Map<string, number>();
for (const t of usable) byEnv.set(t.environment.id, (byEnv.get(t.environment.id) ?? 0) + 1);
const env = [...byEnv.entries()].sort((a, b) => b[1] - a[1])[0][0];
const pool = usable.filter((t) => t.environment.id === env);
const rand = mulberry32(hashSeed('real-cycle-2026-10-07'));
const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
const cut = Math.floor(shuffled.length * 0.7);
const train = shuffled.slice(0, cut);
const holdout = shuffled.slice(cut);

const candidates = mineWorkflows(train);
const top = candidates[0];
if (!top) { console.log('no mined workflows - nothing to analyze'); process.exit(0); }
console.log(`env='${env}' train=${train.length} holdout=${holdout.length}`);
console.log(`top workflow: [${top.steps.join(' → ')}] support=${top.support}`);

const holdoutSuccesses = holdout.filter((t) => t.metrics.success);
const gram = top.steps;
const misses: Array<{ id: string; prefix: number; allPresentOutOfOrder: boolean; stepsAbsent: string[] }> = [];
for (const t of holdoutSuccesses) {
  const seq = successSequence(t);
  let contains = false;
  outer: for (let i = 0; i + gram.length <= seq.length; i++) {
    for (let j = 0; j < gram.length; j++) if (seq[i + j] !== gram[j]) continue outer;
    contains = true; break;
  }
  if (contains) continue;
  // longest common prefix with the gram (at any alignment start, max)
  let bestPrefix = 0;
  for (let s = 0; s < seq.length; s++) {
    let p = 0;
    while (p < gram.length && s + p < seq.length && seq[s + p] === gram[p]) p++;
    bestPrefix = Math.max(bestPrefix, p);
  }
  const setSeq = new Set(seq);
  const stepsAbsent = gram.filter((g) => !setSeq.has(g));
  misses.push({ id: t.id, prefix: bestPrefix, allPresentOutOfOrder: stepsAbsent.length === 0, stepsAbsent });
}

const n = holdoutSuccesses.length;
const hit = n - misses.length;
console.log(`\nreplay: ${hit}/${n} = ${(hit / n).toFixed(3)} (the 0.39-class number)`);
console.log(`misses: ${misses.length}`);
const byPrefix = new Map<number, number>();
for (const m of misses) byPrefix.set(m.prefix, (byPrefix.get(m.prefix) ?? 0) + 1);
console.log('divergence prefix distribution (where the gram stops matching):');
for (const [p, c] of [...byPrefix.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  after ${p}/${gram.length} steps: ${c} (${(c / misses.length).toFixed(2)})`);
}
const outOfOrder = misses.filter((m) => m.allPresentOutOfOrder).length;
const missingSteps = misses.filter((m) => !m.allPresentOutOfOrder).length;
console.log(`all-steps-present-but-reordered: ${outOfOrder}/${misses.length} (variable-binding/ordering axis)`);
console.log(`some-steps-absent: ${missingSteps}/${misses.length} (coverage axis - holdout does different work)`);
const early = misses.filter((m) => m.prefix <= Math.floor(gram.length / 2)).length;
const late = misses.length - early;
console.log(`early-divergence (prefix <= ${Math.floor(gram.length / 2)}): ${early} | late: ${late}`);

// honest attribution verdict
let verdict: string;
if (misses.length === 0) verdict = 'no misses - nothing to attribute';
else if (outOfOrder / misses.length >= 0.5) verdict = 'ORDERING axis dominates: the actions exist but in different order - variable binding / partial-order procedures are the fix, not more data';
else if (early / misses.length >= 0.5) verdict = 'TRIGGER/PRECONDITION axis dominates: the opening does not generalize - precondition mining is the fix';
else verdict = 'COVERAGE axis dominates: holdout successes do different work - the workflow overfits one work-shape; counterexamples + skill families are the fix';
console.log(`\nATTRIBUTION: ${verdict}`);
