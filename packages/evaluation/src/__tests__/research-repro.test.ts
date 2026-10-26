import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentFingerprint, seededShuffle } from '../research-repro.ts';

test('canonicalJson sorts object keys recursively but preserves array order', () => {
  assert.equal(canonicalJson({ b: 2, a: { z: 1, c: 3 } }), '{"a":{"c":3,"z":1},"b":2}');
  assert.notEqual(canonicalJson({ steps: [1, 2] }), canonicalJson({ steps: [2, 1] }));
});

test('contentFingerprint is independent of record order and sensitive to record content', () => {
  const a = { id: 'traj-1', steps: [{ action: 'read', outcome: 'success' }], metrics: { actions: 1 } };
  const b = { id: 'traj-2', steps: [{ action: 'write', outcome: 'failure' }], metrics: { actions: 1 } };
  assert.equal(contentFingerprint([a, b]), contentFingerprint([b, a]));
  assert.notEqual(contentFingerprint([a, b]), contentFingerprint([a, { ...b, steps: [{ action: 'write', outcome: 'success' }] }]));
  assert.equal(contentFingerprint([]).length, 64);
});

test('seededShuffle is deterministic and returns a permutation', () => {
  const makeRng = (initial: number) => {
    let state = initial >>> 0;
    return () => {
      state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0;
      return (state >>> 0) / 0x1_0000_0000;
    };
  };
  const input = [1, 2, 3, 4, 5, 6];
  const one = seededShuffle(input, makeRng(42));
  const two = seededShuffle(input, makeRng(42));
  assert.deepEqual(one, two);
  assert.deepEqual([...one].sort((a, b) => a - b), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6], 'input must not be mutated');
});
