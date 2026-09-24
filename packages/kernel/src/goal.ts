/**
 * @hmharness/kernel - goal
 * Session-level goal store: HMH_HOME/goals.json maps sessionId -> goal
 * ({ goal, time }). Web/TUI persist a goal when a session starts (or a run
 * is forked); the agent runner reads it so the goal survives across turns,
 * resumes and restarts. All IO is plain readFile/writeFile - a corrupt file
 * degrades to null / an empty store rebuilt on the next write, never throws.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type GoalStore = { [sessionId: string]: { goal: string; time: string } };

async function readStore(file: string): Promise<GoalStore> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as GoalStore
      : {};
  } catch {
    // missing or corrupt file = empty store (rebuilt on the next write)
    return {};
  }
}

/** The persisted goal for one session, or null when unset/unreadable. */
export async function getGoal(home: string, sessionId: string): Promise<string | null> {
  const store = await readStore(join(home, 'goals.json'));
  const entry = store[sessionId];
  return typeof entry?.goal === 'string' ? entry.goal : null;
}

/** Persist (or, with an empty goal, clear) one session's goal. */
export async function setGoal(home: string, sessionId: string, goal: string): Promise<void> {
  const file = join(home, 'goals.json');
  const store = await readStore(file);
  if (!goal) {
    delete store[sessionId];
  } else {
    store[sessionId] = { goal, time: new Date().toISOString() };
  }
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/** Remove one session's goal (no-op when it has none). */
export async function clearGoal(home: string, sessionId: string): Promise<void> {
  const file = join(home, 'goals.json');
  const store = await readStore(file);
  delete store[sessionId];
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
}
