import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidate, evaluateCandidate, selectBest, runIteration, type HarnessCandidate } from '../meta-harness.ts';

const mkCandidate = (id: string, score?: number): HarnessCandidate => ({
  id, name: id, description: 'test',
  tools: ['read', 'write'], systemPrompt: 'You are a test agent.',
  topology: 'single', maxTurns: 10, approvalPolicy: 'auto',
  generatedBy: 'test', generation: 1,
});

test('generateCandidate: creates mutation with generation', () => {
  const base = mkCandidate('base');
  const mut = generateCandidate(base, { topology: 'team', maxTurns: 20 }, 2);
  assert.notEqual(mut.id, base.id);
  assert.equal(mut.generation, 2);
  assert.equal(mut.topology, 'team');
  assert.equal(mut.maxTurns, 20);
});

test('evaluateCandidate: strong metrics adopt', () => {
  const c = mkCandidate('good');
  const e = evaluateCandidate(c, { passRate: 0.9, avgTurns: 5, avgTokens: 500, safetyScore: 0.95 });
  assert.equal(e.recommendation, 'adopt');
  assert.ok(e.score > 0.7);
  assert.ok(e.strengths.length >= 2);
});

test('evaluateCandidate: weak metrics reject or iterate', () => {
  const c = mkCandidate('bad');
  const e = evaluateCandidate(c, { passRate: 0.2, avgTurns: 25, avgTokens: 5000, safetyScore: 0.6 });
  assert.ok(e.score < 0.5);
  assert.ok(['reject', 'iterate'].includes(e.recommendation));
  assert.ok(e.weaknesses.length >= 2);
});

test('selectBest: picks highest score', () => {
  const c1 = mkCandidate('low');
  const c2 = mkCandidate('high');
  const evals = [
    evaluateCandidate(c1, { passRate: 0.3, avgTurns: 20, avgTokens: 500, safetyScore: 0.8 }),
    evaluateCandidate(c2, { passRate: 0.9, avgTurns: 3, avgTokens: 200, safetyScore: 0.95 }),
  ];
  const best = selectBest([c1, c2], evals);
  assert.equal(best?.id, 'high');
});

test('runIteration: produces report with improvement', () => {
  const c1 = mkCandidate('a');
  const evals = [evaluateCandidate(c1, { passRate: 0.9, avgTurns: 3, avgTokens: 200, safetyScore: 0.95 })];
  const iter = runIteration(1, [c1], evals, 0.5);
  assert.equal(iter.iteration, 1);
  assert.ok(iter.bestCandidate);
  assert.ok(iter.improvement > 0);
});
