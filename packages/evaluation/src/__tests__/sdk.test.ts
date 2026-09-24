import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricRegistry, createDefaultRegistry, createPredicateEvaluator, type SdkEvaluationResult } from '../sdk.ts';

test('MetricRegistry: register and compute', () => {
  const reg = new MetricRegistry();
  reg.register({ name: 'my_metric', description: 'test', unit: 'count', higherIsBetter: true, compute: rs => rs.length });
  assert.equal(reg.get('my_metric')?.name, 'my_metric');
  const results = [{ outcome: 'pass' }, { outcome: 'fail' }] as SdkEvaluationResult[];
  assert.equal(reg.compute('my_metric', results), 2);
});

test('MetricRegistry: duplicate rejected', () => {
  const reg = new MetricRegistry();
  const r1 = reg.register({ name: 'x', description: '', unit: '', higherIsBetter: true, compute: () => 0 });
  const r2 = reg.register({ name: 'x', description: '', unit: '', higherIsBetter: true, compute: () => 0 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
});

test('default registry has common metrics', () => {
  const reg = createDefaultRegistry();
  const names = reg.list().map(m => m.name);
  assert.ok(names.includes('pass_rate'));
  assert.ok(names.includes('avg_score'));
  assert.ok(names.includes('avg_duration'));
  assert.ok(names.includes('evidence_coverage'));
});

test('pass_rate computes correctly', () => {
  const reg = createDefaultRegistry();
  const rs = [
    { outcome: 'pass', evidence: [] }, { outcome: 'pass', evidence: [] }, { outcome: 'fail', evidence: [] },
  ] as unknown as SdkEvaluationResult[];
  assert.equal(reg.compute('pass_rate', rs), 2 / 3);
});

test('evidence_coverage computes correctly', () => {
  const reg = createDefaultRegistry();
  const rs = [
    { outcome: 'pass', evidence: [{ kind: 'build-log', source: 'x', tier: 1 }] },
    { outcome: 'pass', evidence: [] },
  ] as SdkEvaluationResult[];
  assert.equal(reg.compute('evidence_coverage', rs), 0.5);
});

test('createPredicateEvaluator: pass case', async () => {
  const ev = createPredicateEvaluator('test', 'always true', 1, () => true);
  const r = await ev.evaluate('input');
  assert.equal(r.outcome, 'pass');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evaluatorId, 'test');
});

test('createPredicateEvaluator: fail case', async () => {
  const ev = createPredicateEvaluator('test', 'always false', 1, () => false);
  const r = await ev.evaluate('input');
  assert.equal(r.outcome, 'fail');
});
