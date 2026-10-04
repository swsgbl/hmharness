/**
 * @hmharness/extension - discovery (the lsp/browser registry pattern)
 *
 * Two discovery shapes, both honest:
 *  - SYNC (agent registry build): reads the bridge state file under
 *    HMH_HOME — no network I/O in nativeRegistry, and a state file whose
 *    updatedAt has gone stale (bridge killed without cleanup) reads as
 *    NOT RUNNING, never as connected.
 *  - ASYNC (hmh extension status): a real loopback HTTP probe; any answer
 *    proves liveness, only a network error proves absence (same rule as
 *    browser detectRunning).
 */
import { readBridgeState, bridgePort } from './bridge.ts';

export interface DiscoveredExtensionBridge {
  id: 'extension-bridge';
  origin: 'state-file' | 'http';
  /** bridge process reachable (or state file fresh) */
  healthy: boolean;
  /** a paired extension is attached RIGHT NOW */
  connected: boolean;
  port: number;
  browser?: string;
  extVersion?: string;
  unhealthyReason?: string;
}

/** Sync discovery from the state file — the nativeRegistry path. */
export function discoverExtensionBridgeSync(home: string): DiscoveredExtensionBridge {
  const st = readBridgeState(home);
  if (!st) {
    return {
      id: 'extension-bridge',
      origin: 'state-file',
      healthy: false,
      connected: false,
      port: bridgePort(),
      unhealthyReason: '桥未运行（hmh extension serve 启动）',
    };
  }
  return {
    id: 'extension-bridge',
    origin: 'state-file',
    healthy: true,
    connected: st.connected,
    port: st.port,
    browser: st.browser,
    extVersion: st.extVersion,
  };
}

/** Async HTTP probe — the `hmh extension status` path. Never throws:
 *  unreachable port = honest unhealthy, not an exception. */
export async function discoverExtensionBridge(port = bridgePort()): Promise<DiscoveredExtensionBridge> {
  const base: DiscoveredExtensionBridge = {
    id: 'extension-bridge',
    origin: 'http',
    healthy: false,
    connected: false,
    port,
    unhealthyReason: `127.0.0.1:${port} 无响应（hmh extension serve 启动）`,
  };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(1_500) });
    if (!r.ok) return base;
    const j = await r.json() as { ok?: boolean; connected?: boolean; browser?: string; extVersion?: string };
    if (!j.ok) return base;
    return { ...base, healthy: true, connected: Boolean(j.connected), browser: j.browser, extVersion: j.extVersion, unhealthyReason: undefined };
  } catch {
    return base;
  }
}
