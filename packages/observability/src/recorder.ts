/**
 * @hmharness/observability - TrajectoryRecorder.
 *
 * The runner-side convenience wrapper: creates a run id, stamps events with
 * ids/timestamps, and swallows every storage error - observability must never
 * fail a run (ADR-0001 rule 2). One recorder per agent task; finish() writes
 * summary.json.
 */
import { randomBytes } from 'node:crypto';
import { jsonlTrajectoryStore, type TrajectoryStore } from './store.ts';
import { brief, type EventActor, type RunEvent, type RunEventType, type RunMetrics, type RunOutcome } from './events.ts';

export interface TrajectoryRecorder {
  readonly runId: string;
  emit(type: RunEventType | string, actor: EventActor, payload: unknown, parentEventId?: string): void;
  finish(outcome: RunOutcome, metrics?: RunMetrics): void;
}

export function newRunId(now = new Date()): string {
  const t = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `run_${t}_${randomBytes(3).toString('hex')}`;
}

/** Fire-and-forget queue: appends happen serially so JSONL lines never interleave. */
export function createTrajectoryRecorder(home: string, meta: { task: string; model?: string; cwd?: string }, store: TrajectoryStore = jsonlTrajectoryStore(home)): TrajectoryRecorder {
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  let finished = false;
  const push = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(() => undefined); // best-effort, ordered
  };
  const emit: TrajectoryRecorder['emit'] = (type, actor, payload, parentEventId) => {
    const ev: RunEvent = { id: `${runId}-${++seq}`, runId, ts: new Date().toISOString(), type, actor, payload };
    if (parentEventId) ev.parentEventId = parentEventId;
    push(() => store.append(ev));
  };
  emit('run.created', 'system', { task: brief(meta.task, 400), model: meta.model, cwd: meta.cwd });
  return {
    runId,
    emit,
    finish(outcome, metrics) {
      if (finished) return;
      finished = true;
      emit(outcome.success ? 'run.completed' : 'run.failed', 'system', { ...outcome, ...metrics });
      push(async () => {
        await store.saveSummary(runId, {
          runId, task: meta.task, model: meta.model, cwd: meta.cwd,
          startedAt, finishedAt: new Date().toISOString(), outcome, metrics,
        } as Parameters<TrajectoryStore['saveSummary']>[1], seq);
      });
    },
  };
}
