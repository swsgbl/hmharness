import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLayerWrite, evolutionFeedOK, LAYER_POLICIES } from '../benchmark-layers.ts';

test('layers: the hidden holdout refuses every writer except the evaluator', () => {
  for (const writer of ['developer', 'public-source', 'user', 'evolution', 'agent'] as const) {
    assert.throws(() => assertLayerWrite('hidden', writer), new RegExp(`refuses writer '${writer}'`), `${writer} must not write hidden`);
  }
  assert.doesNotThrow(() => assertLayerWrite('hidden', 'evaluator'), 'the evaluator is the one allowed writer');
});

test('layers: public sets are read-only for the whole hmh side', () => {
  for (const writer of ['developer', 'user', 'evaluator', 'evolution', 'agent'] as const) {
    assert.throws(() => assertLayerWrite('public', writer), `${writer} must not modify a public set ("HMH 不得修改")`);
  }
  assert.doesNotThrow(() => assertLayerWrite('public', 'public-source'), 'ingestion marker only');
});

test('layers: internal and real-user writer policies', () => {
  assert.doesNotThrow(() => assertLayerWrite('internal', 'developer'));
  assert.throws(() => assertLayerWrite('internal', 'agent'));
  assert.doesNotThrow(() => assertLayerWrite('real-user', 'user'));
  assert.throws(() => assertLayerWrite('real-user', 'developer'));
});

test('feed: hidden tasks never enter an evolution training feed', () => {
  const feed = [
    { id: 'i-1', layer: 'internal' as const },
    { id: 'h-1', layer: 'hidden' as const },
    { id: 'p-1', layer: 'public' as const },
    { id: 'h-2', layer: 'hidden' as const },
  ];
  const check = evolutionFeedOK(feed);
  assert.equal(check.ok, false);
  assert.deepEqual(check.violations, ['h-1', 'h-2']);
  assert.deepEqual(evolutionFeedOK([{ id: 'i-1', layer: 'internal' }, { id: 'p-2', layer: 'public' }]), { ok: true, violations: [] });
  assert.equal(LAYER_POLICIES['hidden'].visibleToEvolution, false);
  assert.equal(LAYER_POLICIES['internal'].visibleToEvolution, true);
});
