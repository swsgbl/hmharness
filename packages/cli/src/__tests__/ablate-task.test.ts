import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf } from '../ablate-task.ts';

const check = (s: string) => s.includes('42');

test('ablate-task: verdictOf classifies completed runs pass/wrong', () => {
  assert.equal(verdictOf({ ok: true, output: '42' }, check), 'pass');
  assert.equal(verdictOf({ ok: true, output: '41' }, check), 'wrong');
  assert.equal(verdictOf({ ok: true, output: '' }, check), 'wrong');
});

test('ablate-task: verdictOf classifies any incomplete run as crash', () => {
  // the v0.22.3 fix: a timed-out arm is a crash even when it left a partial
  // onFinal reply — infrastructure noise must not pollute the clean model
  // comparison pairs (the -8.3% artifact was exactly this channel).
  assert.equal(verdictOf({ ok: false, output: '', error: 'ablate run timeout' }, check), 'crash');
  assert.equal(verdictOf({ ok: false, output: '42', error: 'ablate run timeout' }, check), 'crash');
  assert.equal(verdictOf({ ok: false, output: '41', error: 'rate limited' }, check), 'crash');
});

test('ablate-task: verdictOf ignores error string on a completed run', () => {
  assert.equal(verdictOf({ ok: true, output: '42', error: 'ignored' }, check), 'pass');
});
