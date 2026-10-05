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
    if (!st.paired) { dot.className = 'dot off'; txt.textContent = '桥未运行或未授权 — 启动 hmh extension serve 后自动连接(30s 内)'; }
    else if (st.attached) { dot.className = 'dot on'; txt.textContent = `已连接 hmh 桥 (127.0.0.1:${st.port}) · ${st.browser}`; }
    else { dot.className = 'dot pair'; txt.textContent = `已授权 · 连接中… (127.0.0.1:${st.port})`; }
  }

  async function refresh() {
    const st = await send({ type: 'hmh-status' });
    render(st);
    if (st.port) $('port').value = String(st.port);
    return st;
  }

  $('setport').addEventListener('click', async () => {
    const port = Number($('port').value) || 7789;
    show('设置端口并重连中…');
    const r = await send({ type: 'hmh-setport', port });
    show(r.ok ? '已设置,自动连接中…' : `✗ ${r.error || '失败'}`);
    setTimeout(refresh, 900);
  });

  $('reconnect').addEventListener('click', async () => {
    await send({ type: 'hmh-connect' });
    show('重连已触发…');
    setTimeout(refresh, 800);
  });

  $('unpair').addEventListener('click', async () => {
    await send({ type: 'hmh-disconnect' });
    show('已断开并取消本浏览器的授权(重新连接自动恢复)');
    setTimeout(refresh, 400);
  });

  $('read').addEventListener('click', async () => {
    show('读取当前页…');
    const r = await send({ type: 'hmh-read-current' });
    show(r.ok
      ? `✓ ${r.title}\n${r.url}\n\n${r.preview}`
      : `✗ ${r.error}\n（受保护页面无法注入;Firefox 需在扩展设置里授予主机权限）`);
  });

  // side panel opener — Chrome has sidePanel.open, Firefox sidebarAction.open
  const openBtn = $('open-panel');
  if (api.sidePanel && typeof api.sidePanel.open === 'function') {
    openBtn.hidden = false;
    openBtn.addEventListener('click', () => api.sidePanel.open({}).catch(() => undefined));
  } else if (api.sidebarAction && typeof api.sidebarAction.open === 'function') {
    openBtn.hidden = false;
    openBtn.addEventListener('click', () => api.sidebarAction.open().catch(() => undefined));
  }

  refresh();
  setInterval(refresh, 2000);
})();
