/**
 * @hmharness/browser - persistent CDP client for a driven browser
 *
 * BrowserOS is a Chromium fork, so plain Chrome DevTools Protocol over
 * the built-in Node >= 22 WebSocket drives it — zero dependencies (same
 * stance as environments/cdp-act, but persistent + multi-tab: one
 * browser-level WebSocket, one FLAT session per attached page target).
 *
 * Meant for OWNED instances launched by lifecycle.ts with
 * --remote-debugging-port + a dedicated profile. The discovery endpoints
 * (/json/version, /json/list) are only relied on for such instances:
 * Chromium 144+ blocks them on the DEFAULT user-data-dir.
 */
export interface CdpTabInfo {
  targetId: string;
  url: string;
  title: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface CdpBrowserOptions {
  port: number;
  /** per-command timeout (default 10s) */
  timeoutMs?: number;
}

export class CdpBrowser {
  private ws: WebSocket | null = null;
  private wsReady: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sessions = new Map<string, string>();

  constructor(private opts: CdpBrowserOptions) {}

  get port(): number {
    return this.opts.port;
  }

  private get base(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  private get timeout(): number {
    return this.opts.timeoutMs ?? 10_000;
  }

  /** is a debuggable browser reachable at the port? */
  async up(): Promise<boolean> {
    try {
      await fetch(this.base + '/json/version', { signal: AbortSignal.timeout(1_500) });
      return true;
    } catch {
      return false;
    }
  }

  /** lazily open (and keep) the browser-level WebSocket */
  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.wsReady) return this.wsReady;
    this.wsReady = (async () => {
      const res = await fetch(this.base + '/json/version', { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      const wsUrl = res && res.ok ? ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl : undefined;
      if (!wsUrl) {
        this.wsReady = null;
        throw new Error(`no debuggable browser at ${this.base} (start it: hmh browser start)`);
      }
      const ws = new WebSocket(wsUrl) as WebSocket;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 3_000);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket error')); }, { once: true });
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
        let msg: CdpResponse;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id === undefined) return; // events (Target, Runtime, …) — not used yet
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
        else p.resolve(msg.result);
      });
      ws.addEventListener('close', () => this.dropSocket());
      ws.addEventListener('error', () => this.dropSocket());
      this.ws = ws;
      return ws;
    })().catch((err) => {
      this.wsReady = null;
      throw err;
    });
    return this.wsReady;
  }

  private dropSocket(): void {
    this.ws = null;
    this.wsReady = null;
    this.sessions.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  /** send one command; auto-reconnects once if the socket died */
  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    try {
      return await this.sendOnce(method, params, sessionId);
    } catch (err) {
      if (!this.ws && sessionId === undefined) return await this.sendOnce(method, params, sessionId);
      throw err;
    }
  }

  private async sendOnce(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** browser version string (e.g. "BrowserOS 155.x …") */
  async version(): Promise<string> {
    try {
      const res = await fetch(this.base + '/json/version', { signal: AbortSignal.timeout(2_000) });
      const j = (await res.json()) as { Browser?: string };
      return j.Browser ?? 'unknown';
    } catch {
      return 'unreachable';
    }
  }

  /** open page targets (via /json/list — reliable on owned instances) */
  async tabs(): Promise<CdpTabInfo[]> {
    try {
      const res = await fetch(this.base + '/json/list', { signal: AbortSignal.timeout(2_000) });
      const list = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      return list.filter((t) => t.type === 'page').map((t) => ({ targetId: t.id, url: t.url, title: t.title }));
    } catch {
      return [];
    }
  }

  async openTab(url: string): Promise<string> {
    const r = (await this.send('Target.createTarget', { url })) as { targetId: string };
    return r.targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
    this.sessions.delete(targetId);
  }

  async activateTab(targetId: string): Promise<void> {
    await this.send('Target.activateTarget', { targetId }).catch(() => undefined);
  }

  /** attach (once) to a page target and enable the domains we use */
  private async session(targetId: string): Promise<string> {
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const r = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await this.send('Runtime.enable', {}, r.sessionId).catch(() => undefined);
    await this.send('Page.enable', {}, r.sessionId).catch(() => undefined);
    this.sessions.set(targetId, r.sessionId);
    return r.sessionId;
  }

  /** evaluate an expression in a page (returnByValue; optional awaitPromise) */
  async evaluate(targetId: string, expression: string, awaitPromise = false): Promise<unknown> {
    const sessionId = await this.session(targetId);
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId)) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown').slice(0, 200));
    }
    return r.result?.value;
  }

  /** navigate + wait for the load to settle (polled readyState — never
   *  fails the navigation itself, worst case reports interactive) */
  async navigate(targetId: string, url: string, timeoutMs = 20_000): Promise<void> {
    await this.send('Page.navigate', { url }, await this.session(targetId));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate(targetId, 'document.readyState').catch(() => null);
      if (state === 'complete' || state === 'interactive') return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** full-page PNG screenshot as a Buffer */
  async screenshot(targetId: string): Promise<Buffer> {
    const sessionId = await this.session(targetId);
    const r = (await this.send('Page.captureScreenshot', { format: 'png' }, sessionId)) as { data?: string };
    if (!r.data) throw new Error('screenshot returned no data');
    return Buffer.from(r.data, 'base64');
  }

  async close(): Promise<void> {
    // dropSocket() nulls the field WITHOUT closing the socket — the WS
    // would stay open and hold the event loop (found by the extension
    // real-browser test: runner hung after PASS until this was fixed).
    // Bounded by a 1s race: a socket whose peer already died may never
    // deliver a close event.
    const ws = this.ws;
    this.dropSocket();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1_000);
        ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
        try { ws.close(); } catch { clearTimeout(t); resolve(); /* already dead */ }
      });
    }
  }
}
