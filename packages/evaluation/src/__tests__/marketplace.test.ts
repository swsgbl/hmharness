import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashFixture, signFixture, verifySignature, validateFixture, FixtureRegistry, type BenchmarkFixture } from '../marketplace.ts';

const mkFixture = (overrides: Partial<BenchmarkFixture> = {}): BenchmarkFixture => ({
  id: 'fx-001', name: 'Test Case', description: 'A test', category: 'exactness', difficulty: 1,
  prompt: 'reply with exactly: HELLO', expectedOutput: 'HELLO',
  assertionType: 'exact', assertionValue: 'HELLO',
  contributor: 'external-user', submittedAt: new Date().toISOString(), status: 'pending',
  contentHash: hashFixture({ id: 'fx-001', name: 'Test Case', description: 'A test', category: 'exactness', difficulty: 1, prompt: 'reply with exactly: HELLO', expectedOutput: 'HELLO', assertionType: 'exact', assertionValue: 'HELLO', contributor: 'external-user' }),
  ...overrides,
});

test('hashFixture: deterministic hash', () => {
  const h1 = hashFixture({ id: 'x', name: 'a', description: '', category: 'c', difficulty: 1, prompt: 'p', expectedOutput: 'e', assertionType: 'exact', assertionValue: 'v', contributor: 'u' });
  const h2 = hashFixture({ id: 'x', name: 'a', description: '', category: 'c', difficulty: 1, prompt: 'p', expectedOutput: 'e', assertionType: 'exact', assertionValue: 'v', contributor: 'u' });
  assert.equal(h1, h2);
  assert.ok(h1.startsWith('fx-'));
});

test('signFixture/verifySignature: round trip', () => {
  const f = mkFixture();
  f.signature = signFixture(f, 'secret-key');
  assert.equal(verifySignature(f, 'secret-key'), true);
  assert.equal(verifySignature(f, 'wrong-key'), false);
  assert.equal(verifySignature({ ...f, signature: undefined }, 'secret-key'), false);
});

test('validateFixture: complete fixture passes', () => {
  const r = validateFixture(mkFixture());
  assert.equal(r.valid, true);
});

test('validateFixture: missing fields fail', () => {
  const r = validateFixture({});
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 4);
});

test('FixtureRegistry: submit -> review -> approve', () => {
  const reg = new FixtureRegistry();
  const f = mkFixture();
  assert.equal(reg.submit(f).ok, true);
  assert.equal(reg.getPending().length, 1);
  reg.review(f.id, true, 'maintainer', 'LGTM');
  assert.equal(reg.getApproved().length, 1);
  assert.equal(reg.getPending().length, 0);
});

test('FixtureRegistry: reject keeps it out of approved', () => {
  const reg = new FixtureRegistry();
  const f = mkFixture();
  reg.submit(f);
  reg.review(f.id, false, 'maintainer', 'bad quality');
  assert.equal(reg.getApproved().length, 0);
});

test('FixtureRegistry: duplicate rejected', () => {
  const reg = new FixtureRegistry();
  reg.submit(mkFixture());
  assert.equal(reg.submit(mkFixture()).ok, false);
});

test('FixtureRegistry: stats computed correctly', () => {
  const reg = new FixtureRegistry();
  reg.submit(mkFixture());
  reg.submit(mkFixture({ id: 'fx-002', category: 'code' }));
  reg.review('fx-001', true, 'rev');
  const s = reg.stats();
  assert.equal(s.total, 2);
  assert.equal(s.approved, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.byCategory.exactness, 1);
  assert.equal(s.byCategory.code, 1);
});

test('FixtureRegistry: deprecate removes from approved', () => {
  const reg = new FixtureRegistry();
  reg.submit(mkFixture());
  reg.review('fx-001', true, 'rev');
  assert.equal(reg.getApproved().length, 1);
  reg.deprecate('fx-001');
  assert.equal(reg.getApproved().length, 0);
});
