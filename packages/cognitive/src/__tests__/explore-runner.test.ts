import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExploration } from '../explore-runner.ts';
import { MemoryEnvironment } from '../registry.ts';
import { UcbExplorationPolicy } from '../exploration.ts';
import type { ActionSpec } from '../protocol.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-explore-'));
}

test('exploration: probe args are well-formed for the arg role (url/selector/path)', async () => {
  // a malformed probe (url='probe') measures arg synthesis, not the env:
  // every E_BAD_ACTION failure would pollute the calibration curve
  const policy = new UcbExplorationPolicy();
  const obs = {
    environmentId: 'x',
    timestamp: new Date().toISOString(),
    state: {},
    availableActions: [
      { id: 'navigate', type: 'navigate', description: 'open url', argsSchema: { url: 'string' }, cost: 1 },
      { id: 'click', type: 'click', description: 'click', argsSchema: { selector: 'string' }, cost: 1 },
      { id: 'write', type: 'write-file', description: 'write', argsSchema: { path: 'string', content: 'string' }, cost: 1 },
    ] satisfies ActionSpec[],
  };
  // minimal context: empty world model + no hypotheses entries
  const { WorldModel } = await import('../world-model.ts');
  const { HypothesisRegistry } = await import('../exploration.ts');
  const ctx = {
    observation: obs,
    worldModel: new WorldModel('x'),
    hypotheses: new HypothesisRegistry(),
  };
  const a1 = await policy.selectAction(ctx, { maxActions: 1, maxCost: 10, riskTolerance: 0.6 });
  const args1 = a1?.args as Record<string, string>;
  assert.ok(/^https?:\/\//.test(args1.url ?? args1.selector ?? args1.path ?? ''), 'url-like probe must be http(s)');
  // all three specs' probes are well-formed
  for (const spec of obs.availableActions) {
    const chosen = await policy.selectAction({ ...ctx, observation: { ...obs, availableActions: [spec] } }, { maxActions: 1, maxCost: 10, riskTolerance: 0.6 });
    const args = chosen?.args as Record<string, string>;
    assert.match(args.url ?? args.selector ?? 'probe', /^(https?:\/\/|a$|probe(\.txt)?$|probe$)/);
    if (spec.argsSchema.url) assert.equal(args.url, 'https://example.com');
    if (spec.argsSchema.selector) assert.equal(args.selector, 'a');
    if (spec.argsSchema.path) assert.equal(args.path, 'probe.txt');
  }
});

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
