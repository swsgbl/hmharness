import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, computeRoute, routeSummary, type RouteHistoryEntry } from '../adaptive-router.ts';

const hist = (p: string, tt: string, s: boolean, tok: number, ms: number): RouteHistoryEntry => ({
  provider: p, taskType: tt, success: s, tokens: tok, durationMs: ms, timestamp: new Date().toISOString(),
});

test('computeStats: basic stats', () => {
  const h = [hist('a', 'code', true, 100, 1000), hist('a', 'code', false, 120, 1100), hist('a', 'code', true, 110, 1050)];
  const s = computeStats(h, 'a', 'code');
  assert.ok(s);
  assert.equal(s.totalRequests, 3);
  assert.equal(s.successRate, 2 / 3);
  assert.equal(s.avgTokens, 110);
});

test('computeStats: no history returns undefined', () => {
  assert.equal(computeStats([], 'a', 'code'), undefined);
});

test('computeRoute: insufficient history falls back', () => {
  const r = computeRoute([], 'code', ['a', 'b']);
  assert.equal(r.provider, 'a');
  assert.ok(r.reason.includes('insufficient'));
});

test('computeRoute: picks higher success rate', () => {
  const h = [
    ...Array(10).fill(0).map(() => hist('good', 'code', true, 100, 1000)),
    ...Array(10).fill(0).map(() => hist('bad', 'code', false, 100, 1000)),
  ];
  const r = computeRoute(h, 'code', ['good', 'bad']);
  assert.equal(r.provider, 'good');
  assert.ok(r.stats && r.stats.successRate > 0.9);
});

test('computeRoute: considers cost in tie', () => {
  const h = [
    ...Array(5).fill(0).map(() => hist('cheap', 'code', true, 50, 1000)),
    ...Array(5).fill(0).map(() => hist('expensive', 'code', true, 500, 1000)),
  ];
  const r = computeRoute(h, 'code', ['cheap', 'expensive']);
  assert.equal(r.provider, 'cheap');
});

test('routeSummary formats output', () => {
  const h = [hist('a', 'code', true, 100, 1000), hist('a', 'code', false, 200, 2000)];
  const s = routeSummary(h);
  assert.ok(s.includes('2 entries'));
  assert.ok(s.includes('a:'));
});
