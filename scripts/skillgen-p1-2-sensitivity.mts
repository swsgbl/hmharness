/** P1-2 EXPLORATORY sensitivity (post-hoc, NOT part of the preregistered
 * verdict): containment rates of ALL signal-carrying candidates, to see what
 * the gate COULD have picked. Holdout reading here is exploratory by
 * definition — labeled as such everywhere it appears. */
import { loadTrajectories, mineWorkflows, minePreconditions, hasContextSignal } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 2000);
const usable = all.filter((t) => t.steps.length > 0);
const out: Record<string, unknown[]> = {};
for (const fam of ['terminal', 'harmonyos', 'browser']) {
  const pool = usable.filter((t) => t.environment.id === fam);
  const rand = mulberry32(hashSeed('real-cycle-2026-10-07'));
  const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const cut = Math.floor(shuffled.length * 0.7);
  const train = shuffled.slice(0, cut);
  const holdout = shuffled.slice(cut).filter((t) => t.metrics.success);
  const cands = mineWorkflows(train, { minSupport: 2, nMin: 2, nMax: 4 });
  const seqs = holdout.map((t) => t.steps.filter((s) => s.outcome === 'success').map((s) => s.action.type));
  const rows = cands.slice(0, 12).map((c) => {
    const sig = hasContextSignal(minePreconditions(c, train));
    const hits = seqs.filter((seq) => {
      outer: for (let i = 0; i + c.steps.length <= seq.length; i++) {
        for (let j = 0; j < c.steps.length; j++) if (seq[i + j] !== c.steps[j]) continue outer;
        return true;
      }
      return false;
    }).length;
    return { steps: c.steps.join('|'), support: c.support, signal: sig, holdoutContainment: Number((hits / seqs.length).toFixed(3)) };
  });
  out[fam] = rows;
  console.log(`\n=== ${fam} (n=${seqs.length}) top-12 in arm-A order ===`);
  for (const r of rows) console.log(`  [${r.signal ? 'SIGNAL' : '  no '}] sup=${r.support} cont=${r.holdoutContainment} ${r.steps.slice(0, 70)}`);
}
