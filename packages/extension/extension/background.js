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
      const got = await api.storage.local.get(['port', 'token']);
      binding = { port: got.port, token: got.token };
    } catch (e) { binding = {}; }
    return binding;
  }
  async function saveBinding() {
    try { await api.storage.local.set({ port: binding.port, token: binding.token }); } catch (e) { /* storage refused — session-only */ }
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
      // token revoked server-side: drop it, honest re-pair needed
      binding.token = undefined;
      await saveBinding();
      badge('unpaired');
      throw new Error('令牌已被服务端吊销 — 重新配对');
    }
    if (!r.ok) throw new Error('uplink HTTP ' + r.status);
  }

  async function hello() {
    await uplink({
      kind: 'hello',
      protocol: 'hmext/1',
      extVersion: api.runtime.getManifest().version,
      browser: detectBrowser(),
      userAgent: navigator.userAgent,
    });
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
    if (!binding.token) { badge('unpaired'); return; }
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
        binding.token = undefined;
        await saveBinding();
        badge('unpaired');
        scheduleReconnect();
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
      void runCommand(msg).then(
        (out) => reply(msg.id, true, out),
        (err) => reply(msg.id, false, String(err && err.message ? err.message : err)),
      );
    } else if (event === 'fatal') {
      badge('error');
      // protocol mismatch etc. — stop hammering the server
      if (stream) { stream.abort(); stream = null; }
    }
    // 'hello' ack and 'ping' heartbeats need no action
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
      if (msg && msg.type === 'hmh-pair') {
        const port = Number(msg.port) || DEFAULT_PORT;
        binding.port = port;
        // redeem the one-time code against the bridge
        const r = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: String(msg.code || '').trim().toUpperCase() }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return { ok: false, error: j.error || ('配对失败 HTTP ' + r.status) };
        binding.token = j.token;
        await saveBinding();
        void attach();
        return { ok: true };
      }
      if (msg && msg.type === 'hmh-connect') {
        await loadBinding();
        void attach();
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

  // ------------------------------------------------------------- lifecycle

  api.runtime.onStartup.addListener(() => { void loadBinding().then(() => attach()); });
  api.runtime.onInstalled.addListener(() => { void loadBinding().then(() => attach()); });
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
      if (!stream) void loadBinding().then(() => attach());
      else pushTabsSoon();
    });
  } catch (e) { /* alarms unavailable (Safari) — fetch-stream keepalive + watchdog still hold */ }

  for (const ev of ['onUpdated', 'onActivated', 'onRemoved']) {
    try { api.tabs[ev].addListener(() => pushTabsSoon()); } catch (e) { /* */ }
  }

  // first load of this context (worker start or event page load)
  void loadBinding().then(() => { if (binding.token) void attach(); else badge('unpaired'); });
})();
