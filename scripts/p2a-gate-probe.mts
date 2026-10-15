/**
 * P2A v3 follow-up probe (zero-API): the learned WM's per-action-type
 * confidence landscape on the SAME train split the intervention used,
 * queried the way predict() actually keys (action.type — first run passed
 * bare strings, keying everything to 'undefined' and blanket-refusing).
 * Also marks knownUnknown (no evidence) which per the WM contract is an
 * EXPLORE signal, not 0% success — the gate must allow those through.
 */
import { loadTrajectories, replayIntoWorldModel } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0 && t.environment.id === 'terminal');
const rng = mulberry32(hashSeed('p2a-intervention-1'));
const shuffled = [...usable].sort(() => rng() - 0.5);
const train = shuffled.slice(0, Math.floor(shuffled.length * 0.7));
const wm = replayIntoWorldModel(train, 'terminal');

// vocabulary: project corpus steps to action.type (the key predict() uses)
const counts = new Map<string, number>();
for (const t of train) for (const s of t.steps) {
  const k = String((s.action as { type?: unknown }).type ?? '?');
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
const rows = [...counts.entries()]
  .map(([n, c]) => {
    const p = wm.predict({ action: { type: n } });
    const unknown = p.claim.startsWith('no evidence');
    return { n, corpusSteps: c, conf: p.confidence, unknown };
  })
  .sort((a, b) => a.conf - b.conf);
console.log('=== per-action-type confidence (train split, sorted) ===');
for (const r of rows) console.log(`  ${r.conf.toFixed(3)}${r.unknown ? ' (no-evidence)' : '            '}  ${r.n}  [${r.corpusSteps} steps]`);
for (const tau of [0.5, 0.4, 0.3, 0.2]) {
  const blocked = rows.filter((r) => !r.unknown && r.conf < tau);
  console.log(`tau=${tau}: would block ${blocked.length}/${rows.length} KNOWN types -> ${blocked.map((r) => r.n).join(', ') || '(none)'}`);
}
