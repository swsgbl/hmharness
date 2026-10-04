/**
 * hmharness bridge — popup/sidepanel UI (zero-build asset)
 *
 * One script for both surfaces (popup.html / sidepanel.html): all real
 * work lives in the background script; this page only sends runtime
 * messages and renders answers as textContent (never innerHTML — nothing
 * the bridge or a page could send is ever parsed as markup).
 */
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
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
    if (!st.paired) { dot.className = 'dot pair'; txt.textContent = '未配对 — 输入配对码'; }
    else if (st.attached) { dot.className = 'dot on'; txt.textContent = `已连接 hmh 桥 (127.0.0.1:${st.port}) · ${st.browser}`; }
    else { dot.className = 'dot off'; txt.textContent = `已配对 · 连接中… (127.0.0.1:${st.port})`; }
  }

  async function refresh() {
    const st = await send({ type: 'hmh-status' });
    render(st.ok === undefined ? st : st); // status payload has no ok flag
    if (st.port) $('port').value = String(st.port);
    return st;
  }

  $('pair').addEventListener('click', async () => {
    const code = $('code').value.trim();
    if (!code) { show('请先输入 hmh extension pair 生成的配对码'); return; }
    show('配对中…');
    const r = await send({ type: 'hmh-pair', code, port: Number($('port').value) || 7789 });
    show(r.ok ? '✓ 配对成功，已连接智能体桥' : `✗ ${r.error || '配对失败'}`);
    setTimeout(refresh, 600);
  });

  $('reconnect').addEventListener('click', async () => {
    await send({ type: 'hmh-connect' });
    show('重连已触发…');
    setTimeout(refresh, 800);
  });

  $('unpair').addEventListener('click', async () => {
    await send({ type: 'hmh-disconnect' });
    show('已断开（令牌已清除）');
    setTimeout(refresh, 400);
  });

  $('read').addEventListener('click', async () => {
    show('读取当前页…');
    const r = await send({ type: 'hmh-read-current' });
    show(r.ok
      ? `✓ ${r.title}\n${r.url}\n\n${r.preview}`
      : `✗ ${r.error}\n（受保护页面无法注入；Firefox 需在扩展设置里授予主机权限）`);
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
  setInterval(refresh, 2000); // popup/sidepanel lifetime is short; cheap poll
})();
