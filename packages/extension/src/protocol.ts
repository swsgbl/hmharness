/**
 * @hmharness/extension - wire protocol (hmext/1)
 *
 * The bridge speaks plain JSON over three loopback HTTP shapes, chosen so
 * ONE client code path works in every mainstream browser's background
 * context (Chrome MV3 service worker, Firefox MV3 event page, Safari):
 *
 *   GET  /v1/events   SSE downlink  (read via fetch-stream — service
 *                                   workers have no EventSource)
 *   POST /v1/uplink   JSON uplink   (hello / command results / tab pushes)
 *   POST /v1/pair     one-time code -> bearer token (ChatGPT-style pairing)
 *   GET  /v1/status   unauthenticated liveness/pairing snapshot (no secrets)
 *
 * Versioning: every hello carries `protocol: 'hmext/1'`; a mismatched
 * version is refused with a readable reason, never silently misparsed.
 * Commands are STRUCTURED (kind + fields) — the wire never carries code to
 * evaluate, so the extension side has no eval surface for a compromised
 * bridge to abuse.
 */

export const PROTOCOL_VERSION = 'hmext/1';

/** Tab as seen by the extension's tabs API. */
export interface TabInfo {
  id: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  /** window id — lets the agent tell two same-titled tabs apart */
  windowId: number;
}

/** Structured page action. `selector` is a plain CSS selector — the
 *  extension resolves and clicks/types into it; no script text is ever
 *  transported. page.act ALWAYS goes through the agent approval gate. */
export interface PageAct {
  action: 'click' | 'type' | 'scroll' | 'select';
  selector?: string;
  text?: string;
  /** scroll direction when action=scroll */
  direction?: 'up' | 'down' | 'top' | 'bottom';
}

/** Bridge -> extension commands (SSE `command` events). */
export type BridgeCommand =
  | { id: string; kind: 'tabs.list' }
  | { id: string; kind: 'page.read'; tabId?: number }
  | { id: string; kind: 'page.act'; tabId?: number; act: PageAct }
  | { id: string; kind: 'ping' };

/** Extension -> bridge uplink messages (POST /v1/uplink bodies). */
export type UplinkMessage =
  | { kind: 'hello'; protocol: string; extVersion: string; browser: string; extBaseUrl?: string; userAgent?: string }
  | { kind: 'result'; id: string; ok: true; data: unknown }
  | { kind: 'result'; id: string; ok: false; error: string }
  | { kind: 'tabs.push'; tabs: TabInfo[] }
  | { kind: 'bye' };

/** Unauthenticated startup announce (POST /v1/announce): the extension's
 *  own base URL (chrome-extension://host/ or moz-extension://uuid/), so
 *  tooling can find the popup WITHOUT browser automation. Leaks nothing —
 *  a URL is only useful to a process that could talk to the extension
 *  anyway. Closes the Firefox discovery chicken-egg: the background can
 *  announce before pairing (no token yet), giving automation the popup
 *  URL it needs to drive the pair form. */
export interface AnnounceMessage {
  extBaseUrl: string;
  browser?: string;
  extVersion?: string;
}

/** Raw page data collected by the injected collector (see extension/
 *  background.js `collectPageData`). Node-side `summarizePage` (page.ts)
 *  turns this into the agent-facing snapshot — the DOM-facing part stays
 *  in the browser, the normalizing/truncating part is testable here. */
export interface RawPageData {
  url: string;
  title: string;
  selection: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  inputs: Array<{ tag: string; type: string; name: string; placeholder: string }>;
  text: string;
}

/** Agent-facing page snapshot (summarizePage output). */
export interface PageSnapshot {
  url: string;
  title: string;
  selection: string;
  outline: string[];
  links: string[];
  inputs: string[];
  text: string;
  truncated: boolean;
}

/** Live bridge/connection status (GET /v1/status and the state file). */
export interface BridgeStatus {
  ok: boolean;
  protocol: string;
  port: number;
  paired: boolean;
  /** an extension is CURRENTLY connected (SSE attached + hello'd) */
  connected: boolean;
  browser?: string;
  extVersion?: string;
  /** the extension's own base URL — from the paired hello, or (unpaired)
   *  from the last startup announce */
  extBaseUrl?: string;
  lastSeen?: string;
}
