/**
 * P2A context-conditioning probe (zero-API, 2026-10-15): the v0.24 live
 * experiment located the gate's gap precisely — per-action-TYPE confidence
 * is either selective-but-inert (tau .5) or behavior-changing-but-risky
 * (tau .9). This probe asks whether SEQUENCE context adds signal the type
 * baseline doesn't carry: on the same train split, compare
 *
 *    P(success | type)                    (what the current gate uses)
 *    P(success | prev.type -> type)       (one step of context)
 *
 * Rules of honesty: pairs below MIN_SUPPORT back off to the type rate
 * (never report a rate built on 2 observations); divergence is reported
 * with both rates and support. If no pair diverges meaningfully,
 * context-conditioning at sequence depth 1 is NEEDS-DATA and we say so.
 */
import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const MIN_SUPPORT = 10;
const DIVERGENCE = 0.15;

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0 && t.environment.id === 'terminal');
const rng = mulberry32(hashSeed('p2a-intervention-1'));
const shuffled = [...usable].sort(() => rng() - 0.5);
const train = shuffled.slice(0, Math.floor(shuffled.length * 0.7));

// type-of(step) — the same projection predict() keys on
const typeOf = (s: { action: { type?: unknown } }) => String(s.action.type ?? '?');

// per-type and per-pair success/fail counts over DECIDED steps only
const typeStat = new Map<string, { s: number; f: number }>();
const pairStat = new Map<string, { s: number; f: number }>();
const bump = (m: Map<string, { s: number; f: number }>, k: string, ok: boolean) => {
  const e = m.get(k) ?? { s: 0, f: 0 };
  if (ok) e.s++; else e.f++;
  m.set(k, e);
};
for (const t of train) {
  let prev: string | null = null;
  for (const s of t.steps) {
    const type = typeOf(s as never);
    const decided = s.outcome === 'success' || s.outcome === 'failure';
    if (decided) {
      bump(typeStat, type, s.outcome === 'success');
      if (prev !== null) bump(pairStat, `${prev}->${type}`, s.outcome === 'success');
    }
    prev = type;
  }
}

const rate = (e: { s: number; f: number }) => e.s / (e.s + e.f);
console.log(`train split: ${train.length} trajectories; ${typeStat.size} types, ${pairStat.size} pairs`);

// divergence table: pairs with enough support whose rate differs from the type baseline
const rows: Array<{ pair: string; type: string; pairRate: number; typeRate: number; n: number; delta: number }> = [];
for (const [pair, e] of pairStat) {
  const n = e.s + e.f;
  if (n < MIN_SUPPORT) continue;
  const type = pair.split('->')[1];
  const te = typeStat.get(type);
  if (!te || te.s + te.f < MIN_SUPPORT) continue;
  const pr = rate(e);
  const tr = rate(te);
  if (Math.abs(pr - tr) >= DIVERGENCE) rows.push({ pair, type, pairRate: pr, typeRate: tr, n, delta: pr - tr });
}
rows.sort((a, b) => a.delta - b.delta);
const qualified = [...pairStat.values()].filter((e) => e.s + e.f >= MIN_SUPPORT).length;
console.log(`pairs with support >= ${MIN_SUPPORT}: ${qualified}/${pairStat.size}`);
console.log(`divergent pairs (|pairRate - typeRate| >= ${DIVERGENCE}): ${rows.length}`);
console.log('\n=== WORSE than the type baseline (the conditioned gate would block these) ===');
for (const r of rows.filter((r) => r.delta < 0).slice(0, 12)) {
  console.log(`  ${r.pair}: ${r.pairRate.toFixed(2)} vs ${r.typeRate.toFixed(2)}  (${r.n} obs, delta ${r.delta.toFixed(2)})`);
}
console.log('\n=== BETTER than the type baseline (conditioning would PASS these where the type gate might not) ===');
for (const r of rows.filter((r) => r.delta > 0).slice(-12)) {
  console.log(`  ${r.pair}: ${r.pairRate.toFixed(2)} vs ${r.typeRate.toFixed(2)}  (${r.n} obs, delta ${r.delta.toFixed(2)})`);
}

if (rows.length === 0) {
  console.log('\nVERDICT: NEEDS-DATA — sequence depth-1 conditioning adds no signal on this corpus (no pair diverges). Deeper context (state keys, args shape) or more corpus required.');
} else {
  const worst = rows.filter((r) => r.delta < 0);
  console.log(`\nVERDICT: ${rows.length} divergent pair(s) (${worst.length} worse / ${rows.length - worst.length} better) — conditioning carries REAL signal beyond the type baseline.`);
}
