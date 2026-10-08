import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldModel } from '../world-model.ts';
import type { Action, Observation } from '../protocol.ts';

function mkAction(type: string, id = 'a1'): Action {
  return { id, type, args: {} };
}
function mkObs(envId = 'terminal'): Observation {
  return { environmentId: envId, timestamp: new Date().toISOString(), state: null, availableActions: [] };
}
function apply(wm: WorldModel, type: string, outcome: 'success' | 'failure', stateBefore?: unknown, stateAfter?: unknown) {
  const pred = wm.predict({ action: mkAction(type) });
  wm.update({
    stateBefore: (stateBefore ?? wm.worldState) as never,
    action: mkAction(type),
    observation: mkObs(),
    outcome,
    predictionId: pred.id,
    ...(stateAfter !== undefined ? { stateAfter: stateAfter as never } : {}),
  });
}

test('checkpoint: round-trip preserves state, accuracy counters, beliefs, and transitions', () => {
  const wm = new WorldModel('terminal');
  for (let i = 0; i < 10; i++) apply(wm, 'alpha', i < 8 ? 'success' : 'failure');
  for (let i = 0; i < 5; i++) apply(wm, 'beta', 'success');
  const cal = wm.calibration();
  assert.ok(cal.resolved > 0, 'has resolved predictions');

  const json = wm.checkpoint();
  const restored = WorldModel.fromCheckpoint(json);
  assert.equal(restored.worldState.environmentId, 'terminal');
  assert.equal(restored.worldState.beliefs.length, wm.worldState.beliefs.length);
  assert.equal(restored.calibration().resolved, cal.resolved, 'resolved prediction count survives');
  assert.equal(restored.calibration().meanError, cal.meanError, 'mean error survives');
  // the restored model can CONTINUE: new predictions and updates work
  const p = restored.predict({ action: mkAction('gamma') });
  assert.ok(p.confidence >= 0 && p.confidence <= 1, 'restored model predicts');
  // kind guard
  assert.throws(() => WorldModel.fromCheckpoint('{"kind":"wrong"}'), /not a world-model checkpoint/);
});

test('stale beliefs: old confirmations flagged, fresh ones not; fresh model no false alarms', () => {
  const wm = new WorldModel('terminal');
  // fresh model (version 1) -> no stale-belief false alarms even with no confirmations
  assert.deepEqual(wm.staleBeliefs(60_000), [], 'fresh model should not flag');

  // warm up: create beliefs and bump version (inline to match the verified debug path)
  const obs = mkObs();
  for (let i = 0; i < 5; i++) {
    const a = mkAction('alpha', 'a' + i);
    const pred = wm.predict({ action: a });
    wm.update({ stateBefore: wm.worldState, action: a, observation: obs, outcome: 'success', predictionId: pred.id });
  }
  assert.ok(wm.worldState.version > 1, 'model is warm');
  assert.ok(wm.worldState.beliefs.length > 0, 'beliefs exist');

  // all beliefs were just confirmed -> none stale at 1h threshold
  const now = new Date();
  const none = wm.staleBeliefs(3_600_000, now);
  assert.equal(none.length, 0, 'recently confirmed beliefs are not stale');

  // at 0ms threshold (everything older than now), all beliefs are stale
  const all = wm.staleBeliefs(0, now);
  assert.ok(all.length > 0, `zero threshold flags everything (got ${all.length} for ${wm.worldState.beliefs.length} beliefs)`);
  assert.ok(all.every((b) => b.ageMs >= 0));
  assert.ok(all[0].id.startsWith('act:'));
});
