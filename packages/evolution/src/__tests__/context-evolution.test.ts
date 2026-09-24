import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_WEIGHTS, validateWeights, scoreContextItem, rankItems,
  evaluateContextExperiment, ContextPolicyRegistry, type ContextPolicy, type ContextEvolutionExperiment,
} from '../context-evolution.ts';

test('default weights sum to ~1.0', () => {
  const sum = Object.values(DEFAULT_CONTEXT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.01);
});

test('validateWeights: valid weights pass', () => {
  const r = validateWeights({ relevance: 0.5, recency: 0.2, frequency: 0.1, costEfficiency: 0.1, source: 0.1 });
  assert.equal(r.valid, true);
});

test('validateWeights: negative weight fails', () => {
  const r = validateWeights({ relevance: -0.5, recency: 0.2, frequency: 0.1, costEfficiency: 0.1, source: 0.1 });
  assert.equal(r.valid, false);
});

test('validateWeights: sum != 1 warns', () => {
  const r = validateWeights({ relevance: 0.9, recency: 0.2, frequency: 0.1, costEfficiency: 0.1, source: 0.1 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('sum')));
});

test('scoreContextItem: higher relevance scores higher', () => {
  const w = DEFAULT_CONTEXT_WEIGHTS;
  const high = scoreContextItem(w, { relevance: 0.9, recency: 0.5, frequency: 0.5, tokenCost: 100, sourceTrust: 0.5 });
  const low = scoreContextItem(w, { relevance: 0.1, recency: 0.5, frequency: 0.5, tokenCost: 100, sourceTrust: 0.5 });
  assert.ok(high > low);
});

test('rankItems: sorts by score descending', () => {
  const items = [
    { id: 'a', features: { relevance: 0.9, recency: 0.5, frequency: 0.5, tokenCost: 100, sourceTrust: 0.5 } },
    { id: 'b', features: { relevance: 0.1, recency: 0.5, frequency: 0.5, tokenCost: 100, sourceTrust: 0.5 } },
    { id: 'c', features: { relevance: 0.5, recency: 0.5, frequency: 0.5, tokenCost: 100, sourceTrust: 0.5 } },
  ];
  const ranked = rankItems(DEFAULT_CONTEXT_WEIGHTS, items);
  assert.equal(ranked[0].id, 'a');
  assert.equal(ranked[1].id, 'c');
  assert.equal(ranked[2].id, 'b');
});

test('evaluateContextExperiment: promote when challenger wins', () => {
  const exp: ContextEvolutionExperiment = {
    id: 'e1', challenger: { id: 'c', name: 'c', weights: DEFAULT_CONTEXT_WEIGHTS, description: '' },
    incumbent: { id: 'i', name: 'i', weights: DEFAULT_CONTEXT_WEIGHTS, description: '' },
    controlScores: Array(15).fill(0.5),
    treatmentScores: Array(15).fill(0.6),
    status: 'running', startedAt: new Date().toISOString(),
  };
  const r = evaluateContextExperiment(exp);
  assert.equal(r.decision, 'promote');
});

test('evaluateContextExperiment: rollback when challenger loses', () => {
  const exp: ContextEvolutionExperiment = {
    id: 'e1', challenger: { id: 'c', name: 'c', weights: DEFAULT_CONTEXT_WEIGHTS, description: '' },
    incumbent: { id: 'i', name: 'i', weights: DEFAULT_CONTEXT_WEIGHTS, description: '' },
    controlScores: Array(15).fill(0.7),
    treatmentScores: Array(15).fill(0.5),
    status: 'running', startedAt: new Date().toISOString(),
  };
  const r = evaluateContextExperiment(exp);
  assert.equal(r.decision, 'rollback');
});

test('ContextPolicyRegistry: register/promote/rollback', () => {
  const reg = new ContextPolicyRegistry();
  const policy: ContextPolicy = { id: 'better', name: 'Better', weights: DEFAULT_CONTEXT_WEIGHTS, description: 'test' };
  assert.equal(reg.register(policy).ok, true);
  assert.equal(reg.activePolicyId, 'default');
  reg.promote('better');
  assert.equal(reg.activePolicyId, 'better');
  reg.rollback();
  assert.equal(reg.activePolicyId, 'default');
});

test('ContextPolicyRegistry: invalid weights rejected', () => {
  const reg = new ContextPolicyRegistry();
  const bad: ContextPolicy = { id: 'bad', name: 'Bad', weights: { relevance: -1, recency: 0, frequency: 0, costEfficiency: 0, source: 0 }, description: '' };
  assert.equal(reg.register(bad).ok, false);
});
