/**
 * @hmharness/agent - Code World Model recorder (production sensor wiring)
 *
 * Round 38 closed the loop for extension page observations; round 43 adds
 * the LSP side (lspTools onObserve → symbols/diagnostics); round 44 adds
 * the build side: the harmony build tools' results become the model's
 * LATEST BuildFact, wrapped at registry assembly so the domain package
 * stays single-minded (kernel-only deps — the audit's composition-layer
 * rule). All three families share the lazy per-home singleton and one
 * debounced flush. LiveCodeWmSensor remains the wrapper for callers that
 * own a client and want file-driven syncs; the tool-hook paths share the
 * ingestion core.
 *
 * Failure posture: everything best-effort — a storage error logs nothing
 * and never breaks the tool that observed the page (evidence must not be
 * able to kill the work it evidences). A crash loses at most one debounce
 * window of observations.
 */
import { createHash } from 'node:crypto';
import { loadCodeWorldModel, saveCodeWorldModel, type CodeWorldModel } from '@hmharness/cognitive';
import type { RawPageData } from '@hmharness/extension';
import type { Tool } from '@hmharness/kernel';
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

/** Build facts replace (the model keeps only the LATEST build verdict). */
export function buildSink(home: string): (fact: { ok: boolean; outputDigest?: string }) => void {
  return (fact) => {
    void mutate(home, (cwm) => cwm.ingest({ build: { ok: fact.ok, ...(fact.outputDigest ? { outputDigest: fact.outputDigest } : {}), at: new Date().toISOString() } }));
  };
}

/** Registry-assembly wrapper (round 44): the harmony build tools gain a
 *  build-fact observation without the domain package learning about
 *  cognitive. The wrap never alters the tool's result; a sink error is
 *  swallowed (the observation must not fail the work it evidences). */
export function observeBuildTools(tools: Tool[], home: string): Tool[] {
  const sink = buildSink(home);
  return tools.map((t) => {
    if (t.name !== 'harmony_build' && t.name !== 'harmony_cjpm_build') return t;
    const orig = t.execute.bind(t);
    const wrapped: Tool = {
      ...t,
      async execute(args, ctx) {
        const r = await orig(args, ctx);
        try {
          const out = typeof r.output === 'string' ? r.output : '';
          sink({ ok: !r.isError, ...(out ? { outputDigest: createHash('sha256').update(out).digest('hex').slice(0, 16) } : {}) });
        } catch { /* observation must never fail the tool */ }
        return r;
      },
    };
    return wrapped;
  });
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
