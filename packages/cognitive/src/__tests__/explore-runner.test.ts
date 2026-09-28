import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExploration } from '../explore-runner.ts';
import { MemoryEnvironment } from '../registry.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-explore-'));
}

test('explore-runner: probes unknown affordances, lands trajectory + episodic index', async () => {
  const home = await tmpHome();
  const summary = await runExploration(home, {
    environmentId: 'memory',
    maxActions: 4,
    maxCost: 10,
    env: new MemoryEnvironment('memory'),
  });
  assert.ok(summary.result.actionsTaken >= 1, 'must probe at least one affordance');
  assert.ok(summary.result.actionsTaken <= 4, 'must respect the budget');
  // trajectory landed with predictions recorded (calibration data)
  const trajText = await readFile(join(home, 'cognitive', 'trajectories', `${summary.trajectoryId}.jsonl`), 'utf8');
  const traj = JSON.parse(trajText.trim());
  assert.equal(traj.environment.id, 'memory');
  assert.equal(traj.steps.length, summary.result.actionsTaken);
  assert.ok(traj.steps.every((s: { prediction?: unknown }) => s.prediction), 'every exploration step carries a prediction');
  assert.ok(traj.metrics.brierScore !== undefined);
  // episodic index with explore provenance
  const memText = await readFile(join(home, 'cognitive', 'memory', 'memory.jsonl'), 'utf8');
  const entry = JSON.parse(memText.trim());
  assert.equal(entry.source, 'exploration-run');
  assert.equal(entry.environment, 'memory');
  assert.match(entry.content, /^EXPLORE memory/);
  await rm(home, { recursive: true, force: true });
});

test('explore-runner: layering rule — headless non-memory env is rejected honestly', async () => {
  const home = await tmpHome();
  await assert.rejects(
    () => runExploration(home, { environmentId: 'browser' }),
    /requires opts.env/,
  );
  await rm(home, { recursive: true, force: true });
});
