/**
 * gate tests (2026-10-15, v0.24 P2A production opt-in): the conditioned
 * policy is the SINGLE implementation shared by the lab script and the
 * runner — pin its three-tier honesty here:
 *   pair with support >= MIN decides (both directions),
 *   else type with support >= MIN decides,
 *   else no evidence = allow (knownUnknown is an explore signal).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionedPolicy, buildConditionedGate, GATE_MIN_SUPPORT } from '../gate.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const c = (s: number, f: number) => ({ s, f });

test('policy: risky pair blocks where the type baseline would pass (the corpus read->edit shape)', () => {
  const typeStat = new Map([['edit_file', c(83, 17)]]); // type rate 0.83
  const pairStat = new Map([['read_file->edit_file', c(9, 7)]]); // pair rate 0.56, n=16
  const p = conditionedPolicy(typeStat, pairStat, 0.7);
  assert.equal(p.check('read_file').allowed, true, 'read_file type baseline passes');
  const v = p.check('edit_file');
  assert.equal(v.allowed, false, 'the pair verdict blocks despite the benign type rate');
  if (!v.allowed) assert.match(v.reason, /read_file->edit_file/);
});

test('policy: benign pair passes where the type baseline would block (both directions)', () => {
  const typeStat = new Map([['run_command', c(60, 40)]]); // 0.6 < 0.7 would block
  const pairStat = new Map([['harmony_devices->run_command', c(12, 0)]]); // 1.00 passes
  const p = conditionedPolicy(typeStat, pairStat, 0.7);
  assert.equal(p.check('harmony_devices').allowed, true);
  assert.equal(p.check('run_command').allowed, true, 'the benign pair rescues the risky type');
  // but run_command AFTER something else still falls back to the type verdict
  const p2 = conditionedPolicy(typeStat, pairStat, 0.7);
  p2.check('read_file'); // unknown type = allow, becomes lastType
  const v2 = p2.check('run_command');
  assert.equal(v2.allowed, false, 'unsupported pair falls back to the type verdict');
});

test('policy: below MIN_SUPPORT never decides (a rate built on 2 observations is not a rate)', () => {
  const typeStat = new Map([['write_file', c(90, 10)]]);
  const pairStat = new Map([['write_file->edit_file', c(0, GATE_MIN_SUPPORT - 1)]]); // support 9: refuse-shaped but too thin
  const p = conditionedPolicy(typeStat, pairStat, 0.7);
  assert.equal(p.check('write_file').allowed, true);
  assert.equal(p.check('edit_file').allowed, true, 'thin pair does not block; edit_file has no type evidence either');
});

test('policy: refusals do not advance the sequence (executions change the world, not attempts)', () => {
  const typeStat = new Map([['write_file', c(90, 10)]]);
  const pairStat = new Map([['write_file->edit_file', c(1, 11)]]); // 0.08, n=12 -> block
  const p = conditionedPolicy(typeStat, pairStat, 0.7);
  assert.equal(p.check('write_file').allowed, true); // lastType = write_file
  assert.equal(p.check('edit_file').allowed, false); // pair blocks; lastType STAYS write_file
  const v = p.check('edit_file');
  assert.equal(v.allowed, false, 'the refusal did not advance lastType to edit_file (same context, same verdict)');
  assert.equal(p.stats().refusals, 2);
  assert.equal(p.stats().consults, 3);
});

test('builder: empty/unreadable corpus yields an all-allow gate (no evidence never blocks, never crashes)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-'));
  try {
    const gate = await buildConditionedGate(home, 0.7);
    assert.equal((await gate.check('write_file', {})).allowed, true);
    assert.equal((await gate.check('run_command', {})).allowed, true);
    const s = gate.stats();
    assert.equal(s.types, 0);
    assert.equal(s.refusals, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
