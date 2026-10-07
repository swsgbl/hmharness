/**
 * Prediction-to-Action three-arm instrument (weekly pack 0.24 P0 #1):
 * prove the learned World Model does not just predict better - its
 * confidence WOULD CHANGE action selection.
 *
 * The planner gate is where prediction enters action choice: an action
 * whose pre-step confidence falls below the gate gets deferred/verified.
 * So on the holdout we ask, per arm: would the gate have flagged the
 * actions that actually FAILED (early-warning rate), and how often would
 * it have needlessly flagged actions that SUCCEEDED (false-alarm rate)?
 * Discrimination = warning - falseAlarm; a learned WM that separates the
 * two is an WM that would change actions for the right reasons.
 *
 *   No-WM       : a fresh model (unseen actions -> neutral prior, flags ~nothing)
 *   Frozen-WM   : trained on the FIRST HALF of the train split only (stale)
 *   Learned-WM  : trained on the full train split
 *
 * Honesty rules: predict-only scoring (no belief updates during eval),
 * per-seed single-use holdout, observational framing (the gate is the
 * MEASURED proxy for action selection, not a live planner run), and the
 * verdict compares discrimination rather than claiming task-success gains.
 */
import { loadTrajectories, WorldModel, replayIntoWorldModel, type CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const SEEDS = process.argv[2] ? Number(process.argv[2]) : 3;
/** the first run's honest negative: a single 0.5 gate is a COARSE lens on
 *  data whose belief EMA converges early - sweep operating points instead */
const GATES = [0.3, 0.5, 0.7];

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

interface ArmStats { flaggedFail: number; failSteps: number; flaggedOk: number; okSteps: number }
function gateStats(wm: WorldModel, holdout: CognitiveTrajectory[], env: string, gate: number): ArmStats {
  const s: ArmStats = { flaggedFail: 0, failSteps: 0, flaggedOk: 0, okSteps: 0 };
  for (const traj of holdout) {
    if (traj.environment.id !== env) continue;
    for (const step of traj.steps) {
      const p = wm.predict({ action: step.action });
      const flagged = p.confidence < gate;
      if (step.outcome === 'failure') { s.failSteps++; if (flagged) s.flaggedFail++; }
      else if (step.outcome === 'success') { s.okSteps++; if (flagged) s.flaggedOk++; }
    }
  }
  return s;
}
const rate = (n: number, d: number) => (d > 0 ? Number((n / d).toFixed(3)) : 0);

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0);
const byEnv = new Map<string, number>();
for (const t of usable) byEnv.set(t.environment.id, (byEnv.get(t.environment.id) ?? 0) + 1);
const env = [...byEnv.entries()].sort((a, b) => b[1] - a[1])[0][0];
const pool = usable.filter((t) => t.environment.id === env);
console.log(`prediction-to-action x${SEEDS} on '${env}' (${pool.length} trajectories), gates=[${GATES.join(', ')}]`);

const wins: boolean[] = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = `p2a-${i + 1}`;
  const rand = mulberry32(hashSeed(seed));
  const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const cut = Math.floor(shuffled.length * 0.7);
  const train = shuffled.slice(0, cut);
  const holdout = shuffled.slice(cut);
  const frozenCut = Math.floor(train.length / 2);
  const learned = replayIntoWorldModel(train, env);
  const frozen = replayIntoWorldModel(train.slice(0, frozenCut), env);
  const none = new WorldModel(env);

  console.log(`\n${seed} (train ${train.length}, holdout ${holdout.length}, frozen on first ${frozenCut})`);
  for (const gate of GATES) {
    const arms: Record<string, ArmStats> = {
      'No-WM': gateStats(none, holdout, env, gate),
      'Frozen-WM': gateStats(frozen, holdout, env, gate),
      'Learned-WM': gateStats(learned, holdout, env, gate),
    };
    const disc: Record<string, number> = {};
    for (const [name, s] of Object.entries(arms)) {
      const warning = rate(s.flaggedFail, s.failSteps);
      const falseAlarm = rate(s.flaggedOk, s.okSteps);
      disc[name] = Number((warning - falseAlarm).toFixed(3));
    }
    console.log(`  gate=${gate}: ` + Object.entries(arms).map(([name, s]) => {
      const warning = rate(s.flaggedFail, s.failSteps);
      const falseAlarm = rate(s.flaggedOk, s.okSteps);
      return `${name} w=${warning} fa=${falseAlarm} d=${disc[name]}`;
    }).join('  |  '));
    wins.push(disc['Learned-WM'] > disc['Frozen-WM']);
  }
}
const learnedWins = wins.filter(Boolean).length;
const total = wins.length;
console.log(`\nSUMMARY: learned > frozen at ${learnedWins}/${total} (seed x gate) operating points`);
console.log(learnedWins === total
  ? 'VERDICT: the learned WM\'s gate dominates the frozen one at every operating point - prediction that would change action selection'
  : learnedWins > total / 2
    ? 'VERDICT: majority direction - promising, not yet operating-point-robust'
    : 'VERDICT: no robust action-selection separation yet - honest negative; next lenses: per-action-type analysis or a richer action vocabulary environment');
