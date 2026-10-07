import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkillSpecV2, type WorkflowCandidate } from '../skill-compiler.ts';

const CAND: WorkflowCandidate = {
  steps: ['write_file', 'run_command', 'harmony_build'],
  support: 5,
  trajectoryIds: ['t1', 't2', 't3', 't4', 't5'],
  environmentId: 'harmonyos',
};

test('skill v2: the honest adapter fills exactly what the data supports', () => {
  const s = toSkillSpecV2(CAND);
  assert.equal(s.version, '2.0.0');
  assert.equal(s.status, 'candidate');
  assert.deepEqual(s.trigger.actionTypes, CAND.steps);
  assert.equal(s.trigger.environmentId, 'harmonyos');
  assert.deepEqual(s.procedure.map((p) => p.ref), CAND.steps);
  assert.ok(s.procedure.every((p) => p.kind === 'act'));
  assert.equal(s.evidence.length, 5);
  assert.equal(s.confidence, 0.5, 'support 5 / 10 capped at 1');
  assert.deepEqual(s.environmentScope, ['harmonyos']);
  assert.match(s.provenance ?? '', /mineWorkflows \(support 5\)/);
  // the honest empties: n-gram mining cannot see variables or state deltas
  assert.deepEqual(s.variables, []);
  assert.deepEqual(s.expectedStateDelta, []);
  assert.deepEqual(s.counterexamples, []);
});

test('skill v2: v1 compatibility - a V2 skill IS a valid V1 skill', () => {
  const s = toSkillSpecV2(CAND);
  const v1Keys = ['id', 'name', 'trigger', 'preconditions', 'procedure', 'verification', 'evidence', 'version', 'status', 'createdAt'];
  for (const k of v1Keys) assert.ok(k in s, `v1 field '${k}' present`);
  assert.deepEqual(s.preconditions, []);
  assert.deepEqual(s.verification, []);
});

test('skill v2: confidence caps at 1 for huge support; scope override works', () => {
  const big = { ...CAND, support: 50 };
  assert.equal(toSkillSpecV2(big).confidence, 1);
  const scoped = toSkillSpecV2(CAND, { environmentScope: ['harmonyos', 'terminal'] });
  assert.deepEqual(scoped.environmentScope, ['harmonyos', 'terminal']);
  assert.equal(toSkillSpecV2(CAND, { provenance: 'lab-run-42' }).provenance, 'lab-run-42');
});
