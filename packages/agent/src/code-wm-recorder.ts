/**
 * @hmharness/agent - Code World Model recorder (production sensor wiring)
 *
 * Round 38 closed the loop for extension page observations; round 43 adds
 * the LSP side: lspTools now emits read-only observations (symbols pulled
 * by lsp_symbols, diagnostics seen by lsp_diagnostics) and the sink below
 * feeds them through the SAME ontology pipeline (syncCodeWorldModel) into
 * the SAME per-home persisted model. The recorder is a lazy per-home
 * singleton — the first observation loads the model from HMH_HOME, a
 * sensor feeds it, and one debounce flushes both families to disk.
 * LiveCodeWmSensor remains the wrapper for callers that own a client and
 * want file-driven syncs; the tool-hook path shares its ingestion core.
 *
 * Failure posture: everything best-effort — a storage error logs nothing
 * and never breaks the tool that observed the page (evidence must not be
 * able to kill the work it evidences). A crash loses at most one debounce
 * window of observations.
 */
import { loadCodeWorldModel, saveCodeWorldModel, type CodeWorldModel } from '@hmharness/cognitive';
import type { RawPageData } from '@hmharness/extension';
import { syncExtensionRuntime } from './extension-wm-sensor.ts';
import { syncCodeWorldModel, type CodeWorldSyncInput } from './code-wm-sensor.ts';

const SAVE_DEBOUNCE_MS = 2_000;

interface RecorderEntry {
  load: Promise<CodeWorldModel>;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, RecorderEntry>();

/** The onPageRead hook handed to extensionTools — one closure per home. */
export function pageReadSink(home: string): (raw: RawPageData) => void {
  return (raw) => {
    void mutate(home, (cwm) => syncExtensionRuntime(cwm, raw));
  };
}

/** The onObserve hook handed to lspTools — the LSP tools' read-only pulls
 *  become durable Code WM evidence, same store, same debounce. */
export function lspObserveSink(home: string): (obs: CodeWorldSyncInput) => void {
  return (obs) => {
    if (!obs.symbols?.length && !obs.diagnostics?.length) return;
    void mutate(home, (cwm) => syncCodeWorldModel(cwm, obs));
  };
}

async function mutate(home: string, fn: (cwm: CodeWorldModel) => void): Promise<void> {
  try {
    let entry = entries.get(home);
    if (!entry) {
      entry = { load: loadCodeWorldModel(home), dirty: false, timer: null };
      entries.set(home, entry);
    }
    const cwm = await entry.load;
    fn(cwm);
    entry.dirty = true;
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        if (!entry) return;
        entry.timer = null;
        void flush(home);
      }, SAVE_DEBOUNCE_MS);
    }
  } catch { /* observation is best-effort by contract */ }
}

async function flush(home: string): Promise<void> {
  const entry = entries.get(home);
  if (!entry || !entry.dirty) return;
  entry.dirty = false;
  try {
    const cwm = await entry.load;
    await saveCodeWorldModel(home, cwm);
  } catch {
    entry.dirty = true; // keep the evidence for the next flush
  }
}

/** Test isolation: drop caches + pending timers (never used in production). */
export function resetCodeWorldRecorder(): void {
  for (const [, e] of entries) if (e.timer) clearTimeout(e.timer);
  entries.clear();
}

/** Introspection for tests/status surfaces: the live model for a home. */
export async function liveCodeWorldModel(home: string): Promise<CodeWorldModel | null> {
  const entry = entries.get(home);
  return entry ? entry.load : null;
}
