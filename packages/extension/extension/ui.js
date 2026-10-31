/**
 * hmharness bridge — popup/sidepanel UI (zero-build asset)
 *
 * Connection is AUTOMATIC (round 44): the background announces and gets a
 * token from a running bridge — there is nothing to pair or type. This
 * page only shows live status and offers a port override (custom bridge
 * port), reconnect, revoke, and a read-current-page self test. All
 * answers render as textContent (never innerHTML).
 */
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  // readiness marker: automation must not click before listeners exist —
  // a click on a listener-less button is a silent no-op
  document.body.dataset.hmhUi = 'ready';
  const $ = (id) => document.getElementById(id);
  const out = $('out');

  const show = (text) => { out.textContent = text || ''; };

  function send(msg) {
    return new Promise((resolve) => {
      try {
        api.runtime.sendMessage(msg, (r) => {
          void api.runtime.lastError; // silence "no receiver" on dead SW
          resolve(r ?? { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function render(st) {
    const dot = $('dot');
    const txt = $('status-txt');
    if (!st) { dot.className = 'dot'; txt.textContent = '后台无响应'; return; }
    if (!st.paired) { dot.className = 'dot off'; txt.textContent = '桥未运行或未授权 — 终端执行 hmh extension start 后自动连接(30s 内)'; }
    else if (st.attached) { dot.className = 'dot on'; txt.textContent = `已连接 hmh 桥 (127.0.0.1:${st.port}) · ${st.browser}`; }
    else { dot.className = 'dot pair'; txt.textContent = `已授权 · 连接中… (127.0.0.1:${st.port})`; }
  }

  async function refresh() {
    const st = await send({ type: 'hmh-status' });
    render(st);
    const portEl = $('port');
    if (portEl && st.port) portEl.value = String(st.port);
    return st;
  }

  $('setport')?.addEventListener('click', async () => {
    const port = Number($('port').value) || 7789;
    show('设置端口并重连中…');
    const r = await send({ type: 'hmh-setport', port });
    show(r.ok ? '已设置,自动连接中…' : `✗ ${r.error || '失败'}`);
    setTimeout(refresh, 900);
  });

  $('reconnect')?.addEventListener('click', async () => {
    await send({ type: 'hmh-connect' });
    show('重连已触发…');
    setTimeout(refresh, 800);
  });

  $('unpair')?.addEventListener('click', async () => {
    await send({ type: 'hmh-disconnect' });
    show('已断开并取消本浏览器的授权(重新连接自动恢复)');
    setTimeout(refresh, 400);
  });

  $('read')?.addEventListener('click', async () => {
    show('读取当前页…');
    const r = await send({ type: 'hmh-read-current' });
    show(r.ok
      ? `✓ ${r.title}\n${r.url}\n\n${r.preview}`
      : `✗ ${r.error}\n（受保护页面无法注入;Firefox 需在扩展设置里授予主机权限）`);
  });

  // side panel opener — Chrome has sidePanel.open, Firefox sidebarAction.open
  const openBtn = $('open-panel');
  if (openBtn) {
    const hasSidebarApi = (api.sidePanel && typeof api.sidePanel.open === 'function') || (api.sidebarAction && typeof api.sidebarAction.open === 'function');
    // show the button whenever we can open a real sidebar OR can open the chat
    // as a tab (the tab fallback works EVERYWHERE — Firefox's
    // sidebarAction.open() silently fails from an onboarding tab)
    if (hasSidebarApi || api.tabs?.create) openBtn.hidden = false;
    openBtn.addEventListener('click', async () => {
      try {
        if (api.sidePanel && typeof api.sidePanel.open === 'function') { await api.sidePanel.open({}); return; }
        if (api.sidebarAction && typeof api.sidebarAction.open === 'function') { await api.sidebarAction.open(); return; }
      } catch (e) { /* sidebar refused — fall through to the tab */ }
      try { api.tabs.create({ url: api.runtime.getURL('sidepanel.html') }); } catch (e) { /* last resort */ }
    });
  }

  // — chat (sidepanel only; every element is guarded so the popup is unaffected) —
  const chatEl = $('chat');
  const chatInput = $('chat-input');
  const chatSend = $('chat-send');
  const chatReset = $('chat-reset');
  let chatBusy = false;
  let chatMsgs = [];

  function renderChat() {
    if (!chatEl) return;
    const hero = document.getElementById('hero');
    if (hero) hero.style.display = chatMsgs.length ? 'none' : '';
    for (const el of [...chatEl.querySelectorAll('.msg')]) el.remove();
    for (const m of chatMsgs) {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot');
      const who = document.createElement('b');
      who.textContent = m.role === 'user' ? '我' : 'hmh';
      const span = document.createElement('span');
      span.textContent = m.text;
      div.append(who, span);
      chatEl.append(div);
    }
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function think(on, label, stopBtn) {
    let t = chatEl?.querySelector('.thinking');
    if (!chatEl) return;
    if (on && !t) {
      t = document.createElement('div');
      t.className = 'msg bot thinking';
      t.style.whiteSpace = 'pre-wrap';
      chatEl.append(t);
    }
    if (on && t) {
      t.textContent = '';
      t.append(document.createTextNode(label || '正在思考…'));
      if (stopBtn) {
        stopBtn.style.marginTop = '6px';
        t.append(document.createElement('br'), stopBtn);
      }
    } else if (!on && t) t.remove();
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function push(role, text) {
    chatMsgs.push({ role, text });
    if (chatMsgs.length > 40) chatMsgs.splice(0, chatMsgs.length - 40);
    renderChat();
    try { void api.storage.session.set({ hmhChat: chatMsgs.slice(-20) }); } catch (e) { /* session storage refused */ }
  }

  // current-page context: the sidepanel belongs to a window — its active tab
  // IS the page the user is looking at. Sent with every chat message.
  async function currentPage() {
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const t = tabs && tabs[0];
      if (!t || !t.url) return undefined;
      return { url: String(t.url).slice(0, 500), title: String(t.title ?? '').slice(0, 300) };
    } catch (e) { return undefined; }
  }

  if (chatEl && chatInput && chatSend) {
    (async () => {
      try {
        const { hmhChat } = await api.storage.session.get('hmhChat');
        if (Array.isArray(hmhChat)) chatMsgs = hmhChat;
      } catch (e) { /* first run */ }
      renderChat();
    })();

    // AUTONOMOUS CONTINUATION: when the brain exhausts a request's round
    // budget mid-task it ends with this sentinel — strip it, show progress,
    // auto-send 「继续」. The user hands over a task; the panel chains
    // segments until the work is DONE. Never fires on confirmation asks
    // (those need the human).
    const CONT = '[[hmh:auto-continue]]';
    let autoChains = 0;
    const autoSend = (label) => { setTimeout(() => { autoChains++; void sendChat('继续', true); }, 900); return label; };

    async function sendChat(forcedText, isAuto) {
      if (chatBusy) return;
      const text = String(forcedText ?? chatInput.value).trim();
      if (!text) return;
      if (!isAuto) { chatInput.value = ''; autoChains = 0; }
      push(isAuto ? 'bot' : 'user', isAuto ? '(自动继续…)' : text);
      chatBusy = true;
      chatSend.disabled = true;
      const t0 = Date.now();
      // LIVE activity (round 50): while the brain works, poll its step feed
      // and render into the thinking bubble — no more silent 1000s waits.
      // STOP aborts OUR fetch; the server finishes its turn in the background
      // (history keeps the result), the panel is free immediately.
      let abort = null;
      let lastLines = '';
      const stopBtn = document.createElement('button');
      stopBtn.textContent = '停止';
      stopBtn.className = 'stop-btn';
      stopBtn.onclick = () => { autoChains = 0; if (abort) abort.abort(); };
      const tick = setInterval(async () => {
        if (!chatBusy) return;
        const secs = Math.round((Date.now() - t0) / 1000);
        let feed = '';
        try {
          const st = await send({ type: 'hmh-status' });
          const { token } = await api.storage.local.get('token');
          if (token) {
            const r = await fetch(`http://127.0.0.1:${st.port || 7789}/v1/chat/activity`, { headers: { authorization: 'Bearer ' + token } });
            const j = await r.json().catch(() => ({}));
            if (j.ok && Array.isArray(j.lines)) feed = j.lines.slice(-4).map((l) => ' · ' + l).join('\n');
          }
        } catch (e) { feed = ' · (活动流无响应——桥可能重启中)'; }
        if (feed !== lastLines) { lastLines = feed; }
        think(true, `正在执行… ${secs}s\n${feed}`, stopBtn);
      }, 2500);
      think(true, '正在执行… 0s', stopBtn);
      try {
        const st = await send({ type: 'hmh-status' });
        const { token } = await api.storage.local.get('token');
        if (!token) {
          push('bot', '尚未连接桥 — 终端执行 hmh extension start 后再试(30 秒内自动连上)。');
        } else {
          abort = new AbortController();
          const bail = setTimeout(() => { try { abort.abort(); } catch (e) { /* already gone */ } }, 420_000);
          let r;
          try {
            r = await fetch(`http://127.0.0.1:${st.port || 7789}/v1/chat`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
              body: JSON.stringify({ message: text, page: await currentPage() }),
              signal: abort.signal,
            });
          } finally { clearTimeout(bail); }
          const j = await r.json().catch(() => ({}));
          if (j.ok) {
            let reply = String(j.reply);
            if (reply.includes(CONT) && autoChains < 20) {
              reply = reply.split(CONT)[0].trim() + '\n(任务继续中,无需操作…)';
              push('bot', reply);
              autoSend();
            } else {
              if (reply.includes(CONT)) reply = reply.split(CONT)[0].trim() + '\n(连续接力已达上限 — 回复「继续」手动接续。)';
              push('bot', reply);
              autoChains = 0;
            }
          } else {
            push('bot', `✗ ${j.error || 'HTTP ' + r.status}`);
            autoChains = 0;
          }
        }
      } catch (e) {
        if (String(e).includes('abort') || (e && e.name === 'AbortError')) {
          push('bot', (Date.now() - t0 > 415_000) ? '(等待超时(7 分钟)——这一段可能仍在后台;重新发一次你的要求即可,对话记忆都在。)' : '(已停止等待——后台仍会完成这一段,结果已进对话记忆;可继续对话。)');
        } else {
          push('bot', '桥无响应 — 终端执行 hmh extension start(后台常驻)后再试。');
        }
        autoChains = 0;
      }
      chatBusy = false;
      chatSend.disabled = false;
      clearInterval(tick);
      think(false);
      if (!isAuto) chatInput.focus();
    }

    chatSend.addEventListener('click', () => { void sendChat(); });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void sendChat(); }
    });

    // minimal-UI extras (round 61): suggestion chips send their text;
    // ⚙ toggles the settings drawer (status/port/reconnect live there)
    for (const c of document.querySelectorAll('.chip')) {
      c.addEventListener('click', () => { chatInput.value = c.textContent.trim(); void sendChat(); });
    }
    $('settings-btn')?.addEventListener('click', () => {
      const panel = $('settings');
      if (panel) panel.hidden = !panel.hidden;
    });

    chatReset?.addEventListener('click', async () => {
      chatMsgs = [];
      renderChat();
      try {
        const { token } = await api.storage.local.get('token');
        if (token) {
          const st = await send({ type: 'hmh-status' });
          await fetch(`http://127.0.0.1:${st.port || 7789}/v1/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify({ reset: true }),
          }).catch(() => undefined);
        }
      } catch (e) { /* local reset already done */ }
      push('bot', '已清空对话。');
    });
  }

  refresh();
  setInterval(refresh, 2000);
})();
