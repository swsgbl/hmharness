import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyOptimizer, type OptimizablePolicy } from '../policy-optimizer.ts';

const mkPolicy = (id: string, kind: OptimizablePolicy['kind'] = 'prompt'): OptimizablePolicy => ({
  id, kind, name: id, value: 'original', description: 'test policy', evaluationMethod: 'bench',
});

test('PolicyOptimizer: register and list', () => {
  const opt = new PolicyOptimizer();
  opt.registerPolicy(mkPolicy('p1'));
  opt.registerPolicy(mkPolicy('p2', 'routing'));
  assert.equal(opt.listPolicies().length, 2);
  assert.equal(opt.listPolicies('routing').length, 1);
  assert.equal(opt.registerPolicy(mkPolicy('p1')).ok, false);
});

test('PolicyOptimizer: propose experiment', () => {
  const opt = new PolicyOptimizer();
  opt.registerPolicy(mkPolicy('p1'));
  const r = opt.proposeExperiment('p1', 'new-value');
  assert.equal(r.ok, true);
  assert.ok(r.experimentId);
});

test('PolicyOptimizer: record and evaluate', () => {
  const opt = new PolicyOptimizer();
  opt.registerPolicy(mkPolicy('p1'));
  const { experimentId } = opt.proposeExperiment('p1', 'better-value')!;
  for (let i = 0; i < 12; i++) {
    opt.recordResult(experimentId!, 'control', 0.5);
    opt.recordResult(experimentId!, 'treatment', 0.7);
  }
  const r = opt.evaluateExperiment(experimentId!);
  assert.equal(r?.decision, 'promote');
  assert.equal(opt.getPolicy('p1')?.value, 'better-value');
});

test('PolicyOptimizer: rollback when treatment worse', () => {
  const opt = new PolicyOptimizer();
  opt.registerPolicy(mkPolicy('p1'));
  const { experimentId } = opt.proposeExperiment('p1', 'worse-value')!;
  for (let i = 0; i < 12; i++) {
    opt.recordResult(experimentId!, 'control', 0.8);
    opt.recordResult(experimentId!, 'treatment', 0.5);
  }
  const r = opt.evaluateExperiment(experimentId!);
  assert.equal(r?.decision, 'rollback');
  assert.equal(opt.getPolicy('p1')?.value, 'original');
});

test('PolicyOptimizer: report summarizes', () => {
  const opt = new PolicyOptimizer();
  opt.registerPolicy(mkPolicy('p1', 'prompt'));
  opt.registerPolicy(mkPolicy('p2', 'routing'));
  const report = opt.report();
  assert.equal(report.totalPolicies, 2);
  assert.equal(report.byKind.prompt, 1);
  assert.equal(report.byKind.routing, 1);
});
