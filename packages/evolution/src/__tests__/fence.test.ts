import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fenceInner, matchCase } from '../bench.ts';

test('fenceInner: extracts fenced content, tolerates trailing fence-marker space, passthrough when unfenced', () => {
  assert.equal(fenceInner('```\n{json:"not pretty"}\n```'), '{json:"not pretty"}');
  assert.equal(fenceInner('``` \n3.14159\n```'), '3.14159');
  assert.equal(fenceInner('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(fenceInner('plain reply'), 'plain reply');
});

test('matchCase is fence-aware: a fenced exact literal passes where the prose form was prettified (day-55 lever)', () => {
  const c = { expect: [] as string[], expectExact: '{json:"not pretty"}' };
  // prose form: model normalized -> must FAIL
  assert.equal(matchCase('{json: "not pretty"}', c).pass, false);
  // fenced form: literal preserved -> must PASS
  assert.equal(matchCase('```\n{json:"not pretty"}\n```', c).pass, true);
  // regex + none also evaluate the fence inner content
  const c2 = { expect: [] as string[], expectRegex: '^[0-9a-f]{4}$' };
  assert.equal(matchCase('```\nab12\n```', c2).pass, true);
  assert.equal(matchCase('```\nab12 x\n```', c2).pass, false);
});
