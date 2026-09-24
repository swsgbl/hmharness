import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, generateAdversarialCases, buildReport } from '../self-benchmark.ts';

test('findGaps: detects high-failure categories', () => {
  const outcomes = [
    ...Array(5).fill(0).map((_, i) => ({ sessionId: `ok${i}`, category: 'exactness', passed: true })),
    ...Array(5).fill(0).map((_, i) => ({ sessionId: `fail${i}`, category: 'exactness', passed: false })),
    ...Array(8).fill(0).map((_, i) => ({ sessionId: `ok2${i}`, category: 'reasoning', passed: true })),
  ];
  const gaps = findGaps(outcomes);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].category, 'exactness');
  assert.equal(gaps[0].failureCount, 5);
});

test('findGaps: low-failure categories not flagged', () => {
  const outcomes = [
    ...Array(9).fill(0).map((_, i) => ({ sessionId: `ok${i}`, category: 'exactness', passed: true })),
    { sessionId: 'fail1', category: 'exactness', passed: false },
  ];
  const gaps = findGaps(outcomes);
  assert.equal(gaps.length, 0);
});

test('generateAdversarialCases: creates cases for gaps', () => {
  const gaps = [{ id: 'g1', category: 'exactness' as const, description: 'gap', failedSessionIds: [], failureCount: 5, confidence: 0.8 }];
  const cases = generateAdversarialCases(gaps);
  assert.ok(cases.length >= 2);
  assert.ok(cases.every(c => c.target === 'external-holdout'));
  assert.ok(cases.every(c => c.gapId === 'g1'));
});

test('buildReport: all cases external', () => {
  const gaps = [{ id: 'g1', category: 'exactness' as const, description: '', failedSessionIds: [], failureCount: 5, confidence: 0.8 }];
  const cases = generateAdversarialCases(gaps);
  const report = buildReport(gaps, cases);
  assert.equal(report.gapsFound, 1);
  assert.ok(report.casesGenerated >= 2);
  assert.equal(report.allCasesExternal, true);
});
