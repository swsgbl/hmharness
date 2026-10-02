/**
 * @hmharness/cli - tui-state (crash-safe pending-task memory)
 * The TUI is where multi-hour development sessions live, and the task queue
 * lives only in process memory: a crash, a terminal close, or a power loss
 * took the "what was I running" state with it. This module persists exactly
 * that - the running task plus the queued ones - to HMH_HOME/tui-pending.json
 * on every change. A graceful quit removes the file; if the file exists at
 * the next startup, the previous process died mid-work and the TUI shows a
 * recall notice (the full transcript always survives in the rollout - this
 * is the thread pointer, not the data). Best-effort IO throughout: a corrupt
 * or unwritable file degrades to "no pending work", never a crash.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface TuiPending {
  /** the task that was running when the process died ('' = none) */
  runningTask: string;
  /** queued tasks, in order */
  queue: string[];
  /** the rollout the running task belonged to, when known */
  sessionId?: string;
  savedAt: string;
}

export function pendingPath(home: string): string {
  return join(home, 'tui-pending.json');
}

export async function savePending(home: string, p: TuiPending): Promise<void> {
  try {
    await writeFile(pendingPath(home), JSON.stringify(p, null, 2), 'utf8');
  } catch { /* best effort - the pending hint is a courtesy, not a contract */ }
}

export async function loadPending(home: string): Promise<TuiPending | null> {
  try {
    const j = JSON.parse(await readFile(pendingPath(home), 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    if (typeof j.runningTask !== 'string' || !Array.isArray(j.queue)) return null;
    return {
      runningTask: j.runningTask,
      queue: j.queue.filter((q): q is string => typeof q === 'string'),
      sessionId: typeof j.sessionId === 'string' ? j.sessionId : undefined,
      savedAt: typeof j.savedAt === 'string' ? j.savedAt : '',
    };
  } catch {
    return null; // missing or corrupt = no pending work
  }
}

export async function clearPending(home: string): Promise<void> {
  try {
    await rm(pendingPath(home), { force: true });
  } catch { /* best effort */ }
}
