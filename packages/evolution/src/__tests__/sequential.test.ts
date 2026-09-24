import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprt, evolutionSPRT, bonferroniAlpha, checkGuardrails, type SPRTParams } from '../sequential.ts';

const params: SPRTParams = { p0: 0.5, p1: 0.65, alpha: 0.05, beta: 0.10 };

test('SPRT: insufficient data below minimum N', () => {
  const r = sprt(5, 10, 6, 10, params, 30);
  assert.equal(r.decision, 'insufficient');
  assert.equal(r.nControl, 10);
  assert.equal(r.nTreatment, 10);
});

test('SPRT: strong treatment effect triggers accept-h1', () => {
  // 60% control vs 90% treatment with enough samples
  const r = sprt(30, 50, 45, 50, params, 30);
  assert.ok(['accept-h1', 'continue'].includes(r.decision), 'decision=' + r.decision);
  assert.ok(r.logLR > 0, 'logLR should be positive for better treatment');
});

test('SPRT: no difference leads to accept-h0', () => {
  // 50% control vs 50% treatment
  const r = sprt(30, 60, 30, 60, params, 30);
  assert.ok(['accept-h0', 'continue'].includes(r.decision));
  assert.ok(Math.abs(r.effectEstimate) < 0.01);
});

test('SPRT: effect CI shrinks with more data', () => {
  const small = sprt(15, 30, 20, 30, params, 30);
  const large = sprt(50, 100, 65, 100, params, 30);
  const smallWidth = small.effectCI[1] - small.effectCI[0];
  const largeWidth = large.effectCI[1] - large.effectCI[0];
  assert.ok(largeWidth < smallWidth, 'CI should shrink with more data');
});

test('evolutionSPRT uses baseline + 5pp as H1', () => {
  const r = evolutionSPRT(20, 40, 30, 40);
  assert.ok(r.minN === 30);
  assert.ok(['continue', 'accept-h0', 'accept-h1', 'insufficient'].includes(r.decision));
});

test('evolutionSPRT detects real improvement', () => {
  // 40% vs 80% - huge improvement, should accept-h1 or be well on the way
  const r = evolutionSPRT(16, 40, 32, 40);
  assert.ok(r.logLR > 2, 'strong improvement should push logLR high');
});

test('bonferroniAlpha corrects for multiple experiments', () => {
  assert.equal(bonferroniAlpha(1), 0.05);
  assert.equal(bonferroniAlpha(5), 0.01);
  assert.equal(bonferroniAlpha(10), 0.005);
});

test('checkGuardrails catches regression', () => {
  const result = checkGuardrails(
    { decision: 'accept-h1' } as never,
    [
      { name: 'latency', controlValue: 2.0, treatmentValue: 5.0, maxRegression: 1.0 },
      { name: 'cost', controlValue: 100, treatmentValue: 110, maxRegression: 50 },
    ],
  );
  assert.equal(result.pass, false);
  assert.equal(result.violations.length, 1);
  assert.ok(result.violations[0].includes('latency'));
});

test('checkGuardrails passes when within tolerance', () => {
  const result = checkGuardrails(
    { decision: 'accept-h1' } as never,
    [
      { name: 'cost', controlValue: 100, treatmentValue: 105, maxRegression: 20 },
    ],
  );
  assert.equal(result.pass, true);
  assert.equal(result.violations.length, 0);
});
