import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../metrics.ts';

test('metrics: full input computes all twelve with hand-checked values', () => {
  const r = computeMetrics({
    tasks: 10, successes: 7,
    completionsMs: [1000, 2000, 3000],
    actions: 40, effectiveActions: 30,
    failures: 4, recoveredFailures: 3,
    brier: 0.12, ece: 0.05,
    deltaAccuracy: 0.71,
    costUsd: 1.2345,
    actionLatenciesMs: [100, 200, 300, 400, 500],
    humanInterventions: 2,
    regressionBaselineSuccesses: 8, currentSuccesses: 7,
    transferWithKnowledge: 0.9, transferBaseline: 0.6,
    safetyViolations: 1,
  });
  assert.equal(r.successRate, 0.7);
  assert.equal(r.taskCompletionTimeMs, 2000);
  assert.equal(r.actionEfficiency, 0.75);
  assert.equal(r.recoveryRate, 0.75);
  assert.deepEqual(r.predictionCalibration, { brier: 0.12, ece: 0.05 });
  assert.equal(r.worldModelDeltaAccuracy, 0.71);
  assert.equal(r.costUsd, 1.2345);
  assert.deepEqual(r.latency, { p50Ms: 300, p95Ms: 500, maxMs: 500 });
  assert.equal(r.humanInterventionRate, 0.2);
  assert.equal(r.regressionRate, 0.125);
  assert.equal(r.transferGain, 0.3);
  assert.equal(r.safetyViolationRate, 0.1);
  assert.equal(r.unmeasured.length, 0);
});

test('metrics: absent input = undefined + named in unmeasured, NEVER zero', () => {
  const r = computeMetrics({ tasks: 4, successes: 4 });
  assert.equal(r.successRate, 1);
  assert.equal(r.safetyViolationRate, undefined, 'unmeasured violations must not fabricate a clean 0');
  assert.equal(r.recoveryRate, undefined);
  assert.ok(r.unmeasured.includes('safetyViolationRate'));
  assert.ok(r.unmeasured.includes('recoveryRate'));
  assert.ok(r.unmeasured.includes('transferGain'));
});

test('metrics: degenerate denominators stay honest', () => {
  const r = computeMetrics({ tasks: 0, successes: 0, failures: 0, recoveredFailures: 0, regressionBaselineSuccesses: 0, currentSuccesses: 0 });
  assert.equal(r.successRate, undefined, 'zero tasks = no rate');
  assert.equal(r.recoveryRate, undefined);
  assert.equal(r.regressionRate, undefined, 'zero baseline = division would fabricate infinity');
});

test('metrics: regression is signed - improvement reports negative', () => {
  const worse = computeMetrics({ regressionBaselineSuccesses: 6, currentSuccesses: 8 });
  assert.equal(worse.regressionRate, -0.333, 'gains report as negative regression');
  const lost = computeMetrics({ regressionBaselineSuccesses: 6, currentSuccesses: 3 });
  assert.equal(lost.regressionRate, 0.5);
});
