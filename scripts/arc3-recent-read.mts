/** newest-N arc3 play readings: levels completed, success, distinct actions */
import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const N = Number(process.argv[2] ?? 12);
const all = await loadTrajectories(HOME, 2000);
const arc = all
  .filter((t) => t.environment.id === 'arc3' && t.steps.length > 0)
  .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  .slice(0, N);
console.log(`newest ${arc.length} arc3 trajectories:`);
for (const t of arc) {
  const types = new Set(t.steps.map((s) => String((s.action as { type?: unknown }).type ?? '?')));
  const succ = t.steps.filter((s) => s.outcome === 'success').length;
  console.log(`  ${t.startedAt.slice(5, 16)} ${t.id.slice(14, 24)} steps=${String(t.steps.length).padStart(2)} success=${String(succ).padStart(2)} actions=[${[...types].join(',')}] metrics.success=${t.metrics.success} levels=${(t.metrics as { levelsCompleted?: number }).levelsCompleted ?? 0}`);
}
