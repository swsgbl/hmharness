/**
 * @hmharness/cognitive - Code World Model persistence
 *
 * The model is in-memory by design (round 34); sensors were library-first
 * (round 35 LSP, round 37 extension). Round 38 gives the model a HOME:
 * one JSON file under HMH_HOME/cognitive/, load→mutate→save round-trips
 * through snapshot()/fromSnapshot(), and the only unbounded kind —
 * runtime facts (the agent browses; code size bounds the rest) — is
 * trimmed to the most recent RUNTIME_FACT_CAP at SAVE time, never inside
 * the model (the in-memory view keeps everything the process observed).
 *
 * File shape: plain JSON, user-inspectable, kind-stamped like every other
 * trust/state file under cognitive/. Corrupt/absent = fresh model, never
 * a crash (same discipline as the trust stores).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodeWorldModel, type CodeWorldData } from './code-world-model.ts';

/** Runtime evidence retained on disk. Browsing-heavy sessions can push
 *  thousands of facts; the LAST 500 carry the recent-context signal. */
export const RUNTIME_FACT_CAP = 500;

export interface CodeWorldFile extends CodeWorldData {
  kind: 'hmharness-code-world';
  version: 1;
  savedAt: string;
}

export function codeWorldModelPath(home: string): string {
  return join(home, 'cognitive', 'code-world-model.json');
}

/** Load the persisted model (fresh when absent/corrupt/foreign-shaped). */
export async function loadCodeWorldModel(home: string): Promise<CodeWorldModel> {
  try {
    const j = JSON.parse(await readFile(codeWorldModelPath(home), 'utf8')) as CodeWorldFile;
    if (j && j.kind === 'hmharness-code-world') return CodeWorldModel.fromSnapshot(j);
  } catch { /* absent/corrupt = fresh model */ }
  return new CodeWorldModel();
}

/** Persist the model (runtime facts trimmed to the newest cap). */
export async function saveCodeWorldModel(home: string, cwm: CodeWorldModel): Promise<void> {
  const data = cwm.snapshot();
  const file: CodeWorldFile = {
    kind: 'hmharness-code-world',
    version: 1,
    savedAt: new Date().toISOString(),
    ...data,
    runtime: data.runtime.slice(-RUNTIME_FACT_CAP),
  };
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(codeWorldModelPath(home), JSON.stringify(file), 'utf8');
}
