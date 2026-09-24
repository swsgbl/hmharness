/**
 * @hmharness/observability - TrajectoryStore (V2 blueprint M1 storage).
 *
 * Deliberately boring for v1: append-only JSONL per run under
 * <home>/runs/<run-id>/trajectory.jsonl plus summary.json. The interface is
 * the contract; a SQLite/Postgres adapter can replace the implementation
 * later without touching callers. Every method is best-effort by design in
 * the RECORDER (which wraps this store); the store itself surfaces errors so
 * tests can assert on real behavior.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent, RunId, RunMetrics, RunOutcome, RunSummary, Trajectory } from './events.ts';

export interface TrajectoryStore {
  runDir(runId: RunId): string;
  append(event: RunEvent): Promise<void>;
  getRun(runId: RunId): Promise<Trajectory>;
  listRuns(limit?: number): Promise<RunSummary[]>;
  /** Persist the run summary (called once at finish; cheap enough to re-call). */
  saveSummary(runId: RunId, head: Omit<Trajectory, 'events'>, eventCount: number): Promise<void>;
  exportRun(runId: RunId, format: 'jsonl' | 'json'): Promise<string>;
}

export function runsRoot(home: string): string {
  return join(home, 'runs');
}

export function jsonlTrajectoryStore(home: string): TrajectoryStore {
  const dirOf = (runId: RunId) => join(runsRoot(home), runId.replace(/[^a-zA-Z0-9_-]/g, ''));
  return {
    runDir: dirOf,
    async append(event) {
      const dir = dirOf(event.runId);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'trajectory.jsonl'), JSON.stringify(event) + '\n', 'utf8');
    },
    async getRun(runId) {
      const dir = dirOf(runId);
      let head: Omit<Trajectory, 'events'>;
      try {
        head = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as Omit<Trajectory, 'events'>;
      } catch {
        // unfinished run: synthesize a head from the first event
        const lines = (await readFile(join(dir, 'trajectory.jsonl'), 'utf8')).trim();
        const first = lines ? (JSON.parse(lines.split('\n')[0]) as RunEvent) : null;
        head = {
          runId,
          task: first?.type === 'run.started' ? String((first.payload as { task?: string })?.task ?? '') : '',
          startedAt: first?.ts ?? new Date().toISOString(),
          events: [],
        } as Omit<Trajectory, 'events'>;
        delete (head as Partial<Trajectory>).events;
      }
      const events: RunEvent[] = [];
      try {
        const raw = await readFile(join(dir, 'trajectory.jsonl'), 'utf8');
        for (const line of raw.trim().split('\n')) {
          if (!line) continue;
          try { events.push(JSON.parse(line) as RunEvent); } catch { /* torn tail line */ }
        }
      } catch { /* no events yet */ }
      return { ...head, events };
    },
    async listRuns(limit = 20) {
      let ids: string[] = [];
      try { ids = (await readdir(runsRoot(home))).filter((d) => d.startsWith('run_')).sort().reverse(); } catch { return []; }
      const out: RunSummary[] = [];
      for (const id of ids.slice(0, limit)) {
        try {
          const s = JSON.parse(await readFile(join(runsRoot(home), id, 'summary.json'), 'utf8')) as RunSummary;
          out.push({ ...s, runId: id });
        } catch {
          out.push({ runId: id, task: '(unfinished)', startedAt: '' });
        }
      }
      return out;
    },
    async saveSummary(runId, head, eventCount) {
      const dir = dirOf(runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'summary.json'), JSON.stringify({ ...head, eventCount }, null, 2) + '\n', 'utf8');
    },
    async exportRun(runId, format) {
      const t = await this.getRun(runId);
      if (format === 'json') return JSON.stringify(t, null, 2);
      return t.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    },
  };
}

/** Outcome/metrics convenience for finish() callers. */
export type { RunOutcome, RunMetrics };
