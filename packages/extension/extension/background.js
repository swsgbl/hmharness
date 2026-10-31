/**
 * hmharness bridge — background script (zero-build asset)
 *
 * One file, every mainstream browser: Chrome/Edge/Brave load it as an MV3
 * service worker, Firefox loads the same file as an MV3 (non-persistent)
 * event page script, Safari wraps it after safari-web-extension-converter.
 * All API access goes through `api` (Firefox's `browser` first, Chrome's
 * `chrome` second) using only promise-shaped calls both engines support.
 *
 * Transport = the bridge's SSE downlink read as a FETCH STREAM (service
 * workers have no EventSource) + POST uplink. Reconnects with capped
 * backoff; all state (bridge port, bearer token) lives in storage.local
 * so a killed-and-revived background context resumes exactly where it
 * was. The wire carries STRUCTURED commands only — this file never
 * eval()s anything the bridge sends.
 */
(() => {
  'use strict';
  try {
  const api = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_PORT = 7789;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 30000;

  /** @type {{port?: number, token?: string}} persisted bridge binding */
  let binding = {};
  let stream = null;          // active AbortController while attached
  let reconnectTimer = null;
  let backoff = RECONNECT_MIN_MS;
  let tabPushTimer = null;

  const baseUrl = () => `http://127.0.0.1:${binding.port || DEFAULT_PORT}`;

  // ------------------------------------------------------------ persistence

  async function loadBinding() {
    try {
      if (!api.storage?.local?.get) { dbg('storage API UNAVAILABLE'); binding = { tokenMemOnly: true }; return binding; }
      const got = await api.storage.local.get(['port', 'token']);
      binding = { port: got.port, token: got.token };
    } catch (e) { dbg('load ERR ' + e); binding = {}; }
    return binding;
  }
  async function saveBinding() {
    // RACE, not await (round 59): a hung storage.set froze the SW between
    // announce and attach (field: announce every 30s, attach never) — the
    // in-memory token is enough to attach; persistence catches up or not.
    let write;
    try {
      write = api.storage.local.set({ port: binding.port, token: binding.token })
        .then(() => dbg('save ok token=' + (binding.token ? binding.token.slice(0, 8) : 'none')))
        .catch((e) => dbg('save ERR ' + e));
    } catch (e) { dbg('set SYNC-THROW ' + e); return; }
    const timer = new Promise((r) => setTimeout(() => { dbg('save HUNG — proceeding with in-memory token'); r(); }, 3000));
    await Promise.race([write, timer]);
  }

  // ------------------------------------------------------------------ badge

  function badge(state) {
    const map = {
      off:    { text: '',   color: '#9aa0a6' },
      unpaired: { text: '·', color: '#fbbc04' },
      on:     { text: '●', color: '#34a853' },
      error:  { text: '!', color: '#ea4335' },
    };
    const s = map[state] ?? map.off;
    try {
      api.action.setBadgeText({ text: s.text });
      api.action.setBadgeBackgroundColor({ color: s.color });
    } catch (e) { /* badge is cosmetic */ }
  }

  // -------------------------------------------------------------- transport

  async function uplink(msg) {
    if (!binding.token) throw new Error('尚未配对（在 popup 中输入 hmh extension pair 生成的配对码）');
    const r = await fetch(baseUrl() + '/v1/uplink', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + binding.token },
      body: JSON.stringify(msg),
    });
    if (r.status === 401) {
      // token revoked server-side: drop it and SELF-HEAL via auto-pair
      // (the throw alone used to strand the worker unpaired until the
      // 30s alarm — which never fires on some suspended workers)
      binding.token = undefined;
      await saveBinding();
      badge('unpaired');
      void announceAndAutoPair();
      throw new Error('令牌已被服务端吊销 — 已自动重新配对');
    }
    if (!r.ok) throw new Error('uplink HTTP ' + r.status);
  }

  async function hello() {
    await uplink({
      kind: 'hello',
      protocol: 'hmext/1',
      extVersion: api.runtime.getManifest().version,
      browser: detectBrowser(),
      extBaseUrl: api.runtime.getURL(''),
      userAgent: navigator.userAgent,
    });
  }

  /** AUTO-PAIR (round 43/44): announce once — an unpaired bridge mints a
   *  token right in the response (extension-origin announce is the only
   *  onboarding path; pairing codes were removed). Bridge not running →
   *  stay unpaired; the 30s alarm retries, so the moment the user starts
   *  `hmh extension serve` the extension connects without a restart. */
  async function announceAndAutoPair() {
    if (binding.token) { void attach(); return; }
    dbg('announcing…');
    try {
      const j = await (await fetch(baseUrl() + '/v1/announce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extBaseUrl: api.runtime.getURL(''), browser: detectBrowser(), extVersion: api.runtime.getManifest().version }),
      })).json();
      if (j.token) {
        binding.token = j.token;
        await saveBinding();
        try {
          const rb = await api.storage.local.get(['token', 'port']);
          dbg('save readback: token=' + (rb.token ? rb.token.slice(0, 8) : 'MISSING') + ' port=' + (rb.port ?? 'MISSING'));
        } catch (e2) { dbg('save readback ERR ' + e2); }
        badge('on');
        dbg('granted token=' + j.token.slice(0, 8) + ' attaching');
        void attach();
        return;
      }
      dbg('announce NO grant: ' + JSON.stringify(j).slice(0, 120));
      badge('unpaired'); // bridge reachable but did not grant (non-extension origin should not happen here)
    } catch (e) {
      dbg('announce ERR ' + e);
      badge('unpaired'); // bridge not running — alarm retries
    }
  }

  function detectBrowser() {
    const u = navigator.userAgent;
    if (/firefox/i.test(u)) return 'firefox';
    if (/safari/i.test(u) && !/chrome|chromium/i.test(u)) return 'safari';
    if (/edg\//i.test(u)) return 'edge';
    if (/brave/i.test(u)) return 'brave';
    return 'chromium';
  }

  /** Attach the SSE downlink as a fetch stream; dispatch commands. */
  async function attach() {
    if (!binding.token) { dbg('attach skip: no token'); badge('unpaired'); return; }
    dbg('attach start token=' + binding.token.slice(0, 8));
    if (stream) stream.abort();
    const ac = new AbortController();
    stream = ac;
    badge('error'); // pessimistic until the stream proves alive
    let lastBlockAt = Date.now();
    let watchdog = null;
    try {
      const res = await fetch(baseUrl() + '/v1/events', {
        headers: { authorization: 'Bearer ' + binding.token },
        signal: ac.signal,
        cache: 'no-store',
      });
      if (res.status === 401) {
        // STALE TOKEN SELF-HEAL (round 45, forensics-proven): clear it and
        // go straight to auto-pair — announce mints a fresh token and
        // re-attaches. scheduleReconnect here was a DEAD END (attach with
        // no token returns immediately; recovery then depended on the 30s
        // alarm, which never fires on some engines' suspended workers).
        dbg('attach 401 — self-heal');
        binding.token = undefined;
        await saveBinding();
        badge('unpaired');
        void announceAndAutoPair();
        return;
      }
      if (!res.ok || !res.body) throw new Error('events HTTP ' + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      await hello();
      badge('on');
      backoff = RECONNECT_MIN_MS; // a proven attach resets the backoff

      // dead-stream watchdog: the bridge heartbeats every 5s — silence for
      // 40s means this stream is a ghost (MV3 workers can be killed and
      // respawned onto a NEW stream while the browser keeps the old socket
      // half-open). Abandon it and reconnect instead of listening to
      // nothing forever.
      watchdog = setInterval(() => {
        if (Date.now() - lastBlockAt > 40_000) {
          clearInterval(watchdog);
          if (stream === ac) { ac.abort(); }
        }
      }, 5_000);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastBlockAt = Date.now();
        if (stream !== ac) { clearInterval(watchdog); return; } // superseded
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleSseBlock(block);
        }
      }
      if (watchdog) clearInterval(watchdog);
    } catch (e) {
      dbg('attach ERR ' + ((e && e.name) || '?') + ' ' + String((e && e.message) || '').slice(0, 100));
      if (watchdog) clearInterval(watchdog);
      if (stream !== ac) return;
    }
    if (stream === ac) {
      stream = null;
      badge('error');
      scheduleReconnect();
    }
  }

  /** Parse one SSE block: `event:` line + `data:` line (single-line data). */
  function handleSseBlock(block) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (!data) return; // keepalive comment / retry hint
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (event === 'command' && msg && msg.kind) {
      dispatchCommand(msg);
    } else if (event === 'fatal') {
      badge('error');
      // protocol mismatch etc. — stop hammering the server
      if (stream) { stream.abort(); stream = null; }
    }
    // 'hello' ack and 'ping' heartbeats need no action
  }

  // At-least-once command delivery (round 40): the bridge replays
  // read-only commands when a fresh stream attaches, because the stream
  // a command was written to can die with its MV3 worker. Dedupe by id:
  // a duplicate replays the CACHED result (same worker — the answer was
  // lost with the dead stream) or re-executes (fresh worker — read-only
  // commands are idempotent; page.act is never replayed by the bridge).
  const handled = new Map(); // id -> uplink payload (bounded below)
  function dispatchCommand(cmd) {
    if (handled.has(cmd.id)) {
      const cached = handled.get(cmd.id);
      if (cached) void reply(cmd.id, cached.ok, cached.ok ? cached.data : cached.error);
      return;
    }
    void runCommand(cmd).then(
      (out) => { remember(cmd.id, { ok: true, data: out }); reply(cmd.id, true, out); },
      (err) => { const e = String(err && err.message ? err.message : err); remember(cmd.id, { ok: false, error: e }); reply(cmd.id, false, e); },
    );
  }
  function remember(id, payload) {
    handled.set(id, payload);
    if (handled.size > 100) {
      const first = handled.keys().next().value;
      handled.delete(first);
    }
  }

  async function reply(id, ok, payload) {
    try {
      await uplink({ kind: 'result', id, ok, ...(ok ? { data: payload } : { error: payload }) });
    } catch (e) { /* bridge gone mid-command; command times out server-side */ }
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attach();
    }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }

  // ------------------------------------------------------------- commands

  async function activeTabId(explicit) {
    if (Number.isInteger(explicit)) return explicit;
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) throw new Error('没有活动标签页');
    return tabs[0].id;
  }

  async function runCommand(cmd) {
    if (cmd.kind === 'ping') return { pong: true, at: Date.now() };
    if (cmd.kind === 'tabs.list') {
      const tabs = await api.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, index: t.index, title: String(t.title || '').slice(0, 200),
        url: String(t.url || ''), active: Boolean(t.active), windowId: t.windowId,
      }));
    }
    if (cmd.kind === 'page.read') {
      const tabId = await activeTabId(cmd.tabId);
      const r = await api.scripting.executeScript({ target: { tabId }, func: collectPageData });
      const out = r && r[0] && r[0].result;
      if (!out) throw new Error('页面读取无结果（受保护页面或需要授权）');
      return out;
    }
    if (cmd.kind === 'page.goto') {
      // navigate the tab — http/https only, never script-ish schemes
      const url = String(cmd.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('page.goto 只允许 http/https 地址');
      const tabId = await activeTabId(cmd.tabId);
      await api.tabs.update(tabId, { url });
      return { ok: true, navigating: url };
    }
    if (cmd.kind === 'page.act') {
      if (!cmd.act || !cmd.act.action) throw new Error('page.act 缺少 action');
      const tabId = await activeTabId(cmd.tabId);
      const r = await api.scripting.executeScript({
        target: { tabId }, func: actInPage, args: [cmd.act],
      });
      const out = r && r[0] && r[0].result;
      if (!out) throw new Error('页面操作无结果（受保护页面或需要授权）');
      if (out.ok === false) throw new Error(String(out.error));
      return out;
    }
    throw new Error('未知命令: ' + cmd.kind);
  }

  // The two functions below are injected into pages via
  // scripting.executeScript({func}) — they are serialized with toString(),
  // so they MUST stay fully self-contained (no closure over this file).

  function collectPageData() {
    const clip = (s, n) => {
      s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) : s;
    };
    const headings = [];
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const t = clip(h.textContent, 160);
      if (t) headings.push({ level: Number(h.tagName.slice(1)), text: t });
      if (headings.length >= 120) break;
    }
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (links.length >= 150) break;
      const t = clip(a.textContent, 80);
      if (!t) continue;
      let href = '';
      try { href = a.href; } catch (e) { /* odd href */ }
      if (href) links.push({ text: t, href: clip(href, 300) });
    }
    const inputs = [];
    for (const el of document.querySelectorAll('input,textarea,select')) {
      if (inputs.length >= 60) break;
      const type = String(el.getAttribute('type') || el.tagName.toLowerCase());
      if (type === 'hidden') continue;
      inputs.push({
        tag: el.tagName.toLowerCase(), type,
        name: clip(el.getAttribute('name'), 80),
        placeholder: clip(el.getAttribute('placeholder'), 80),
      });
    }
    let selection = '';
    try { selection = clip(String(window.getSelection && window.getSelection()), 800); } catch (e) { /* */ }
    return {
      url: String(location.href).slice(0, 2000),
      title: clip(document.title, 300),
      selection,
      headings, links, inputs,
      text: clip(document.body ? document.body.innerText : '', 12000),
    };
  }

  function actInPage(act) {
    try {
      if (act.action === 'scroll') {
        const step = 600;
        if (act.direction === 'top') window.scrollTo(0, 0);
        else if (act.direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
        else window.scrollBy(0, act.direction === 'up' ? -step : step);
        return { ok: true, detail: 'scrolled ' + (act.direction || 'down') };
      }
      const el = document.querySelector(act.selector || '');
      if (!el) return { ok: false, error: 'selector 未命中: ' + act.selector };
      el.scrollIntoView({ block: 'center' });
      if (act.action === 'click') { el.click(); return { ok: true, detail: 'clicked ' + act.selector }; }
      if (act.action === 'select') {
        if (!('value' in el)) return { ok: false, error: '元素没有 value 可选' };
        el.value = String(act.text == null ? '' : act.text);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'selected ' + act.selector };
      }
      if (act.action === 'type') {
        const text = String(act.text == null ? '' : act.text);
        let proto = null;
        if (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
        else if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
        if (proto) {
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, text); // native setter — React/Vue compatible
        } else {
          el.textContent = text; // contenteditable fallback
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'typed into ' + act.selector };
      }
      return { ok: false, error: '未知 action: ' + act.action };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // ------------------------------------------------------------ tab pushes

  function pushTabsSoon() {
    if (tabPushTimer) return;
    tabPushTimer = setTimeout(async () => {
      tabPushTimer = null;
      if (!binding.token || !stream) return;
      try {
        const tabs = await api.tabs.query({});
        await uplink({
          kind: 'tabs.push',
          tabs: tabs.map((t) => ({
            id: t.id, index: t.index, title: String(t.title || '').slice(0, 200),
            url: String(t.url || ''), active: Boolean(t.active), windowId: t.windowId,
          })),
        });
      } catch (e) { /* best-effort snapshot */ }
    }, 1000);
  }

  // ------------------------------------------------------- popup messaging

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg && msg.type === 'hmh-status') {
        return {
          port: binding.port || DEFAULT_PORT,
          paired: Boolean(binding.token),
          attached: Boolean(stream),
          browser: detectBrowser(),
        };
      }
      if (msg && msg.type === 'hmh-setport') {
        // custom bridge port (default 7789); re-announce immediately —
        // auto-pair works against any port the bridge runs on
        binding.port = Number(msg.port) || DEFAULT_PORT;
        await saveBinding();
        void announceAndAutoPair();
        return { ok: true };
      }
      if (msg && msg.type === 'hmh-connect') {
        await loadBinding();
        if (binding.token) void attach();
        else void announceAndAutoPair();
        return { ok: true };
      }
      if (msg && msg.type === 'hmh-disconnect') {
        binding.token = undefined;
        await saveBinding();
        if (stream) { stream.abort(); stream = null; }
        badge('unpaired');
        try { await uplinkDisconnected(); } catch (e) { /* */ }
        return { ok: true };
      }
      if (msg && msg.type === 'hmh-read-current') {
        try {
          const out = await runCommand({ kind: 'page.read' });
          return { ok: true, title: out.title, url: out.url, preview: String(out.text || '').slice(0, 400) };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      }
      return { ok: false, error: '未知消息' };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // async sendResponse (Chrome contract; Firefox honors it too)
  });

  /** best-effort bye on manual disconnect (token already cleared — fire-and-forget with the old token value is impossible, so the bridge simply sees the SSE close) */
  async function uplinkDisconnected() { /* the SSE 'close' event IS the bye */ }

  // TEMPORARY round-45 forensics: beam SW-side step markers to the bridge's
  // /v1/dbg route (no token mint side effects). Remove after the real-profile
  // attach mystery is closed.
  function dbg(step, extra) {
    try {
      void fetch(baseUrl() + '/v1/dbg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step, extra: String(extra ?? ''), at: Date.now() }),
      }).catch(() => undefined);
    } catch (e) { /* beacon is best-effort */ }
  }

  // ------------------------------------------------------------- lifecycle

  api.runtime.onStartup.addListener(() => { void loadBinding().then(() => attach()); });
  api.runtime.onInstalled.addListener((details) => {
    void loadBinding().then(() => {
      // pairing onboarding (round 41): a FRESH install that isn't paired
      // yet opens its own pairing page — the user sees exactly what to do
      // next, and automation gets a reachable tab (Firefox refuses
      // WebDriver navigation to moz-extension:// URLs, so the extension
      // opening the page itself is the only cross-browser path)
      if (details && details.reason === 'install' && !binding.token) {
        // open the CHAT PANEL as the onboarding tab — it has the input box and
        // works in every browser (popup.html is status-only, no conversation)
        try { void api.tabs.create({ url: api.runtime.getURL('sidepanel.html') }); } catch (e) { /* no tabs API (Safari?) */ }
      }
      void attach();
    });
  });
  // service-worker revival safety net: a 30s alarm (Chrome 120+ floor;
  // engines that reject sub-minute periods fall back to 1min) re-attaches
  // the stream whenever Chrome has killed and respawned the worker mid-idle
  try {
    api.alarms.create('hmh-keepalive', { periodInMinutes: 0.5 });
  } catch (e) {
    try { api.alarms.create('hmh-keepalive', { periodInMinutes: 1 }); } catch (e2) { /* no alarms at all */ }
  }
  try {
    api.alarms.onAlarm.addListener(() => {
      // revival + retry net: re-attach a dropped stream, or re-announce
      // when still unpaired (covers "bridge started AFTER the browser")
      if (!stream) void loadBinding().then(() => (binding.token ? attach() : announceAndAutoPair()));
      else pushTabsSoon();
    });
  } catch (e) { /* alarms unavailable (Safari) — fetch-stream keepalive + watchdog still hold */ }

  for (const ev of ['onUpdated', 'onActivated', 'onRemoved']) {
    try { api.tabs[ev].addListener(() => pushTabsSoon()); } catch (e) { /* */ }
  }

  // ONE-CLICK SIDEPANEL (round 47, the ChatGPT-extension UX): the toolbar
  // icon opens the chat side panel DIRECTLY — no status popup in between.
  // Chromium only; Firefox reaches the sidebar via the popup's button
  // (sidebarAction.open) and Safari stays popup-only.
  try {
    if (api.sidePanel && typeof api.sidePanel.setPanelBehavior === 'function') {
      void api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    }
  } catch (e) { /* panel behavior is a convenience, never fatal */ }

  // first load of this context (worker start or event page load)
  dbg('worker boot v' + api.runtime.getManifest().version);
  void loadBinding().then(() => { dbg('boot token=' + (binding.token ? binding.token.slice(0, 8) : 'none') + ' port=' + (binding.port ?? 'def')); if (binding.token) void attach(); else void announceAndAutoPair(); });

  } catch (bootErr) {
    // a sync throw mid-IIFE killed every listener after it — announce the
    // error via the one channel that works (the alarm handler registered
    // before the throw still fires; this catch keeps SW alive regardless)
    try {
      void fetch((globalThis.__hmhBaseUrl || 'http://127.0.0.1:7789') + '/v1/dbg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'IIFE BOOT THROW', extra: String(bootErr && bootErr.stack || bootErr).slice(0, 400), at: Date.now() }),
      }).catch(() => undefined);
    } catch { /* even the beacon failed */ }
  }
})();
