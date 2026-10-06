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
  if (openBtn && api.sidePanel && typeof api.sidePanel.open === 'function') {
    openBtn.hidden = false;
    openBtn.addEventListener('click', () => api.sidePanel.open({}).catch(() => undefined));
  } else if (openBtn && api.sidebarAction && typeof api.sidebarAction.open === 'function') {
    openBtn.hidden = false;
    openBtn.addEventListener('click', () => api.sidebarAction.open().catch(() => undefined));
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

  function think(on) {
    let t = chatEl?.querySelector('.thinking');
    if (!chatEl) return;
    if (on && !t) {
      t = document.createElement('div');
      t.className = 'msg bot thinking';
      t.textContent = '正在思考…';
      chatEl.append(t);
    } else if (!on && t) t.remove();
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function push(role, text) {
    chatMsgs.push({ role, text });
    if (chatMsgs.length > 40) chatMsgs.splice(0, chatMsgs.length - 40);
    renderChat();
    try { void api.storage.session.set({ hmhChat: chatMsgs.slice(-20) }); } catch (e) { /* session storage refused */ }
  }

  if (chatEl && chatInput && chatSend) {
    (async () => {
      try {
        const { hmhChat } = await api.storage.session.get('hmhChat');
        if (Array.isArray(hmhChat)) chatMsgs = hmhChat;
      } catch (e) { /* first run */ }
      renderChat();
      if (!chatMsgs.length) push('bot', '已就绪。可以问我当前页面的事(我会先读取页面),或让我帮你点击/输入/滚动。');
    })();

    async function sendChat() {
      if (chatBusy) return;
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      push('user', text);
      chatBusy = true;
      chatSend.disabled = true;
      think(true);
      try {
        const st = await send({ type: 'hmh-status' });
        const { token } = await api.storage.local.get('token');
        if (!token) {
          push('bot', '尚未连接桥 — 终端执行 hmh extension start 后再试(30 秒内自动连上)。');
        } else {
          const r = await fetch(`http://127.0.0.1:${st.port || 7789}/v1/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify({ message: text }),
          });
          const j = await r.json().catch(() => ({}));
          push('bot', j.ok ? String(j.reply) : `✗ ${j.error || 'HTTP ' + r.status}`);
        }
      } catch (e) {
        push('bot', '桥无响应 — 终端执行 hmh extension start(后台常驻)后再试。');
      }
      chatBusy = false;
      chatSend.disabled = false;
      think(false);
      chatInput.focus();
    }

    chatSend.addEventListener('click', () => { void sendChat(); });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void sendChat(); }
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
