/**
 * @hmharness/observability - RunEvent schema v1 (V2 blueprint M1).
 *
 * Every agent run becomes a reproducible experiment sample: one append-only
 * trajectory.jsonl of typed events plus a summary. Schema rules:
 *   - `type` is one of RUN_EVENT_TYPES below (closed set, versioned here;
 *     unknown types must still deserialize - readers skip them, so old
 *     replays keep working when the schema grows)
 *   - payloads carry SUMMARIES, never secrets: tool name, truncated args,
 *     outcome flags, durations. No env vars, no config dumps.
 *   - append-only: no event is ever rewritten; corrections are new events.
 */

export type RunId = string;
export type EventId = string;

export type EventActor = 'user' | 'agent' | 'tool' | 'system' | 'judge';

/** Closed set for schema v1. The build/judge/repair event families are
 *  emitted once those subsystems route through the recorder (M2+); the
 *  schema ships first. */
export const RUN_EVENT_TYPES = [
  'run.created',
  'run.started',
  'context.assembled',
  'model.requested',
  'model.responded',
  'tool.requested',
  'tool.approved',
  'tool.denied',
  'tool.completed',
  'build.started',
  'build.completed',
  'test.started',
  'test.completed',
  'error.observed',
  'repair.proposed',
  'repair.applied',
  'judge.started',
  'judge.completed',
  'checkpoint.created',
  'checkpoint.restored',
  'run.completed',
  'run.failed',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent<T = unknown> {
  id: EventId;
  runId: RunId;
  /** ISO timestamp. */
  ts: string;
  type: RunEventType | string;
  actor: EventActor;
  payload: T;
  parentEventId?: EventId;
}

export interface RunMetrics {
  turns?: number;
  toolUses?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

export interface RunOutcome {
  success: boolean;
  /** loop stop reason: final | idle | turn-valve | token-valve | interrupted | error */
  reason?: string;
  error?: string;
}

export interface Trajectory {
  runId: RunId;
  task: string;
  model?: string;
  cwd?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  metrics?: RunMetrics;
  events: RunEvent[];
}

export interface RunSummary {
  runId: RunId;
  task: string;
  model?: string;
  cwd?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: RunOutcome;
  metrics?: RunMetrics;
  eventCount?: number;
}

/** Truncate a value into a trajectory-safe payload summary (no secrets, bounded). */
export function brief(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}
