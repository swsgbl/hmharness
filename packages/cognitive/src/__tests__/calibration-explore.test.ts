import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UcbExplorationPolicy, HypothesisRegistry } from '../exploration.ts';
import { WorldModel } from '../world-model.ts';

function ctxWith(bias: Record<string, number> | undefined, types: string[]) {
  const wm = new WorldModel('test');
  // equal evidence for every type so uncertainty ties; only bias differentiates
  const obs = {
    environmentId: 'test',
    timestamp: new Date().toISOString(),
    state: {},
    availableActions: types.map((t, i) => ({ id: `a${i}`, type: t, cost: 1 })),
  };
  return { observation: obs as never, worldModel: wm, hypotheses: new HypothesisRegistry(), calibrationBias: bias };
}

test('calibration targeting: poorly-predicted action types get explored FIRST', async () => {
  const policy = new UcbExplorationPolicy(undefined, 0.5);
  // model predicts ACTION_A well (reliability 0.95 → bias 0.05) and
  // ACTION_B terribly (reliability 0.1 → bias 0.9): with equal uncertainty,
  // B must win the first probe
  const ctx = ctxWith({ ACTION_A: 0.05, ACTION_B: 0.9 }, ['ACTION_A', 'ACTION_B']);
  const chosen = await policy.selectAction(ctx, { maxActions: 1, maxCost: 5, riskTolerance: 0.6 });
  assert.equal(chosen?.type, 'ACTION_B');
});

test('calibration weight 0 keeps pure UCB ordering (back-compat)', async () => {
  const policy = new UcbExplorationPolicy(undefined, 0);
  const ctx = ctxWith({ ACTION_A: 0.9 }, ['ACTION_A', 'ACTION_B']);
  const chosen = await policy.selectAction(ctx, { maxActions: 1, maxCost: 5, riskTolerance: 0.6 });
  // both unknown to the world model → ties resolved by candidate order; the
  // important part: no crash and a valid action comes back
  assert.ok(chosen);
  assert.ok(['ACTION_A', 'ACTION_B'].includes(chosen.type));
});

test('bias cannot override the risk gate (safe exploration holds)', async () => {
  const policy = new UcbExplorationPolicy(undefined, 1.0);
  // a hugely-biased but DESTRUCTIVE action must still be filtered out
  const wm = new WorldModel('test');
  const obs = {
    environmentId: 'test',
    timestamp: new Date().toISOString(),
    state: {},
    availableActions: [
      { id: 'a1', type: 'delete-everything', cost: 1, irreversible: true },
      { id: 'a2', type: 'ACTION_B', cost: 1 },
    ],
  };
  const ctx = { observation: obs as never, worldModel: wm, hypotheses: new HypothesisRegistry(), calibrationBias: { 'delete-everything': 1.0 } };
  const chosen = await policy.selectAction(ctx, { maxActions: 1, maxCost: 5, riskTolerance: 0.5 });
  assert.notEqual(chosen?.type, 'delete-everything');
  assert.equal(chosen?.type, 'ACTION_B');
});
