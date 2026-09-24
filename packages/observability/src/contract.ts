/**
 * @hmharness/observability - Trajectory Contract v1 (P1-01)
 *
 * The audit called for: "稳定 schema、事件版本、migration、export/import"
 *
 * This module formalizes the trajectory data contract:
 * 1. Versioned RunEvent schema (v1, backward compatible)
 * 2. Export/import with validation
 * 3. Migration hooks for future schema versions
 * 4. Contract validation (every trajectory must conform)
 */

/** Schema version for this contract */
export const TRAJECTORY_SCHEMA_VERSION = 1;

/** All valid event types in the v1 schema */
export const EVENT_TYPES_V1 = [
  'session.start', 'session.end',
  'turn.start', 'turn.end',
  'tool.call', 'tool.result',
  'approval.request', 'approval.granted', 'approval.denied',
  'model.request', 'model.response',
  'error', 'custom',
] as const;

export type EventType = typeof EVENT_TYPES_V1[number];

/** The canonical RunEvent per the v1 contract */
export interface RunEventV1 {
  /** schema version (always 1 for this contract) */
  _v: 1;
  /** unique event id */
  id: string;
  /** run/session id this event belongs to */
  runId: string;
  /** event type from EVENT_TYPES_V1 */
  type: EventType;
  /** wall-clock timestamp (ISO 8601) */
  time: string;
  /** event sequence number within the run (monotonic) */
  seq: number;
  /** event-specific payload */
  data: Record<string, unknown>;
  /** redaction metadata (what was stripped) */
  _redacted?: string[];
}

/** A complete trajectory (all events for one run) */
export interface TrajectoryV1 {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  endedAt?: string;
  events: RunEventV1[];
  /** summary metrics extracted from events */
  metrics: {
    turns: number;
    toolCalls: number;
    toolFailures: number;
    totalTokens: number;
    durationMs: number;
  };
}

/**
 * Validate that an event conforms to the v1 contract.
 * Pure - testable.
 */
export function validateEvent(event: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const e = event as Partial<RunEventV1>;
  if (typeof e !== 'object' || e === null) { errors.push('event is not an object'); return { valid: false, errors }; }
  if (e._v !== 1) errors.push(`_v must be 1, got ${e._v}`);
  if (!e.id || typeof e.id !== 'string') errors.push('id must be a non-empty string');
  if (!e.runId || typeof e.runId !== 'string') errors.push('runId must be a non-empty string');
  if (!e.type || !EVENT_TYPES_V1.includes(e.type as EventType)) errors.push(`type must be one of ${EVENT_TYPES_V1.join('|')}, got ${e.type}`);
  if (!e.time || !/^\d{4}-\d{2}-\d{2}T/.test(String(e.time))) errors.push('time must be ISO 8601');
  if (typeof e.seq !== 'number' || e.seq < 0) errors.push('seq must be a non-negative number');
  if (typeof e.data !== 'object' || e.data === null) errors.push('data must be an object');
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a complete trajectory.
 * Pure - testable.
 */
export function validateTrajectory(traj: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const t = traj as Partial<TrajectoryV1>;
  if (typeof t !== 'object' || t === null) { errors.push('trajectory is not an object'); return { valid: false, errors }; }
  if (t.schemaVersion !== 1) errors.push(`schemaVersion must be 1, got ${t.schemaVersion}`);
  if (!t.runId || typeof t.runId !== 'string') errors.push('runId must be a string');
  if (!t.startedAt || !/^\d{4}-\d{2}-\d{2}T/.test(String(t.startedAt))) errors.push('startedAt must be ISO 8601');
  if (!Array.isArray(t.events)) { errors.push('events must be an array'); return { valid: false, errors }; }
  for (let i = 0; i < t.events.length; i++) {
    const v = validateEvent(t.events[i]);
    if (!v.valid) errors.push(`events[${i}]: ${v.errors.join('; ')}`);
  }
  // seq monotonicity check
  for (let i = 1; i < t.events.length; i++) {
    if (t.events[i].seq <= t.events[i - 1].seq) {
      errors.push(`events[${i}].seq (${t.events[i].seq}) not greater than events[${i - 1}].seq (${t.events[i - 1].seq})`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Export a trajectory as a portable JSON string.
 * Pure - testable.
 */
export function exportTrajectory(traj: TrajectoryV1): string {
  return JSON.stringify({
    ...traj,
    _exportedAt: new Date().toISOString(),
    _contractVersion: TRAJECTORY_SCHEMA_VERSION,
  }, null, 2);
}

/**
 * Import a trajectory from a JSON string, with validation.
 * Pure - testable.
 */
export function importTrajectory(json: string): { ok: boolean; trajectory?: TrajectoryV1; errors: string[] } {
  try {
    const parsed = JSON.parse(json);
    const v = validateTrajectory(parsed);
    if (!v.valid) return { ok: false, errors: v.errors };
    return { ok: true, trajectory: parsed as TrajectoryV1, errors: [] };
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${String(e).slice(0, 100)}`] };
  }
}

/**
 * Migration hook: upgrade a trajectory from an older schema version.
 * Currently only v1 exists, but this is where v1->v2 migrations will live.
 * Pure - testable.
 */
export function migrateTrajectory(traj: Record<string, unknown>): { migrated: boolean; version: number } {
  const v = Number(traj.schemaVersion ?? 0);
  if (v === 0) {
    // implicit v0 (before schemaVersion field was added) → add it
    return { migrated: true, version: 1 };
  }
  return { migrated: false, version: v };
}
