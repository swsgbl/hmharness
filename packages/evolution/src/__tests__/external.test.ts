import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkContamination,
  buildHoldoutReport,
  externalTaskSummary,
  type ExternalTask,
} from '../external.ts';

const mkTask = (id: string, source: string, passed?: boolean, prompt?: string): ExternalTask => ({
  id, source, prompt: prompt ?? `task ${id}`, submittedAt: new Date().toISOString(), passed,
});

test('checkContamination: no contamination when prompts differ', () => {
  const external = [mkTask('e1', 'user', true, 'read package.json')];
  const training = ['write a hello world program', 'calculate fibonacci'];
  const r = checkContamination(external, training);
  assert.equal(r.contaminated, false);
  assert.equal(r.count, 0);
});

test('checkContamination: detects exact match', () => {
  const external = [mkTask('e1', 'user', true, 'read package.json and report version')];
  const training = ['read package.json and report version'];
  const r = checkContamination(external, training);
  assert.equal(r.contaminated, true);
  assert.equal(r.count, 1);
});

test('checkContamination: detects prefix overlap (100 chars)', () => {
  const longPrompt = 'a'.repeat(150);
  const external = [mkTask('e1', 'user', true, longPrompt)];
  const training = [longPrompt.slice(0, 120)]; // overlaps first 100+ chars
  const r = checkContamination(external, training);
  assert.equal(r.contaminated, true);
});

test('buildHoldoutReport computes correctly', () => {
  const tasks = [
    mkTask('e1', 'user', true),
    mkTask('e2', 'user', false),
    mkTask('e3', 'github', true),
    mkTask('e4', 'pending'),  // not evaluated
  ];
  const r = buildHoldoutReport(tasks, { contaminated: false, count: 0 });
  assert.equal(r.totalExternal, 4);
  assert.equal(r.totalEvaluated, 3);
  assert.equal(r.passRate, 2 / 3);
  assert.equal(r.bySource.user.total, 2);
  assert.equal(r.bySource.user.passed, 1);
  assert.equal(r.bySource.github.total, 1);
  assert.equal(r.bySource.github.passed, 1);
  assert.equal(r.contaminationDetected, false);
});

test('externalTaskSummary formats correctly', () => {
  const tasks = [
    mkTask('e1', 'user', true),
    mkTask('e2', 'github'),
  ];
  const s = externalTaskSummary(tasks);
  assert.ok(s.includes('2 total'));
  assert.ok(s.includes('1 pending'));
  assert.ok(s.includes('1 evaluated'));
  assert.ok(s.includes('user'));
  assert.ok(s.includes('github'));
});
