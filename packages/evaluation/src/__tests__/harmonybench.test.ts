import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARMONYBENCH_CASES,
  HARMONYBENCH_VERSION,
  checkAssertion,
  summarizeByCategory,
  detectRegressions,
  validateBenchSuite,
} from '../harmonybench.ts';

test('HarmonyBench v1 has >=50 cases', () => {
  assert.ok(HARMONYBENCH_CASES.length >= 50, `only ${HARMONYBENCH_CASES.length} cases`);
  console.log(`  total: ${HARMONYBENCH_CASES.length} cases, version ${HARMONYBENCH_VERSION}`);
});

test('all cases have unique ids', () => {
  const ids = HARMONYBENCH_CASES.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('fixture validation passes', () => {
  const v = validateBenchSuite(HARMONYBENCH_CASES);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test('all 6 categories represented', () => {
  const cats = new Set(HARMONYBENCH_CASES.map(c => c.category));
  assert.equal(cats.size, 6);
  for (const c of ['exactness', 'cjk', 'code', 'reasoning', 'tools', 'harmony']) {
    assert.ok(cats.has(c as never), `missing category: ${c}`);
  }
});

test('checkAssertion: exact match', () => {
  assert.equal(checkAssertion('HELLO', { type: 'exact', value: 'HELLO' }), true);
  assert.equal(checkAssertion('hello', { type: 'exact', value: 'HELLO' }), false);
  assert.equal(checkAssertion(' HELLO ', { type: 'exact', value: 'HELLO' }), true, 'trims');
});

test('checkAssertion: contains', () => {
  assert.equal(checkAssertion('the answer is 42 here', { type: 'contains', value: '42' }), true);
  assert.equal(checkAssertion('no match', { type: 'contains', value: '42' }), false);
});

test('checkAssertion: not_contains', () => {
  assert.equal(checkAssertion('clean output', { type: 'not_contains', value: 'error' }), true);
  assert.equal(checkAssertion('has error inside', { type: 'not_contains', value: 'error' }), false);
});

test('checkAssertion: regex', () => {
  assert.equal(checkAssertion('result: 5050', { type: 'regex', value: '\\d{4}' }), true);
  assert.equal(checkAssertion('no digits here', { type: 'regex', value: '\\d{4}' }), false);
});

test('summarizeByCategory computes rates correctly', () => {
  const results = [
    { caseId: 'a', category: 'exactness' as const, pass: true },
    { caseId: 'b', category: 'exactness' as const, pass: false },
    { caseId: 'c', category: 'cjk' as const, pass: true },
  ];
  const s = summarizeByCategory(results);
  assert.equal(s.exactness.total, 2);
  assert.equal(s.exactness.passed, 1);
  assert.equal(s.exactness.rate, 0.5);
  assert.equal(s.cjk.rate, 1.0);
  assert.equal(s.code.total, 0);
  assert.equal(s.code.rate, 0);
});

test('detectRegressions finds pass→fail transitions', () => {
  const baseline = [
    { caseId: 'x', pass: true },
    { caseId: 'y', pass: true },
    { caseId: 'z', pass: false },
  ];
  const current = [
    { caseId: 'x', pass: false },
    { caseId: 'y', pass: true },
    { caseId: 'z', pass: false },
  ];
  const regs = detectRegressions(current, baseline);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].caseId, 'x');
  assert.equal(regs[0].was, 'pass');
  assert.equal(regs[0].now, 'fail');
});

test('no false positive regressions (fail→fail is not a regression)', () => {
  const baseline = [{ caseId: 'z', pass: false }];
  const current = [{ caseId: 'z', pass: false }];
  assert.equal(detectRegressions(current, baseline).length, 0);
});

test('case difficulty distribution is reasonable', () => {
  const d1 = HARMONYBENCH_CASES.filter(c => c.difficulty === 1).length;
  const d2 = HARMONYBENCH_CASES.filter(c => c.difficulty === 2).length;
  const d3 = HARMONYBENCH_CASES.filter(c => c.difficulty === 3).length;
  assert.ok(d1 >= 10, `need >=10 easy, got ${d1}`);
  assert.ok(d2 >= 10, `need >=10 medium, got ${d2}`);
  assert.ok(d1 + d2 + d3 === HARMONYBENCH_CASES.length);
});
