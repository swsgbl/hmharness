import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HMH_SCORE_VERSION, ALL_DIMENSIONS, DEFAULT_WEIGHTS,
  computeHMHScore, correctnessFromPassRate, testFromCoverage,
  reliabilityFromSuccessRate, securityFromRedTeam, costFromTokensPerTask,
  latencyFromDuration, humanFromJudgeScores, formatHMHScore,
} from '../score.ts';

test('score version is 1.0.0', () => { assert.equal(HMH_SCORE_VERSION, '1.0.0'); });

test('all dimensions present and weights sum to ~1.0', () => {
  assert.equal(ALL_DIMENSIONS.length, 9);
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.01, `weights sum to ${sum}`);
});

test('computeHMHScore with all dimensions', () => {
  const dims = ALL_DIMENSIONS.map(d => ({ dimension: d, score: 80, method: 'test', sampleSize: 10 }));
  const s = computeHMHScore(dims);
  assert.equal(s.composite, 80);
  assert.equal(s.dimensions.length, 9);
  assert.equal(s.warnings.length, 0);
});

test('computeHMHScore with missing dimensions warns', () => {
  const dims = [correctnessFromPassRate(0.9, 50)];
  const s = computeHMHScore(dims);
  assert.ok(s.warnings.some(w => w.includes('missing')));
  // composite is based on available dims only
  assert.ok(s.composite > 0);
});

test('computeHMHScore clamps to [0,100]', () => {
  const dims = [{ dimension: 'correctness' as const, score: 150, method: 'overflow', sampleSize: 1 }];
  const s = computeHMHScore(dims);
  assert.ok(s.composite <= 100);
});

test('correctnessFromPassRate converts correctly', () => {
  const d = correctnessFromPassRate(0.85, 100);
  assert.equal(d.score, 85);
  assert.equal(d.dimension, 'correctness');
});

test('securityFromRedTeam computes block rate', () => {
  const d = securityFromRedTeam(34, 34);
  assert.equal(d.score, 100);
  const d2 = securityFromRedTeam(30, 34);
  assert.equal(d2.score, 88);
});

test('costFromTokensPerTask: under budget = high score', () => {
  const d = costFromTokensPerTask(5000, 20000);
  assert.equal(d.score, 75); // (1 - 0.25) * 100
});

test('costFromTokensPerTask: over budget = 0', () => {
  const d = costFromTokensPerTask(30000, 20000);
  assert.equal(d.score, 0);
});

test('latencyFromDuration', () => {
  const d = latencyFromDuration(5000, 10000);
  assert.equal(d.score, 50);
});

test('humanFromJudgeScores: 5-point to 100-point', () => {
  const d = humanFromJudgeScores([5, 4, 5, 5]);
  assert.equal(d.score, 95); // avg 4.75/5 * 100
});

test('humanFromJudgeScores: empty list', () => {
  const d = humanFromJudgeScores([]);
  assert.equal(d.score, 0);
  assert.equal(d.sampleSize, 0);
});

test('formatHMHScore produces readable output', () => {
  const dims = [correctnessFromPassRate(0.9, 50), securityFromRedTeam(34, 34)];
  const s = computeHMHScore(dims);
  const text = formatHMHScore(s);
  assert.ok(text.includes('HMH Score'));
  assert.ok(text.includes('correctness'));
  assert.ok(text.includes('security'));
});
