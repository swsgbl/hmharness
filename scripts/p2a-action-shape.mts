import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((x) => x.steps.length > 0 && x.environment.id === 'terminal');
const types = new Map<string, number>();
for (const t of usable) for (const s of t.steps) {
  const k = String((s.action as { type?: unknown }).type ?? '?');
  types.set(k, (types.get(k) ?? 0) + 1);
}
console.log('terminal corpus action.type vocabulary (' + usable.length + ' trajectories):');
for (const [k, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
