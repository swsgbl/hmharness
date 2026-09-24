import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAJECTORY_SCHEMA_VERSION, EVENT_TYPES_V1,
  validateEvent, validateTrajectory, exportTrajectory, importTrajectory, migrateTrajectory,
  type RunEventV1, type TrajectoryV1,
} from '../contract.ts';

const mkEvent = (seq: number, type: string = 'turn.start'): RunEventV1 => ({
  _v: 1, id: `evt-${seq}`, runId: 'run-1', type: type as never, time: new Date().toISOString(), seq, data: {},
});

const mkTraj = (): TrajectoryV1 => ({
  schemaVersion: 1, runId: 'run-1', startedAt: new Date().toISOString(),
  events: [mkEvent(0), mkEvent(1, 'tool.call'), mkEvent(2, 'tool.result')],
  metrics: { turns: 1, toolCalls: 1, toolFailures: 0, totalTokens: 100, durationMs: 5000 },
});

test('schema version is 1', () => { assert.equal(TRAJECTORY_SCHEMA_VERSION, 1); });

test('event types are non-empty and include core types', () => {
  assert.ok(EVENT_TYPES_V1.length >= 10);
  assert.ok(EVENT_TYPES_V1.includes('session.start'));
  assert.ok(EVENT_TYPES_V1.includes('tool.call'));
  assert.ok(EVENT_TYPES_V1.includes('model.response'));
});

test('validateEvent: valid event passes', () => {
  const r = validateEvent(mkEvent(0));
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test('validateEvent: missing required fields fails', () => {
  const r = validateEvent({ _v: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('id')));
  assert.ok(r.errors.some(e => e.includes('type')));
});

test('validateEvent: wrong schema version fails', () => {
  const r = validateEvent({ ...mkEvent(0), _v: 2 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('_v')));
});

test('validateEvent: invalid event type fails', () => {
  const r = validateEvent({ ...mkEvent(0), type: 'bogus.type' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('type')));
});

test('validateTrajectory: valid trajectory passes', () => {
  const r = validateTrajectory(mkTraj());
  assert.equal(r.valid, true);
});

test('validateTrajectory: non-monotonic seq fails', () => {
  const t = mkTraj();
  t.events[2].seq = 0; // goes backwards
  const r = validateTrajectory(t);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('seq')));
});

test('export/import round-trip preserves data', () => {
  const t = mkTraj();
  const json = exportTrajectory(t);
  const r = importTrajectory(json);
  assert.equal(r.ok, true);
  assert.equal(r.trajectory?.runId, 'run-1');
  assert.equal(r.trajectory?.events.length, 3);
});

test('importTrajectory: invalid JSON rejected', () => {
  const r = importTrajectory('not json {');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('invalid JSON')));
});

test('importTrajectory: wrong schema version rejected', () => {
  const r = importTrajectory(JSON.stringify({ schemaVersion: 99 }));
  assert.equal(r.ok, false);
});

test('migrateTrajectory: v0 (no version field) migrates to v1', () => {
  const r = migrateTrajectory({ runId: 'x' });
  assert.equal(r.migrated, true);
  assert.equal(r.version, 1);
});

test('migrateTrajectory: already v1 does not migrate', () => {
  const r = migrateTrajectory({ schemaVersion: 1 });
  assert.equal(r.migrated, false);
  assert.equal(r.version, 1);
});
