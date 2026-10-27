'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registrySkipDecision } = require('./publish-registry-skip-policy.cjs');

test('only a verified byte-for-byte match can be skipped automatically', () => {
  assert.deepEqual(
    registrySkipDecision({ ok: true, verified: true }),
    { skip: true, verified: true, reason: 'registry tarball content matched exactly' }
  );
});

test('a registry mismatch fails closed by default', () => {
  const result = registrySkipDecision({
    ok: false,
    diffs: ['package/index.js'],
    reason: 'local tarball differs from the published registry tarball'
  });
  assert.equal(result.skip, false);
  assert.equal(result.verified, false);
  assert.match(result.reason, /differs/);
});

test('registry/network comparison failures cannot be described as verified', () => {
  const result = registrySkipDecision({ ok: false, reason: 'registry comparison unavailable: fetch failed' });
  assert.deepEqual(result, {
    skip: false,
    verified: false,
    reason: 'registry comparison unavailable: fetch failed'
  });
});

test('an unverified skip requires the explicit override and remains labelled unverified', () => {
  const result = registrySkipDecision({ ok: false, reason: 'temporary registry outage' }, true);
  assert.equal(result.skip, true);
  assert.equal(result.verified, false);
  assert.match(result.reason, /outage/);
});

test('an incomplete comparison object cannot pass as verified', () => {
  const result = registrySkipDecision({ ok: true });
  assert.equal(result.skip, false);
  assert.equal(result.verified, false);
});
