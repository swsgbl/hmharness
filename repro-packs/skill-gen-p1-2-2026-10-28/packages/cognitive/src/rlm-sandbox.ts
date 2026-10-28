/**
 * @hmharness/cognitive - RLM sandbox (review P0-1 / RLM-001..004, 2026-10-03)
 *
 * RLM eval code used to run through `new Function` in the MAIN process:
 * full authority (globals, dynamic import, process), only budget-counted.
 * This module moves eval into a worker_threads Worker with real walls:
 *
 *   - crash containment: a throwing/OOM-ing eval cannot take the host down
 *   - termination: infinite loops are killed at the timeout (terminate())
 *   - secret isolation: the worker is created with `env: {}` — API keys in
 *     the host environment are NEVER inherited (RLM-002 security rule)
 *   - memory ceiling: resourceLimits cap the worker heap
 *   - shadowed surface: process/require are undefined inside the eval scope
 *
 * HONEST limits (documented, not hidden): a worker is a containment boundary,
 * NOT a cryptographic sandbox — determined code may still reach Node
 * internals. The walls above are real against the failure modes that
 * actually happen (bugs, loops, leaks, secret inheritance); malicious
 * capability escalation is the Capability OS layer's job, not this one.
 */
import { Worker } from 'node:worker_threads';

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
  terminated: boolean;
}

export interface SandboxOptions {
  /** hard per-eval wall; the worker is terminated past it (default 15s) */
  timeoutMs?: number;
  /** worker heap caps (defaults below) */
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
}

/** The worker bootstrap source. Runs as CommonJS, receives {code, vars, meta}
 *  through workerData (structured-cloned at spawn), executes the code as an
 *  async function body with a frozen ctx, and posts the result back.
 *  RED-TEAM HARDENING (round 32, executable-payload driven): after the
 *  bootstrap captures parentPort, the escape-reachable globals are STRIPPED
 *  from the worker's globalThis — globalThis.process (kills the R1/R4
 *  reach-and-kill vectors), Worker/fetch/WebSocket (network + thread
 *  spawn). What remains impossible to block without a per-worker
 *  permission model is declared in SANDBOX_BYPASS_VECTORS below — pinned
 *  by the red-team test so a silent hole can never masquerade as covered. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  // hardening pass: strip escape globals BEFORE evaluating any user code
  try { delete globalThis.process; } catch { /* non-configurable: shadow instead below */ }
  try { globalThis.Worker = undefined; } catch { }
  try { globalThis.fetch = undefined; } catch { }
  try { globalThis.WebSocket = undefined; } catch { }
  const ctx = Object.freeze({ vars: Object.freeze({ ...workerData.vars }), meta: Object.freeze({ ...workerData.meta }) });
  try {
    const fn = new Function('ctx', 'process', 'require', 'fetch', 'Worker', 'WebSocket', '"use strict";return (async()=>{' + workerData.code + '})();');
    const value = await fn(ctx, undefined, undefined, undefined, undefined, undefined);
    parentPort.postMessage({ ok: true, value });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: { code: 'E_EVAL', message: err && err.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500) } });
  }
})();
`;

/**
 * HONEST threat model: escape vectors the worker CANNOT block today (they
 * need a per-worker permission model, which Node does not offer per
 * worker). The red-team test asserts every still-escaping probe is on this
 * list, and every vector NOT on it is blocked — a new silent hole fails CI.
 */
export const SANDBOX_BYPASS_VECTORS: readonly string[] = [
  'dynamic-import', // import('node:*') inside eval code reaches Node modules
] as const;

/** Run RLM eval code inside a fresh worker. One worker per eval — RLM evals
 *  are coarse-grained (composing workspace variables), so per-eval spawn
 *  overhead (~10-30ms) is acceptable for real isolation each time. */
export function runSandboxedEval(code: string, vars: Record<string, unknown>, meta: Record<string, unknown>, opts: SandboxOptions = {}): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { code, vars, meta }, // structured-cloned at spawn — no message race
        env: {}, // secrets never inherit (RLM-002)
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? 256,
          maxYoungGenerationSizeMb: opts.maxYoungGenerationSizeMb ?? 64,
        },
      });
    } catch (err) {
      resolve({ ok: false, error: { code: 'E_SANDBOX_SPAWN', message: String(err).slice(0, 200) }, durationMs: Date.now() - started, terminated: false });
      return;
    }
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => undefined);
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'E_SANDBOX_TIMEOUT', message: `eval exceeded ${timeoutMs}ms and was terminated` }, durationMs: Date.now() - started, terminated: true });
    }, timeoutMs);
    worker.on('message', (m: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => {
      finish({ ok: m.ok, value: m.value, error: m.error, durationMs: Date.now() - started, terminated: false });
    });
    worker.on('error', (err: Error) => {
      finish({ ok: false, error: { code: 'E_SANDBOX_CRASH', message: String(err.message || err).slice(0, 200) }, durationMs: Date.now() - started, terminated: false });
    });
    worker.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, error: { code: 'E_SANDBOX_EXIT', message: `worker exited early (code ${code})` }, durationMs: Date.now() - started, terminated: false });
      }
    });
  });
}
