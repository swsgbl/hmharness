/**
 * @hmharness/environments - CDP act bridge (headless browser exploration)
 *
 * Executes BrowserEnvironment actions natively over the Chrome DevTools
 * Protocol: one WebSocket per action (Node >= 22 ships a built-in client,
 * so zero dependencies), Runtime.evaluate with a small per-action
 * expression. Meant for OWNED browser instances — e.g. a headless Chrome
 * launched with --remote-debugging-port=9222 and a throwaway profile; it
 * never touches the user's default browser.
 */
import type { Action } from '@hmharness/cognitive';

export interface CdpActBridgeOptions {
  /** CDP debugging base (default http://127.0.0.1:9222) */
  cdpBase?: string;
  /** per-action timeout (default 10s) */
  timeoutMs?: number;
}

interface CdpTab {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Pure mapping action → JS expression ('ok' on success). Exported for
 *  tests; null = the action's args are missing or unsafe. */
export function cdpExpression(action: Action): string | null {
  switch (action.type) {
    case 'navigate': {
      const url = String(action.args.url ?? '');
      if (!/^https?:\/\//i.test(url)) return null;
      return `(document.location.href=${JSON.stringify(url)}, 'ok')`;
    }
    case 'click': {
      const sel = String(action.args.selector ?? '');
      if (!sel) return null;
      return `(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'E_NO_MATCH'; el.click(); return 'ok';})()`;
    }
    case 'type-text':
    case 'type': {
      const sel = String(action.args.selector ?? '');
      if (!sel) return null;
      const text = String(action.args.text ?? '');
      return `(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'E_NO_MATCH'; el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()`;
    }
    default:
      return null;
  }
}

export class CdpActBridge {
  /** the driven page target, pinned on first use: CDP /json ordering is not
   *  stable across calls, so re-picking per action would silently hop between
   *  tabs (about:blank vs the explored page) and fail on elements that exist
   *  on the OTHER tab. One bridge drives ONE page, like a user on one tab. */
  private pinned: { id: string; wsUrl: string } | null = null;

  constructor(private opts: CdpActBridgeOptions = {}) {}

  private get base(): string {
    return this.opts.cdpBase ?? 'http://127.0.0.1:9222';
  }

  /** is a debugging browser reachable at base? */
  async up(): Promise<boolean> {
    try {
      await fetch(this.base + '/json/version', { signal: AbortSignal.timeout(1_500) });
      return true;
    } catch {
      return false;
    }
  }

  /** resolve (and pin) the page target this bridge drives */
  private async target(preferredTabId?: string): Promise<{ id: string; wsUrl: string } | undefined> {
    if (this.pinned) return this.pinned;
    let pages: CdpTab[] = [];
    try {
      const res = await fetch(this.base + '/json', { signal: AbortSignal.timeout(2_000) });
      pages = ((await res.json()) as CdpTab[]).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      return undefined;
    }
    // explicit tab id wins; otherwise prefer a page that is not about:blank
    const tab = (preferredTabId ? pages.find((t) => t.id === preferredTabId) : undefined) ?? pages.find((t) => !t.url.startsWith('about:')) ?? pages[0];
    if (!tab?.webSocketDebuggerUrl) return undefined;
    this.pinned = { id: tab.id, wsUrl: tab.webSocketDebuggerUrl };
    return this.pinned;
  }

  async act(
    action: Action,
    tabId?: string,
  ): Promise<{ outcome: 'success' | 'failure' | 'unknown'; output?: unknown; error?: { code: string; message: string } }> {
    const expr = cdpExpression(action);
    if (expr === null) {
      return { outcome: 'failure', error: { code: 'E_BAD_ACTION', message: `action ${action.type} missing or invalid args` } };
    }
    const started = Date.now();
    const target = await this.target(tabId);
    if (!target) {
      return { outcome: 'failure', error: { code: 'E_NO_TABS', message: `no debuggable page at ${this.base}` } };
    }
    try {
      const value = await this.evaluate(target.wsUrl, expr, this.opts.timeoutMs ?? 10_000);
      if (value === 'E_NO_MATCH') {
        return { outcome: 'failure', error: { code: 'E_NO_MATCH', message: 'selector matched no element' } };
      }
      // let the navigation finish loading before the next action lands
      if (action.type === 'navigate') await this.waitLoad(target.wsUrl, this.opts.timeoutMs ?? 10_000);
      return { outcome: 'success', output: { value, ms: Date.now() - started } };
    } catch (err) {
      // the pinned tab may be gone (crashed/closed): re-resolve once, then fail honestly
      this.pinned = null;
      const retry = await this.target(tabId);
      if (!retry) {
        return { outcome: 'failure', error: { code: 'E_CDP', message: String(err).slice(0, 200) } };
      }
      try {
        const value = await this.evaluate(retry.wsUrl, expr, this.opts.timeoutMs ?? 10_000);
        if (value === 'E_NO_MATCH') {
          return { outcome: 'failure', error: { code: 'E_NO_MATCH', message: 'selector matched no element' } };
        }
        if (action.type === 'navigate') await this.waitLoad(retry.wsUrl, this.opts.timeoutMs ?? 10_000);
        return { outcome: 'success', output: { value, ms: Date.now() - started } };
      } catch (err2) {
        return { outcome: 'failure', error: { code: 'E_CDP', message: String(err2).slice(0, 200) } };
      }
    }
  }

  /** one-shot WebSocket Runtime.evaluate against one debug target */
  private evaluate(wsUrl: string, expression: string, timeoutMs: number, awaitPromise = false): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const id = 1;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already gone */ }
        reject(new Error('CDP evaluate timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (settled) return;
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
        let msg: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id !== id) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        if (msg.result?.exceptionDetails) {
          reject(new Error('page exception: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 160)));
        } else {
          resolve(String(msg.result?.result?.value ?? ''));
        }
      });
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('CDP WebSocket error'));
      });
    });
  }

  /** best-effort: wait for the navigated page to finish loading so a later
   *  action measures the PAGE, not network timing. Never fails the act. */
  private async waitLoad(wsUrl: string, timeoutMs: number): Promise<void> {
    const expr = "new Promise(r => document.readyState === 'complete' ? r('ok') : addEventListener('load', () => r('ok')))";
    await this.evaluate(wsUrl, expr, Math.min(timeoutMs, 8_000), true).catch(() => undefined);
  }
}
