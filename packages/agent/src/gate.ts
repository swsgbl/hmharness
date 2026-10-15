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
 */
import type { LoopToolGate } from '@hmharness/kernel';
import { loadTrajectories } from '@hmharness/cognitive';

export const GATE_MIN_SUPPORT = 10;

export interface Count { s: number; f: number }
export type StatTable = Map<string, Count>;

/** Pure decision policy over precomputed tables — the single implementation
 *  shared by the lab script and production (tested directly). */
export function conditionedPolicy(typeStat: StatTable, pairStat: StatTable, tau: number) {
  let lastType: string | null = null; // last ALLOWED action (executions change the world, refusals do not)
  let consults = 0;
  let refusals = 0;
  return {
    check(name: string): { allowed: true } | { allowed: false; reason: string } {
      consults++;
      const pair = lastType !== null ? pairStat.get(`${lastType}->${name}`) : undefined;
      const pairN = pair ? pair.s + pair.f : 0;
      const type = typeStat.get(name);
      const typeN = type ? type.s + type.f : 0;
      let v: { allowed: true } | { allowed: false; reason: string };
      if (pairN >= GATE_MIN_SUPPORT) {
        const pr = pair!.s / pairN;
        v = pr < tau
          ? { allowed: false, reason: `the learned world model predicts ${lastType}->${name} fails often in similar contexts (pair success ${pr.toFixed(2)} < ${tau}, ${pairN} observations); choose a different approach or verify prerequisites first` }
          : { allowed: true };
      } else if (typeN >= GATE_MIN_SUPPORT) {
        const tr = type!.s / typeN;
        v = tr < tau
          ? { allowed: false, reason: `the learned world model predicts this action type (${name}) tends to fail (success ${tr.toFixed(2)} < ${tau}, ${typeN} observations); choose a different approach or verify prerequisites first` }
          : { allowed: true };
      } else {
        v = { allowed: true };
      }
      if (v.allowed) lastType = name;
      if (!v.allowed) refusals++;
      return v;
    },
    stats: () => ({ consults, refusals, types: typeStat.size, pairs: pairStat.size, tau }),
  };
}

export interface GateStats {
  consults: number;
  refusals: number;
  types: number;
  pairs: number;
  tau: number;
}

/** Build the gate from this home's terminal corpus (same train-split
 *  protocol as the experiments: seed 1, 70/30). An empty corpus yields an
 *  all-allow gate — no evidence never blocks. */
export async function buildConditionedGate(home: string, tau: number): Promise<LoopToolGate & { stats(): GateStats }> {
  const typeStat: StatTable = new Map();
  const pairStat: StatTable = new Map();
  try {
    const all = await loadTrajectories(home, 1000);
    const usable = all.filter((t) => t.steps.length > 0 && t.environment.id === 'terminal');
    // deterministic split (seed 1) — analysis-only, no decision leakage
    const rng = mulberry32(hashSeed('p2a-intervention-1'));
    const shuffled = [...usable].sort(() => rng() - 0.5);
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
