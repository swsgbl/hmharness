/**
 * The first REAL learning cycle over the machine's accumulated trajectories
 * (upgrade pack stage C acceptance path). Honest by construction:
 *  - EVAL-IND style split: seeded shuffle, 70/30 train/holdout
 *  - both real targets (skill mining, world_model replay) run the registry
 *    pipeline with holdout gates; rejections are honest outcomes
 *  - every cycle event lands in the REAL cognitive ledger under HMH_HOME
 */
import {
  loadTrajectories,
  LearningTargetRegistry,
  CognitiveLedger,
  appendLedgerEvent,
  registerSkillTarget,
  registerWorldModelTarget,
  type CognitiveTrajectory,
  type LearningDataset,
} from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const SEED = 'real-cycle-2026-10-07';

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0);
console.log(`loaded ${all.length} trajectories, ${usable.length} with steps`);
const byEnv = new Map<string, number>();
for (const t of usable) byEnv.set(t.environment.id, (byEnv.get(t.environment.id) ?? 0) + 1);
console.log('by environment:', JSON.stringify([...byEnv]));

// pick the richest environment
const env = [...byEnv.entries()].sort((a, b) => b[1] - a[1])[0][0];
const pool = usable.filter((t) => t.environment.id === env);
console.log(`environment '${env}': ${pool.length} trajectories`);

// seeded 70/30 split
const rand = mulberry32(hashSeed(SEED));
const shuffled = [...pool].map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
const cut = Math.floor(shuffled.length * 0.7);
const train: LearningDataset = { trajectories: shuffled.slice(0, cut) };
const holdoutList: CognitiveTrajectory[] = shuffled.slice(cut);
let holdoutUsed = false;
const holdout = async (): Promise<LearningDataset> => {
  holdoutUsed = true;
  return { trajectories: holdoutList };
};
console.log(`split: train=${train.trajectories.length} holdout=${holdoutList.length} (seed ${SEED})`);

const ledger = new CognitiveLedger();
const registry = new LearningTargetRegistry();
registry.ledger = ledger;
registerSkillTarget(registry, { holdout, lineageSource: 'real-cycle ' + SEED });
registerWorldModelTarget(registry, { environmentId: env, holdout, lineageSource: 'real-cycle ' + SEED });

for (const target of ['skill', 'world_model'] as const) {
  try {
    const out = await registry.runCycle({ opportunityId: `real-${SEED}`, target, payload: {} } as never, train);
    console.log(`\n=== ${target} ===`);
    console.log(`decision: ${out.decision}  bar: ${out.bar}`);
    console.log(`reason: ${out.reason}`);
    console.log(`metrics: ${JSON.stringify(out.evalResult?.metrics)}`);
  } catch (e) {
    console.log(`\n=== ${target} === ERROR ${String(e)}`);
  }
}
console.log(`\nholdout was used: ${holdoutUsed}`);
console.log(`ledger events: ${ledger.summary().total} (${JSON.stringify(ledger.summary().byKind)})`);

// persist the cycle into the REAL ledger store
await mkdir(join(HOME, 'cognitive'), { recursive: true });
for (const e of ledger.events()) await appendLedgerEvent(HOME, e);
console.log('ledger persisted to', join(HOME, 'cognitive', 'ledger.jsonl'));
