import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoutingPolicyRegistry, evaluateExperiment, type RoutingExperiment, type RoutingPolicy } from '../router-evolution.ts';

const mkPolicy = (id: string): RoutingPolicy => ({
  id, name: id, description: 'test policy',
  decide: () => 'provider-a',
});

const mkExp = (cS: number, cT: number, tS: number, tT: number): RoutingExperiment => ({
  id: 'exp-1', challenger: mkPolicy('challenger'), incumbent: 'default',
  controlSuccesses: cS, controlTotal: cT, treatmentSuccesses: tS, treatmentTotal: tT,
  status: 'running', startedAt: new Date().toISOString(),
});

test('RoutingPolicyRegistry: register and get', () => {
  const reg = new RoutingPolicyRegistry();
  const p = mkPolicy('test');
  assert.equal(reg.register(p).ok, true);
  assert.equal(reg.get('test')?.id, 'test');
  assert.equal(reg.register(p).ok, false); // dup
});

test('RoutingPolicyRegistry: promote and rollback', () => {
  const reg = new RoutingPolicyRegistry();
  reg.register(mkPolicy('better'));
  assert.equal(reg.activeId, 'default');
  reg.promote('better');
  assert.equal(reg.activeId, 'better');
  reg.rollback();
  assert.equal(reg.activeId, 'default');
});

test('evaluateExperiment: insufficient samples continues', () => {
  const r = evaluateExperiment(mkExp(5, 10, 5, 10));
  assert.equal(r.decision, 'continue');
});

test('evaluateExperiment: treatment better promotes', () => {
  const r = evaluateExperiment(mkExp(10, 25, 18, 25)); // 40% vs 72%
  assert.equal(r.decision, 'promote');
});

test('evaluateExperiment: treatment worse rolls back', () => {
  const r = evaluateExperiment(mkExp(20, 25, 8, 25)); // 80% vs 32%
  assert.equal(r.decision, 'rollback');
});

test('evaluateExperiment: within noise band continues', () => {
  const r = evaluateExperiment(mkExp(12, 25, 13, 25)); // 48% vs 52%
  assert.equal(r.decision, 'continue');
});
