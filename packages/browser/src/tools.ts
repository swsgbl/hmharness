/**
 * @hmharness/browser - agent tools (the browser_* family)
 *
 * Drives the OWNED BrowserOS instance: navigate → snapshot (refs) →
 * click/type → verify, plus read/screenshot/scroll/tabs. The instance is
 * auto-started on first use (dedicated profile, loopback CDP; the user's
 * daily browser is never touched) and survives the agent — the user can
 * watch the window and log in when a site demands it.
 *
 * Workflow hint baked into descriptions: browser_snapshot BEFORE acting,
 * browser_screenshot + see_image when layout/visual state matters.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@hmharness/kernel';
import { loadConfig } from '@hmharness/kernel';
import { CdpBrowser } from './cdp.ts';
import { clientForInstance } from './lifecycle.ts';
import { SNAPSHOT_EXPR, READ_EXPR, clickExpr, typeExpr, scrollExpr, parseSnapshot, parseRead, formatSnapshot } from './page.ts';

export interface BrowserToolContext {
  workspaceRoot: string;
  /** HMH_HOME — required by the source-trust guard; when absent the
   *  browser refuses to launch (honest failure, no silent skip) */
  home?: string;
}

let live: { client: CdpBrowser; targetId: string } | null = null;

/** Ensure a browser is driven and an active tab is pinned.
 *
 *  Two modes:
 *  - HOST ATTACH (HMH_BROWSER_ATTACH=<port>): when hmharness runs INSIDE a
 *    host browser (acp-serve under BrowserOS), browser_* drives the user's
 *    REAL tabs — their pages, their logins — over the host's managed CDP
 *    port. That is the entire point of an in-browser agent; a second
 *    browser window popping up instead is a bug, not safety.
 *  - OWNED instance (default): dedicated profile under HMH_HOME — the
 *    standalone-CLI safety design; the user's daily browser is never
 *    touched. */
async function ensure(ctx: BrowserToolContext): Promise<{ client: CdpBrowser; targetId: string }> {
  if (!live) {
    const attachPort = Number(process.env.HMH_BROWSER_ATTACH ?? 0);
    if (Number.isInteger(attachPort) && attachPort > 0) {
      const host = new CdpBrowser({ port: attachPort });
      if (await host.up()) {
        const tabs = (await host.tabs()).filter((t) => !t.url.startsWith('chrome-extension://'));
        const page = tabs.find((t) => !t.url.startsWith('about:')) ?? tabs[0];
        live = { client: host, targetId: page?.targetId ?? (await host.openTab('about:blank')) };
      } else {
        // we were told to drive the HOST browser and it is not reachable —
        // falling back to a dedicated instance would pop a second window
        // next to the one the user is talking from; refuse instead
        throw new Error(`host browser CDP port ${attachPort} unreachable (HMH_BROWSER_ATTACH set) — the host's managed debugging port is off`);
      }
    }
  }
  if (live && (await live.client.up())) {
    const tabs = await live.client.tabs();
    if (tabs.some((t) => t.targetId === live!.targetId)) return live;
    if (tabs.length > 0) {
      live.targetId = tabs[0].targetId;
      return live;
    }
    live.targetId = await live.client.openTab('about:blank');
    return live;
  }
  if (!ctx.home) {
    throw new Error('browser tools need HMH_HOME (source-trust guard) — set HMH_HOME or run via the hmh CLI');
  }
  const cfg = await loadConfig().catch(() => undefined);
  const { client } = await clientForInstance(ctx.home, {
    executablePath: cfg?.browser?.executablePath,
    port: cfg?.browser?.cdpPort,
    headless: cfg?.browser?.headless,
    implicit: true, // agent auto-start: a headless instance must not outlive its host
  });
  const tabs = await client.tabs();
  const targetId = tabs.length > 0 ? tabs[0].targetId : await client.openTab('about:blank');
  live = { client, targetId };
  return live;
}

const WRAP = (err: unknown): { output: string; isError: boolean } => ({
  output: String(err instanceof Error ? err.message : err).slice(0, 400),
  isError: true,
});

function httpUrl(u: string): string | null {
  const t = String(u ?? '').trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

function refArg(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : null;
}

export function browserTools(ctx: BrowserToolContext): Tool[] {
  return [
    {
      name: 'browser_navigate',
      description: 'Navigate the BrowserOS tab to an http(s) URL, wait for load. First use auto-starts a DEDICATED BrowserOS instance (own profile; the user\'s daily browser is untouched). After navigating, call browser_snapshot to see the interactive elements.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL' } }, required: ['url'] },
      async execute(args) {
        try {
          const url = httpUrl(String(args.url ?? ''));
          if (!url) return { output: 'only http(s) URLs', isError: true };
          const { client, targetId } = await ensure(ctx);
          await client.navigate(targetId, url);
          const tabs = await client.tabs();
          const tab = tabs.find((t) => t.targetId === targetId);
          return { output: `navigated: ${tab?.title || '(loading)'}\n${tab?.url || url}\nnext: browser_snapshot` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_snapshot',
      description: 'List the visible interactive elements of the current page with stable refs ([N] tag text). Click/type target these refs. Re-snapshot after any navigation or DOM change. For visual/layout questions use browser_screenshot + see_image instead.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const { client, targetId } = await ensure(ctx);
          const snap = parseSnapshot(await client.evaluate(targetId, SNAPSHOT_EXPR));
          return { output: formatSnapshot(snap) };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element by its browser_snapshot ref. After the click, re-snapshot (or browser_screenshot) to see the new state.',
      parameters: { type: 'object', properties: { ref: { type: 'number', description: 'element ref from browser_snapshot' } }, required: ['ref'] },
      async execute(args) {
        try {
          const ref = refArg(args.ref);
          if (!ref) return { output: 'ref must be an integer from browser_snapshot', isError: true };
          const { client, targetId } = await ensure(ctx);
          const r = await client.evaluate(targetId, clickExpr(ref));
          if (r === 'E_NO_REF') return { output: `ref ${ref} not on this page (stale after navigation/DOM change) — browser_snapshot again`, isError: true };
          return { output: `clicked [${ref}] — re-snapshot to see the result` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into an input/textarea/contenteditable by its browser_snapshot ref (native setter + input/change events — React/Vue compatible). submit=true presses submit (form.requestSubmit, else Enter).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'element ref from browser_snapshot' },
          text: { type: 'string', description: 'text to type (replaces current value)' },
          submit: { type: 'boolean', description: 'submit the form after typing (default false)' },
        },
        required: ['ref', 'text'],
      },
      async execute(args) {
        try {
          const ref = refArg(args.ref);
          if (!ref) return { output: 'ref must be an integer from browser_snapshot', isError: true };
          const text = String(args.text ?? '');
          const { client, targetId } = await ensure(ctx);
          const r = await client.evaluate(targetId, typeExpr(ref, text, Boolean(args.submit)));
          if (r === 'E_NO_REF') return { output: `ref ${ref} not on this page (stale after navigation/DOM change) — browser_snapshot again`, isError: true };
          return { output: `typed into [${ref}]${args.submit ? ' + submitted' : ''}` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_read',
      description: 'Read the current page as text (title, URL, visible innerText, capped ~12k chars). Prefer this over screenshot for content extraction; use browser_screenshot for layout/visual state.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const { client, targetId } = await ensure(ctx);
          const r = parseRead(await client.evaluate(targetId, READ_EXPR));
          return { output: `${r.title}\n${r.url}${r.truncated ? ' (text truncated)' : ''}\n\n${r.text}` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the current page: down | up | top | bottom (step ~600px). Snapshot again after scrolling — new elements become visible and get refs.',
      parameters: { type: 'object', properties: { direction: { type: 'string', description: 'down (default) | up | top | bottom' } } },
      async execute(args) {
        try {
          const { client, targetId } = await ensure(ctx);
          const r = await client.evaluate(targetId, scrollExpr(String(args.direction ?? 'down')));
          return { output: `scrolled (${String(r)}) — browser_snapshot again for newly visible elements` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Screenshot the current page to a PNG file; returns the path — then call see_image with it to actually look. Use when layout/visual state matters; for text content prefer browser_read.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const home = ctx.home;
          if (!home) return { output: 'screenshot needs HMH_HOME for file storage', isError: true };
          const { client, targetId } = await ensure(ctx);
          const png = await client.screenshot(targetId);
          const dir = join(home, 'screenshots');
          await mkdir(dir, { recursive: true });
          const file = join(dir, `browser-${Date.now()}.png`);
          await writeFile(file, png);
          return { output: `${file} — call see_image with this path to look at it` };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'browser_tabs',
      description: 'Manage tabs of the driven browser: list (default) | new [url] | activate <target_id> | close <target_id>. Navigate/click/type/read always act on the ACTIVE tab.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | new | activate | close' },
          target_id: { type: 'string', description: 'tab id (list/new output) for activate/close' },
          url: { type: 'string', description: 'opening URL for action=new' },
        },
      },
      async execute(args) {
        try {
          const action = String(args.action ?? 'list');
          const { client } = await ensure(ctx);
          if (action === 'list') {
            const tabs = await client.tabs();
            return { output: tabs.length + ' tab(s)\n' + tabs.map((t) => `  ${t.targetId}${t.targetId === live?.targetId ? ' *active*' : ''} ${t.title.slice(0, 60)} — ${t.url.slice(0, 100)}`).join('\n') };
          }
          if (action === 'new') {
            const url = args.url ? httpUrl(String(args.url)) ?? 'about:blank' : 'about:blank';
            const targetId = await client.openTab(url);
            if (live) live.targetId = targetId;
            await client.activateTab(targetId).catch(() => undefined);
            return { output: `new tab ${targetId} (now active): ${url}` };
          }
          const id = String(args.target_id ?? '');
          if (!id) return { output: `action ${action} needs target_id (see browser_tabs list)`, isError: true };
          if (action === 'activate') {
            await client.activateTab(id);
            if (live) live.targetId = id;
            return { output: `activated ${id}` };
          }
          if (action === 'close') {
            await client.closeTab(id);
            if (live?.targetId === id) {
              const tabs = await client.tabs();
              live.targetId = tabs[0]?.targetId ?? (await client.openTab('about:blank'));
            }
            return { output: `closed ${id}` };
          }
          return { output: `unknown action '${action}' (list | new | activate | close)`, isError: true };
        } catch (err) { return WRAP(err); }
      },
    },
  ];
}

/** Stop the driven instance + drop the live client (shutdown path). */
export async function shutdownBrowser(): Promise<void> {
  if (live) {
    await live.client.close().catch(() => undefined);
    live = null;
  }
}
