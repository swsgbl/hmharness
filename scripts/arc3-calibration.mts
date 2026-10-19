/**
 * ARC-AGI-3 calibration reading (2026-10-19, zero API cost): the current
 * Brier/trend for the arc3 environment specifically, from the 31 collected
 * LLM-play trajectories. Read-only analysis.
 */
import { calibrationTrend, loadTrajectories } from '../packages/cognitive/src/index.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 1000);
const arc = all.filter((t) => t.environment.id === 'arc3');
const steps = arc.reduce((n, t) => n + t.steps.length, 0);
console.log(`arc3 trajectories: ${arc.length}, steps: ${steps}`);
if (arc.length === 0) { console.log('no arc3 data'); process.exit(0); }
for (const t of arc.slice(0, 3)) {
  const succ = t.steps.filter((s) => s.outcome === 'success').length;
  console.log(`  ${t.id.slice(0, 40)}: ${t.steps.length} steps, ${succ} success, metrics.success=${t.metrics.success}`);
}
const trend = await calibrationTrend(HOME, 5, 'arc3');
console.log('\narc3 calibration trend (last 5 buckets):');
console.log(JSON.stringify(trend, null, 1).slice(0, 1200));
