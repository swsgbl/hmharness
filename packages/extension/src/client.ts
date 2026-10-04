/**
 * @hmharness/extension - agent-side client
 *
 * The bridge runs in its own process (`hmh extension serve`); the agent's
 * extension_* tools talk to it over the loopback agent channel using the
 * per-run secret the bridge left in its state file. The extension's
 * pairing token is NOT reused here — the two channels cannot substitute
 * for each other by design.
 */
import { readBridgeState, probeBridge } from './bridge.ts';
import type { BridgeStatus } from './protocol.ts';

export interface BridgeHandle {
  port: number;
  agentSecret: string;
}

/** Sync binding to a running bridge from the state file (null = not running). */
export function bridgeFromState(home: string): BridgeHandle | null {
  const st = readBridgeState(home);
  return st && st.agentSecret ? { port: st.port, agentSecret: st.agentSecret } : null;
}

/** Async liveness probe of a possibly-foreign bridge. */
export async function bridgeStatus(port: number): Promise<BridgeStatus | null> {
  return probeBridge(port);
}

/** Run one structured command through the running bridge. */
export async function agentCommand<T = unknown>(
  handle: BridgeHandle,
  body: { kind: string; tabId?: number; act?: import('./protocol.ts').PageAct; timeoutMs?: number },
): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${handle.port}/v1/agent/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.agentSecret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((body.timeoutMs ?? 15_000) + 5_000),
  });
  const j = await r.json().catch(() => ({ ok: false, error: `agent channel HTTP ${r.status}` })) as { ok?: boolean; data?: T; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `agent channel HTTP ${r.status}`);
  return j.data as T;
}
