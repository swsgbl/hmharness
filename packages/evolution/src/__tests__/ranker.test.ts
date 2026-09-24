import test from 'node:test';
import assert from 'node:assert/strict';
import { rankContext, packContext, classifyMemory, RANK_WEIGHTS, type ContextCandidate } from '../ranker.ts';

const cand = (o: Partial<ContextCandidate> & { contentRef: string }): ContextCandidate => ({
  source: o.source ?? 'memory', relevance: 0, recency: 0, importance: 0,
  dependency: 0, similarity: 0, tokenCost: o.tokenCost ?? 100, ...o,
});

test('rankContext: blueprint weights order the candidates', () => {
  const ranked = rankContext([
    cand({ contentRef: 'relevant-cheap', relevance: 0.9, tokenCost: 50 }),
    cand({ contentRef: 'vague-cheap', relevance: 0.1, tokenCost: 50 }),
    cand({ contentRef: 'relevant-expensive', relevance: 0.9, tokenCost: 5000 }),
  ]);
  assert.equal(ranked[0].contentRef, 'relevant-cheap');
  // the expensive twin loses the cost term but relevance still beats vagueness
  assert.equal(ranked[1].contentRef, 'relevant-expensive');
  assert.equal(ranked[2].contentRef, 'vague-cheap');
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
  // weights are the exported constant (evolution will optimize them later)
  assert.equal(RANK_WEIGHTS.relevance, 0.30);
});

test('packContext: greedy fill respects the token budget', () => {
  const packed = packContext([
    cand({ contentRef: 'big', tokenCost: 800, relevance: 1 }),
    cand({ contentRef: 'mid', tokenCost: 150, relevance: 0.8 }),
    cand({ contentRef: 'small', tokenCost: 50, relevance: 0.6 }),
  ], 1000);
  // mid outranks big (cost-normalized: 0.221 vs 0.200) and everything fits
  assert.deepEqual(packed.map((p) => p.contentRef), ['mid', 'big', 'small']);
  // a tight budget keeps the cheap-and-relevant, drops the big block
  const tight = packContext([
    cand({ contentRef: 'big', tokenCost: 800, relevance: 1 }),
    cand({ contentRef: 'mid', tokenCost: 150, relevance: 0.8 }),
  ], 200);
  assert.deepEqual(tight.map((p) => p.contentRef), ['mid']);
});

test('classifyMemory: four memory classes by entry shape', () => {
  assert.equal(classifyMemory('(distilled) API X needs param Y'), 'semantic');
  assert.equal(classifyMemory('[self-note] tool hdc failed 3x; use -t'), 'procedural');
  assert.equal(classifyMemory('design: workspace isolation keeps memory per-project'), 'project');
  assert.equal(classifyMemory('user asked about emulator yesterday'), 'episodic');
});
