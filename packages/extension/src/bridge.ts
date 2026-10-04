/**
 * @hmharness/extension - the loopback bridge server
 *
 * The Node-side half of the browser-extension adaptation. Architecture is
 * the pattern the 2026 agent-desktop ↔ extension pairs converged on
 * (ChatGPT's desktop app and its browser extension work this way): a
 * server bound to 127.0.0.1 that the extension's background context
 * pairs with via a ONE-TIME CODE, then attaches to as a long-lived
 * SSE downlink + POST uplink. We use fetch-stream SSE rather than
 * EventSource because Chrome MV3 service workers have no EventSource —
 * and the same fetch-stream code path works in Firefox event pages and
 * Safari, so the extension payload stays one file for all browsers.
 *
 * Why not Chrome native messaging: the host-registration model differs
 * per browser (registry keys / profile manifests) and Safari only
 * allows messaging through a bundled app container — loopback HTTP is
 * the ONE transport every mainstream browser speaks identically.
 *
 * Security posture (kept boring on purpose):
 *  - 127.0.0.1 ONLY, never 0.0.0.0
 *  - Host header whitelist (DNS-rebinding refusal)
 *  - Origin must be an extension scheme or loopback when present
 *  - bearer token (sha256-at-rest) on every data endpoint
 *  - pairing codes: one-time, 5-minute TTL, store-level lockout
 *  - commands are STRUCTURED — the wire never carries eval-able code
 *
 * Liveness for the agent's registry: the bridge writes a state file
 * (HMH_HOME/cognitive/extension-state.json) on every connect/disconnect/
 * uplink, so `discoverExtensionBridgeSync` can decide — without network
 * I/O — whether extension tools are live on THIS machine right now.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type BridgeCommand, type BridgeStatus, type TabInfo, type UplinkMessage } from './protocol.ts';
import { isPaired, redeemPairingCode, touchLastSeen, verifyToken } from './token.ts';

export const DEFAULT_BRIDGE_PORT = 7789; // hmh web owns 7788; the bridge takes the neighbor

/** Bridge port resolution: explicit arg > HMH_EXTENSION_PORT > default. */
export function bridgePort(explicit?: number): number {
  const fromEnv = Number(process.env.HMH_EXTENSION_PORT ?? 0);
  const p = explicit ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_BRIDGE_PORT);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_BRIDGE_PORT;
}

export function stateFilePath(home: string): string {
  return join(home, 'cognitive', 'extension-state.json');
}

export interface BridgeStateFile {
  kind: 'hmharness-extension-state';
  version: 1;
  port: number;
  running: boolean;
  connected: boolean;
  browser?: string;
  extVersion?: string;
  lastSeenAt?: string;
  updatedAt: string;
  /** per-run random secret for the AGENT side of this bridge (the agent
   *  process authenticates with it over loopback; it never leaves the
   *  machine and dies with the bridge — same trust file model as the
   *  browser/lsp trust stores under HMH_HOME) */
  agentSecret: string;
}

interface LiveExtension {
  res: ServerResponse;
  browser?: string;
  extVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const EXTENSION_ORIGIN = /^(chrome|moz|safari)-extension:\/\/[^/?#]+/i;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export class ExtensionBridgeServer {
  private server: Server | null = null;
  private port = 0;
  private live: LiveExtension | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly home: string;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private agentSecret = '';
  /** CLI serve loop hook: fires on extension attach/detach for live output. */
  onConnectionChange?: (connected: boolean) => void;
  /** last tabs.push payload — surfaced in status for humans, not used by tools */
  lastTabs: TabInfo[] = [];

  constructor(opts: { home: string }) {
    this.home = opts.home;
  }

  /** Start listening on 127.0.0.1 (port 0 = ephemeral, for tests). */
  async start(port = bridgePort()): Promise<{ port: number }> {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => this.fail(res, 500, String(err instanceof Error ? err.message : err)));
    });
    this.closed = false;
    this.agentSecret = randomBytes(32).toString('hex');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('bridge listen failed');
    this.server = server;
    this.port = addr.port;
    this.pingTimer = setInterval(() => this.beat(), 15_000);
    await this.writeState(false);
    return { port: this.port };
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge stopped'));
    }
    this.pending.clear();
    if (this.live) {
      this.live.res.end();
      this.live = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // force-close lingering keep-alive sockets so tests exit promptly
      this.server.closeAllConnections?.();
    });
    this.server = null;
    await rm(stateFilePath(this.home), { force: true }).catch(() => undefined);
  }

  /** Live snapshot (same shape as GET /v1/status). */
  async status(): Promise<BridgeStatus> {
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      port: this.port,
      paired: await isPaired(this.home),
      connected: Boolean(this.live),
      browser: this.live?.browser,
      extVersion: this.live?.extVersion,
      lastSeen: this.live?.lastSeenAt,
    };
  }

  /** Send a structured command to the connected extension and await its
   *  result. Rejects immediately (no queueing) when no extension is
   *  attached — an honest error beats a 15s hang for the agent loop. */
  command(kind: 'tabs.list', timeoutMs?: number): Promise<TabInfo[]>;
  command(kind: 'ping', timeoutMs?: number): Promise<unknown>;
  command(kind: 'page.read', opts?: { tabId?: number; timeoutMs?: number }): Promise<unknown>;
  command(kind: 'page.act', opts?: { tabId?: number; act: import('./protocol.ts').PageAct; timeoutMs?: number }): Promise<unknown>;
  command(kind: string, opts?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  async command(kind: string, a?: number | { tabId?: number; act?: import('./protocol.ts').PageAct; timeoutMs?: number }, b?: number): Promise<unknown> {
    if (!this.live) throw new Error('没有已连接的浏览器扩展 — 打开扩展 popup 配对并连接（hmh extension status 查看）');
    const opts = typeof a === 'object' && a !== null ? a : {};
    const timeoutMs = typeof a === 'number' ? a : (opts.timeoutMs ?? b ?? 15_000);
    const cmd: BridgeCommand = { id: randomUUID(), kind, ...(opts as object) } as BridgeCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        reject(new Error(`extension command ${kind} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(cmd.id, { resolve, reject, timer });
      this.send(cmd);
    });
  }

  // ---------------------------------------------------------------- routes

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '').split('?')[0];
    if (!this.guardHost(req, res)) return;
    if (req.method === 'GET' && url === '/v1/status') {
      return this.json(res, 200, await this.status());
    }
    if (req.method === 'POST' && url === '/v1/pair') {
      if (!this.guardOrigin(req, res)) return;
      const body = await this.readJson(req, res);
      if (!body) return;
      const r = await redeemPairingCode(this.home, String((body as { code?: unknown }).code ?? ''));
      if (!r.ok) return this.json(res, 403, { ok: false, error: r.error });
      return this.json(res, 200, { ok: true, token: r.token, protocol: PROTOCOL_VERSION });
    }
    if (req.method === 'GET' && url === '/v1/events') {
      if (!this.guardOrigin(req, res)) return;
      if (!(await this.authorized(req, res))) return;
      return this.attachSse(req, res);
    }
    if (req.method === 'POST' && url === '/v1/uplink') {
      if (!this.guardOrigin(req, res)) return;
      if (!(await this.authorized(req, res))) return;
      const msg = await this.readJson(req, res) as UplinkMessage | undefined;
      if (!msg) return;
      await this.handleUplink(msg);
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/v1/agent/command') {
      // AGENT side (tools.ts / client.ts): same loopback, different secret —
      // the extension's pairing token cannot drive this route and the agent
      // secret cannot be used as the extension's uplink token.
      if (!this.guardOrigin(req, res)) return;
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? Buffer.from(auth.slice(7), 'utf8') : Buffer.alloc(0);
      const want = Buffer.from(this.agentSecret, 'utf8');
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return this.fail(res, 401, 'unauthorized agent channel');
      }
      const body = await this.readJson(req, res) as { kind?: string; tabId?: number; act?: import('./protocol.ts').PageAct; timeoutMs?: number } | undefined;
      if (!body || typeof body.kind !== 'string') return this.fail(res, 400, 'command needs a kind');
      try {
        const data = await this.command(body.kind as never, { tabId: body.tabId, act: body.act }, Math.min(body.timeoutMs ?? 15_000, 60_000));
        return this.json(res, 200, { ok: true, data });
      } catch (err) {
        return this.json(res, 502, { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
      }
    }
    this.json(res, 404, { ok: false, error: `unknown route ${req.method} ${url}` });
  }

  /** DNS-rebinding refusal: the Host header must name the loopback. */
  private guardHost(req: IncomingMessage, res: ServerResponse): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return true;
    this.fail(res, 403, `refused Host '${host}' — bridge is loopback-only`);
    return false;
  }

  /** CORS guard: an Origin header, when sent, must be an extension page or
   *  loopback. A random website's JS gets nothing — even pre-pairing. */
  private guardOrigin(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (EXTENSION_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Vary', 'Origin');
      return true;
    }
    this.fail(res, 403, `refused Origin '${origin}'`);
    return false;
  }

  private async authorized(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !(await verifyToken(this.home, token))) {
      this.fail(res, 401, 'unauthorized — pair first (hmh extension pair)');
      return false;
    }
    return true;
  }

  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) {
        this.fail(res, 413, 'body too large');
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      this.fail(res, 400, 'invalid JSON');
      return undefined;
    }
  }

  // ------------------------------------------------------------------ SSE

  private attachSse(req: IncomingMessage, res: ServerResponse): void {
    // ONE extension at a time: a fresh attach (service worker restarted)
    // replaces the previous stream — the newest connection is the truth.
    if (this.live) {
      try { this.live.res.end(); } catch { /* already gone */ }
      this.live = null;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(this.sse('hello', { ok: true, protocol: PROTOCOL_VERSION }));
    this.live = { res, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
    req.on('close', () => {
      if (this.live?.res === res) {
        this.live = null;
        void this.writeState();
        this.onConnectionChange?.(false);
      }
    });
    void this.writeState();
    this.onConnectionChange?.(true);
  }

  private sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private send(cmd: BridgeCommand): void {
    if (!this.live) return;
    try {
      this.live.res.write(this.sse('command', cmd));
    } catch {
      this.live = null; // dead socket: command will time out honestly
    }
  }

  /** 15s in-stream ping — keeps the fetch-stream reader in the extension's
   *  service worker fed (and its lifetime extended) even when idle. */
  private beat(): void {
    if (this.closed || !this.live) return;
    try {
      this.live.res.write(`event: ping\ndata: {"t":${JSON.stringify(new Date().toISOString())}}\n\n`);
    } catch {
      this.live = null;
    }
  }

  private async handleUplink(msg: UplinkMessage): Promise<void> {
    if (msg.kind === 'hello') {
      if (msg.protocol !== PROTOCOL_VERSION) {
        // version mismatch: drop politely — the extension shows the reason
        if (this.live) { try { this.live.res.write(this.sse('fatal', { error: `protocol ${msg.protocol} != ${PROTOCOL_VERSION}` })); } catch { /* dead */ } }
        return;
      }
      if (this.live) {
        this.live.browser = msg.browser;
        this.live.extVersion = msg.extVersion;
        this.live.lastSeenAt = new Date().toISOString();
      }
      await touchLastSeen(this.home);
      await this.writeState(true);
      return;
    }
    if (msg.kind === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return; // late result for a timed-out command — nothing to do
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(String(msg.error).slice(0, 300)));
      if (this.live) this.live.lastSeenAt = new Date().toISOString();
      return;
    }
    if (msg.kind === 'tabs.push') {
      this.lastTabs = Array.isArray(msg.tabs) ? msg.tabs.slice(0, 200) : [];
      if (this.live) this.live.lastSeenAt = new Date().toISOString();
      return;
    }
    if (msg.kind === 'bye' && this.live) {
      try { this.live.res.end(); } catch { /* already gone */ }
      this.live = null;
      await this.writeState(false);
      this.onConnectionChange?.(false);
    }
  }

  // ---------------------------------------------------------------- state

  private async writeState(connectedOverride?: boolean): Promise<void> {
    const state: BridgeStateFile = {
      kind: 'hmharness-extension-state',
      version: 1,
      port: this.port,
      running: !this.closed,
      connected: connectedOverride ?? Boolean(this.live),
      browser: this.live?.browser,
      extVersion: this.live?.extVersion,
      lastSeenAt: this.live?.lastSeenAt,
      updatedAt: new Date().toISOString(),
      agentSecret: this.agentSecret,
    };
    try {
      await mkdir(join(this.home, 'cognitive'), { recursive: true });
      await writeFile(stateFilePath(this.home), JSON.stringify(state, null, 1), 'utf8');
    } catch { /* state file is best-effort; the bridge itself still works */ }
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  private fail(res: ServerResponse, code: number, error: string): void {
    if (!res.headersSent) this.json(res, code, { ok: false, error });
    else try { res.end(); } catch { /* socket gone */ }
  }
}

/** Live HTTP probe of a (possibly foreign) bridge — the async discovery
 *  used by `hmh extension status`. Any answer proves liveness; network
 *  error proves absence (same discipline as browser detectRunning). */
export async function probeBridge(port = bridgePort()): Promise<BridgeStatus | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(1_500) });
    if (!r.ok) return null;
    const j = await r.json() as BridgeStatus;
    return j.ok ? j : null;
  } catch {
    return null;
  }
}

/** Read + validate the bridge state file WITHOUT network I/O (the sync
 *  discovery path the agent registry uses at build time). A state file
 *  whose updatedAt is older than staleMs means the bridge died without
 *  cleaning up — treated as not running, honestly. */
export function readBridgeState(home: string, staleMs = 60_000): BridgeStateFile | null {
  try {
    const j = JSON.parse(readFileSync(stateFilePath(home), 'utf8')) as BridgeStateFile;
    if (j?.kind !== 'hmharness-extension-state') return null;
    const age = Date.now() - Date.parse(j.updatedAt);
    if (!Number.isFinite(age) || age > staleMs) return null;
    return j.running ? j : null;
  } catch {
    return null;
  }
}
