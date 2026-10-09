/**
 * Precondition Miner (v33 pack P1 v0.25): the Generalization Lab attributed
 * the skill target's 0.39 rejection to the TRIGGER/PRECONDITION axis - the
 * workflow's opening doesn't match holdout work shapes. This instrument
 * mines what ACTUAL preconditions should be: from holdout successes that
 * contain the workflow's steps (in any order), extract the CONTEXT that
 * preceded the action run - goal text, preceding action types, step counts.
 * The output is precondition candidates that a SkillSpecV2's preconditions[]
 * can consume, closing the lab's feedback loop:
 *
 *   axis attribution (done) -> counterexamples (done) -> PRECONDITIONS (this)
 *
 * The miner is honest: it reports FREQUENCY (how often a context element
 * precedes matching sequences), not causation. The preconditions are
 * suggestions for the skill compiler, not auto-promoted rules.
 */
import {
  loadTrajectories,
  mineWorkflows,
  type CognitiveTrajectory,
} from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

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
if (!top) { console.log('no mined workflows'); process.exit(0); }
const gram = top.steps;
console.log(`precondition-miner on '${env}' (${pool.length} trajectories)`);
console.log(`top workflow: [${gram.join(' → ')}] support=${top.support}`);

// For holdout successes containing ALL the workflow's steps (in any order),
// extract the context that PRECEDED the first occurrence of any gram step
const holdoutMatches = holdout.filter((t) => {
  if (!t.metrics.success) return false;
  const types = t.steps.map((s) => s.action.type);
  const set = new Set(types);
  return gram.every((g) => set.has(g));
});
console.log(`\nholdout successes containing all workflow steps (any order): ${holdoutMatches.length}/${holdout.filter((t) => t.metrics.success).length}`);

interface Precontext {
  trajId: string;
  goalText: string;
  precedingActionTypes: string[];
  stepOffset: number; // where in the trajectory the first gram step appears
  totalSteps: number;
}
const precontexts: Precontext[] = [];
for (const traj of holdoutMatches) {
  const types = traj.steps.map((s) => s.action.type);
  const firstGramIdx = types.findIndex((t) => gram.includes(t));
  if (firstGramIdx < 0) continue;
  precontexts.push({
    trajId: traj.id,
    goalText: traj.goal?.description ?? '',
    precedingActionTypes: types.slice(0, firstGramIdx),
    stepOffset: firstGramIdx,
    totalSteps: types.length,
  });
}

// Frequency analysis: what action types most often precede the workflow?
const precedingCounts = new Map<string, number>();
for (const pc of precontexts) {
  for (const at of pc.precedingActionTypes) {
    precedingCounts.set(at, (precedingCounts.get(at) ?? 0) + 1);
  }
}
const sortedPreceding = [...precedingCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n=== PRECONDITION CANDIDATES (frequency in ${precontexts.length} matching trajectories) ===`);
console.log('Most common preceding action types:');
for (const [type, count] of sortedPreceding.slice(0, 8)) {
  console.log(`  ${type}: ${count}/${precontexts.length} (${((count / precontexts.length) * 100).toFixed(0)}%)`);
}

// Position analysis: where does the workflow typically START?
const positions = precontexts.map((pc) => pc.stepOffset / Math.max(1, pc.totalSteps));
const meanPos = positions.length > 0 ? Number((positions.reduce((s, p) => s + p, 0) / positions.length).toFixed(2)) : 0;
console.log(`\nWorkflow start position (fraction through trajectory): mean ${meanPos}`);
console.log(`  (0=start of task, 0.5=middle, 1=end)`);
console.log(meanPos < 0.25
  ? '  → precondition: workflow tends to START tasks (no significant preamble needed)'
  : meanPos > 0.6
    ? '  → precondition: workflow runs LATE (significant context building precedes it)'
    : '  → precondition: workflow runs mid-task (moderate preamble)');

// Goal text analysis: what do the matching trajectories' goals have in common?
const goalWords = new Map<string, number>();
for (const pc of precontexts) {
  const words = pc.goalText.toLowerCase().split(/[\s,;.]+/).filter((w) => w.length > 2);
  for (const w of new Set(words)) goalWords.set(w, (goalWords.get(w) ?? 0) + 1);
}
const commonGoalWords = [...goalWords.entries()]
  .filter(([, c]) => c >= Math.max(2, Math.floor(precontexts.length * 0.2)))
  .sort((a, b) => b[1] - a[1]);
console.log(`\nCommon goal words (in ≥20% of matching trajectories):`);
if (commonGoalWords.length > 0) {
  for (const [w, c] of commonGoalWords.slice(0, 10)) {
    console.log(`  "${w}": ${c}/${precontexts.length} (${((c / precontexts.length) * 100).toFixed(0)}%)`);
  }
} else {
  console.log('  (no words reach the 20% threshold - goals are diverse)');
}

// Output as SkillSpecV2 preconditions format
console.log(`\n=== SUGGESTED PRECONDITIONS for SkillSpecV2.preconditions[] ===`);
const highFreq = sortedPreceding.filter(([, c]) => c >= Math.max(2, Math.floor(precontexts.length * 0.3)));
if (highFreq.length > 0) {
  console.log(`{ description: "workspace has seen: ${highFreq.slice(0, 3).map(([t]) => t).join(', ')}" }`);
}
console.log(`{ description: "workflow position: ${meanPos < 0.25 ? 'task-start' : meanPos > 0.6 ? 'late-task' : 'mid-task'} (mean offset ${meanPos})" }`);
if (commonGoalWords.length > 0) {
  console.log(`{ description: "goal mentions: ${commonGoalWords.slice(0, 3).map(([w]) => w).join(' | ')}" }`);
}
console.log(`\nNOTE: these are FREQUENCY-based suggestions from ${precontexts.length} observations -`);
console.log(`the skill compiler must verify them against its own gates before promotion.`);
