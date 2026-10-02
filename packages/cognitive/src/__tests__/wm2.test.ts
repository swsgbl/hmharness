import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldModel, stateDiff } from '../world-model.ts';
import type { Action, Observation } from '../protocol.ts';

function obs(state: Record<string, unknown>): Observation {
  return { environmentId: 'e', timestamp: new Date().toISOString(), state, availableActions: [] };
}

test('wm2: stateDiff finds added/removed/changed keys deterministically', () => {
  const before = { files: ['a'], counter: 1, keep: true };
  const after = { files: ['a', 'b'], counter: 2, extra: 'new' };
  const d = stateDiff(before, after);
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['keep']);
  assert.equal(d.changed.length, 2); // files + counter
  assert.deepEqual([...d.changed.map((c) => c.key)].sort(), ['counter', 'files']);
  // shape is the sorted union of touched keys — stable across call order
  assert.equal(d.shape, 'counter,extra,files,keep');
  assert.equal(stateDiff(after, after).shape, '');
});

test('wm2: predictDelta learns the modal shape and scores accuracy on update', () => {
  const wm = new WorldModel('e');
  // seed three transitions of type set-x: x changes each time, nothing else
  for (let i = 0; i < 3; i++) {
    wm.update({
      stateBefore: { environmentId: 'e', version: 1, entities: [], variables: { x: i, pad: 1 }, beliefs: [], uncertainty: { byAction: {} } },
      action: { id: `a${i}`, type: 'set-x', args: { v: i + 1 }, reason: 't' },
      observation: obs({ x: i + 1, pad: 1 }),
      outcome: 'success',
      stateAfter: { environmentId: 'e', version: 2, entities: [], variables: { x: i + 1, pad: 1 }, beliefs: [], uncertainty: { byAction: {} } },
    });
  }
  // delta shapes seen: x changed every time (values differ), pad unchanged
  const p = wm.predictDelta('set-x');
  assert.equal(p.n, 3);
  assert.equal(p.predictedShape, 'x');
  assert.equal(p.confidence, 1);
  // an unseen action type honestly knows nothing
  const unseen = wm.predictDelta('nope');
  assert.equal(unseen.predictedShape, null);
  assert.equal(unseen.confidence, 0);
  // scoring: bind a prediction id, land a matching transition -> accuracy 1
  const outcomePred = wm.predict({ action: { id: 'p', type: 'set-x', args: {}, reason: 't' } });
  wm.predictDelta('set-x', outcomePred.id);
  wm.update({
    stateBefore: { environmentId: 'e', version: 3, entities: [], variables: { x: 3, pad: 1 }, beliefs: [], uncertainty: { byAction: {} } },
    action: { id: 'a9', type: 'set-x', args: { v: 4 }, reason: 't' },
    observation: obs({ x: 4, pad: 1 }),
    outcome: 'success',
    predictionId: outcomePred.id,
    stateAfter: { environmentId: 'e', version: 4, entities: [], variables: { x: 4, pad: 1 }, beliefs: [], uncertainty: { byAction: {} } },
  });
  const acc = wm.deltaAccuracy();
  assert.equal(acc.checked, 1);
  assert.equal(acc.hits, 1);
  assert.equal(acc.accuracy, 1);
  // a DIFFERENT shape (two keys touched) counts as a miss
  const p2 = wm.predict({ action: { id: 'p2', type: 'set-x', args: {}, reason: 't' } });
  wm.predictDelta('set-x', p2.id);
  wm.update({
    stateBefore: { environmentId: 'e', version: 5, entities: [], variables: { x: 4, pad: 1 }, beliefs: [], uncertainty: { byAction: {} } },
    action: { id: 'a10', type: 'set-x', args: {}, reason: 't' },
    observation: obs({ x: 5, pad: 2 }),
    outcome: 'success',
    predictionId: p2.id,
    stateAfter: { environmentId: 'e', version: 6, entities: [], variables: { x: 5, pad: 2 }, beliefs: [], uncertainty: { byAction: {} } },
  });
  const acc2 = wm.deltaAccuracy();
  assert.equal(acc2.checked, 2);
  assert.equal(acc2.hits, 1);
  assert.equal(acc2.accuracy, 0.5);
});
