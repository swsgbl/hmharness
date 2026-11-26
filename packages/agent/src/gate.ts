/**
 * @hmharness/agent - gate (2026-10-15, v0.24 P2A research deploy)
 *
 * Production opt-in action gate. The 66-run live experiment arc proved the
 * MECHANISM (WM -> kernel toolGate -> refusal -> model re-plans) and the
 * SELECTIVITY (fires only on the corpus's genuinely divergent pair,
 * read_file->edit_file 0.56 vs 0.83 baseline), but no synthetic task suite
 * reproduces the real-session failures that produced the corpus signal.
 * The next instrument is production A/B telemetry — this module makes that
 * deployable: config `gate: { enabled: true, tau: 0.7 }` wires a
 * sequence-conditioned gate into every run, default remains OFF.
 *
 * Policy (identical to scripts/p2a-intervention.mts arm C, extracted here
 * so production and experiment share one implementation):
 *   - pair (last-executed type -> this type) with support >= MIN_SUPPORT
 *     decides, in BOTH directions (risky pair blocks, benign pair passes);
 *   - else the per-type rate with support >= MIN_SUPPORT decides;
 *   - else NO EVIDENCE = allow (the WM contract: knownUnknown is an explore
 *     signal, never 0% success).
 *
 * Two ways out of a block (2026-11-26). As first deployed, a blocked action
 * type could never recover: the tables counted EVERY observation ever made,
 * and a refused action is never executed, so nothing new could ever be
 * recorded about it. On the machine this was found on, `web_search` sat at
 * 0 of 23 with no way back - and every refusal of it was being written down
 * as one more failed `web_search` (fixed where outcomes are recorded).
 *   - EVIDENCE EXPIRES: only trajectories from the last WINDOW_DAYS count.
 *   - ONE REAL RUN PER TASK: the first time a task hits a blocked verdict
 *     the action runs anyway (both levels: pair and type). It costs one
 *     call, and it is how the tables learn that an action works again.
 */
import type { LoopToolGate } from '@hmharness/kernel';
import { loadTrajectories } from '@hmharness/cognitive';

export const GATE_MIN_SUPPORT = 10;
export const GATE_WINDOW_DAYS = 30;

export interface Count { s: number; f: number }
export type StatTable = Map<string, Count>;

export interface GateStats {
  consults: number;
  refusals: number;
  /** blocked verdicts that were let through for one real run */
  explorations: number;
  types: number;
  pairs: number;
  tau: number;
}

/** Pure decision policy over precomputed tables — the single implementation
 *  shared by the lab script and production (tested directly). */
export function conditionedPolicy(typeStat: StatTable, pairStat: StatTable, tau: number, opts: { explore?: boolean } = {}) {
  const explore = opts.explore !== false;
  let lastType: string | null = null; // last ALLOWED action (executions change the world, refusals do not)
  let consults = 0;
  let refusals = 0;
  let explorations = 0;
  const explored = new Set<string>(); // blocked actions that already had their real run in this task
  const verdictOf = (name: string): { allowed: true } | { allowed: false; reason: string } => {
    const pair = lastType !== null ? pairStat.get(`${lastType}->${name}`) : undefined;
    const pairN = pair ? pair.s + pair.f : 0;
    const type = typeStat.get(name);
    const typeN = type ? type.s + type.f : 0;
    if (pairN >= GATE_MIN_SUPPORT) {
      const pr = pair!.s / pairN;
      return pr < tau
        ? { allowed: false, reason: `the learned world model predicts ${lastType}->${name} fails often in similar contexts (pair success ${pr.toFixed(2)} < ${tau}, ${pairN} observations); choose a different approach or verify prerequisites first` }
        : { allowed: true };
    }
    if (typeN >= GATE_MIN_SUPPORT) {
      const tr = type!.s / typeN;
      return tr < tau
        ? { allowed: false, reason: `the learned world model predicts this action type (${name}) tends to fail (success ${tr.toFixed(2)} < ${tau}, ${typeN} observations); choose a different approach or verify prerequisites first` }
        : { allowed: true };
    }
    return { allowed: true };
  };
  return {
    check(name: string): { allowed: true } | { allowed: false; reason: string } {
      consults++;
      const v = verdictOf(name);
      if (v.allowed) {
        lastType = name;
        return v;
      }
      // Keyed by the ACTION, not by the verdict that blocked it: an explored
      // action becomes the "previous action", and the very next attempt at it
      // is then judged as a pair (it -> itself) - a different verdict that
      // would otherwise buy the same action a second real run.
      if (explore && !explored.has(name)) {
        explored.add(name);
        explorations++;
        lastType = name; // it runs, so it changes the world like any allowed action
        return { allowed: true };
      }
      refusals++;
      return v;
    },
    stats: (): GateStats => ({ consults, refusals, explorations, types: typeStat.size, pairs: pairStat.size, tau }),
  };
}

/** Build the gate from this home's recent terminal corpus (same train-split
 *  protocol as the experiments: seed 1, 70/30). An empty corpus yields an
 *  all-allow gate — no evidence never blocks. */
export async function buildConditionedGate(home: string, tau: number, windowDays = GATE_WINDOW_DAYS): Promise<LoopToolGate & { stats(): GateStats }> {
  const typeStat: StatTable = new Map();
  const pairStat: StatTable = new Map();
  try {
    const all = await loadTrajectories(home, 1000);
    const cutoff = Date.now() - windowDays * 86_400_000;
    const usable = all.filter((t) => {
      if (t.steps.length === 0 || t.environment.id !== 'terminal') return false;
      // evidence expires: a trajectory older than the window says nothing about today.
      // A trajectory with no readable start time is kept (nothing says it is old)
      const started = Date.parse(String(t.startedAt ?? ''));
      return !Number.isFinite(started) || started >= cutoff;
    });
    // deterministic split (seed 1) — analysis-only, no decision leakage
    const rng = mulberry32(hashSeed('p2a-intervention-1'));
    const shuffled = usable.toSorted(() => rng() - 0.5);
    const train = shuffled.slice(0, Math.floor(shuffled.length * 0.7));
    const bump = (m: StatTable, k: string, ok: boolean) => {
      const e = m.get(k) ?? { s: 0, f: 0 };
      if (ok) e.s++; else e.f++;
      m.set(k, e);
    };
    for (const t of train) {
      let prev: string | null = null;
      for (const s of t.steps) {
        const type = String((s.action as { type?: unknown }).type ?? '?');
        if (s.outcome === 'success' || s.outcome === 'failure') {
          bump(typeStat, type, s.outcome === 'success');
          if (prev !== null) bump(pairStat, `${prev}->${type}`, s.outcome === 'success');
        }
        prev = type;
      }
    }
  } catch {
    // unreadable corpus = no evidence = all-allow (the gate must never take
    // the agent down; it is an advisor, not a dependency)
  }
  const policy = conditionedPolicy(typeStat, pairStat, tau);
  return {
    check: async (name: string) => policy.check(name),
    stats: policy.stats,
  };
}

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
