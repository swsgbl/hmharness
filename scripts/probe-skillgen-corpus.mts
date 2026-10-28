/** P1-2 corpus probe: env distribution + goal shape + action vocabulary. */
import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 2000);
console.log('total loaded:', all.length);
const byEnv = new Map<string, { total: number; succ: number; withGoal: number }>();
for (const t of all) {
  const e = byEnv.get(t.environment.id) ?? { total: 0, succ: 0, withGoal: 0 };
  e.total++;
  if (t.metrics.success) e.succ++;
  if (t.goal?.description) e.withGoal++;
  byEnv.set(t.environment.id, e);
}
for (const [env, s] of [...byEnv.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${env}: total=${s.total} succ=${s.succ} withGoal=${s.withGoal}`);
}
console.log('\n--- sample goals (successful) ---');
let shown = 0;
for (const t of all) {
  if (!t.goal?.description || !t.metrics.success) continue;
  console.log(`[${t.environment.id}] ${t.goal.description.slice(0, 100).replace(/\n/g, ' ')}`);
  if (++shown >= 12) break;
}
const types = new Map<string, number>();
for (const t of all.filter(x => x.environment.id === 'terminal'))
  for (const s of t.steps) types.set(s.action.type, (types.get(s.action.type) ?? 0) + 1);
console.log('\n--- terminal action types ---');
for (const [ty, c] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${ty}: ${c}`);
