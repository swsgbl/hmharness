import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterForTraining, detectLeakage, decontaminate, rlReadinessReport,
  type TrajectoryRecord,
} from '../rl-governance.ts';

const mk = (id: string, over: Partial<TrajectoryRecord> = {}): TrajectoryRecord => ({
  id, taskId: `t-${id}`, prompt: `prompt ${id}`, output: `output ${id}`,
  outcome: 'ok', tokens: 100, turns: 2, isExternal: false, isHoldout: false, ...over,
});

test('filterForTraining: holdout and external rejected', () => {
  const records = [mk('1'), mk('2', { isHoldout: true }), mk('3', { isExternal: true }), mk('4')];
  const r = filterForTraining(records);
  assert.equal(r.eligible.length, 2);
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.some(x => x.reason.includes('holdout')));
  assert.ok(r.rejected.some(x => x.reason.includes('external')));
});

test('filterForTraining: empty and error rejected', () => {
  const records = [mk('1'), mk('2', { prompt: '' }), mk('3', { output: '' }), mk('4', { outcome: 'error' })];
  const r = filterForTraining(records);
  assert.equal(r.eligible.length, 1);
  assert.equal(r.rejected.length, 3);
});

test('detectLeakage: holdout-in-train detected', () => {
  const holdout = [mk('h1', { prompt: 'shared prompt', isHoldout: true })];
  const training = [mk('t1', { prompt: 'shared prompt' })];
  const checks = detectLeakage(training, holdout);
  const hit = checks.find(c => c.type === 'holdout-in-train');
  assert.ok(hit?.detected);
  assert.equal(hit?.details.length, 1);
});

test('detectLeakage: no false positive when different prompts', () => {
  const holdout = [mk('h1', { prompt: 'holdout prompt' })];
  const training = [mk('t1', { prompt: 'training prompt' })];
  const checks = detectLeakage(training, holdout);
  assert.ok(!checks.find(c => c.type === 'holdout-in-train')?.detected);
});

test('decontaminate: clean record passes', () => {
  const r = decontaminate(mk('1'), []);
  assert.equal(r.action, 'pass');
  assert.equal(r.reasons.length, 0);
});

test('decontaminate: holdout prompt rejected', () => {
  const r = decontaminate(mk('1', { prompt: 'holdout prompt' }), ['holdout prompt']);
  assert.equal(r.action, 'reject');
  assert.ok(r.reasons.some(x => x.includes('holdout')));
});

test('rlReadinessReport: ready when sufficient', () => {
  const r = rlReadinessReport({ totalTrajectories: 200, eligibleForTraining: 150, holdoutSize: 20, leakageChecks: [] });
  assert.equal(r.ready, true);
  assert.ok(r.score > 80);
});

test('rlReadinessReport: blocked when insufficient', () => {
  const r = rlReadinessReport({ totalTrajectories: 50, eligibleForTraining: 30, holdoutSize: 5, leakageChecks: [{ type: 'holdout-in-train', detected: true, details: ['leak'] }] });
  assert.equal(r.ready, false);
  assert.ok(r.blockers.length >= 3);
});
