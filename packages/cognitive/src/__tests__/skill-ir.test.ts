import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkillSpecV2, deriveCounterexamples, toSkillIR, type WorkflowCandidate } from '../skill-compiler.ts';
import type { CognitiveTrajectory } from '../protocol.ts';

const CAND: WorkflowCandidate = {
  steps: ['write_file', 'run_command', 'harmony_build'],
  support: 5,
  trajectoryIds: ['t1', 't2', 't3', 't4', 't5'],
  environmentId: 'harmonyos',
};

function traj(id: string, types: string[], success = true): CognitiveTrajectory {
  return {
    id,
    sessionId: 's-' + id,
    environment: { id: 'harmonyos', version: '1' },
    steps: types.map((type, i) => ({ step: i + 1, action: { id: `a${i}`, type, args: {} }, outcome: 'success' as const, evidence: [] })),
    metrics: { success, actions: types.length, elapsedMs: 1000, recoveryCount: 0 },
    startedAt: new Date().toISOString(),
  };
}

test('counterexamples: reordered-but-complete holdout shapes become counterexamples', () => {
  const holdout = [
    traj('h1', ['run_command', 'write_file', 'harmony_build']), // reordered: counterexample
    traj('h2', ['write_file', 'run_command', 'harmony_build']), // contiguous: NOT a counterexample
    traj('h3', ['unrelated']), // steps absent: coverage miss, no signal
    traj('h4', ['harmony_build', 'write_file', 'run_command']), // another reorder shape
    traj('h5', ['run_command', 'write_file', 'harmony_build']), // same shape as h1: deduped
  ];
  const cx = deriveCounterexamples(CAND, holdout);
  assert.equal(cx.length, 2, 'two distinct divergent shapes');
  assert.match(cx[0].description, /sequence diverges/);
  assert.match(cx[0].description, /run_command → write_file/);
  assert.equal(cx[0].source, 'holdout h1');
  assert.equal(cx[1].source, 'holdout h4');
  // cap works
  const many = Array.from({ length: 12 }, (_, i) => traj('m' + i, ['harmony_build', 'x' + i, 'write_file', 'run_command']));
  assert.equal(deriveCounterexamples(CAND, many, { cap: 5 }).length, 5);
});

test('skill IR: procedure maps to abstract verbs, unmapped positions stated', () => {
  const skill = toSkillSpecV2(CAND);
  const map: Record<string, string> = { write_file: 'write', run_command: 'run', harmony_build: 'verify' };
  const ir = toSkillIR(skill, map);
  assert.deepEqual(ir.abstractProcedure, ['write', 'run', 'verify']);
  assert.deepEqual(ir.unmapped, []);
  const partial: Record<string, string> = { write_file: 'write' };
  const ir2 = toSkillIR(skill, partial);
  assert.deepEqual(ir2.abstractProcedure, ['write', 'run_command', 'harmony_build']);
  assert.deepEqual(ir2.unmapped, [1, 2], 'the literal tokens stay, their positions listed');
  assert.deepEqual(ir2.environmentScope, ['harmonyos']);
});
