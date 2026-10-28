/**
 * @hmharness/web - page/shell.ts - 侧栏动作(新会话/刷新/打开工作区)、移动端抽屉、手机配对弹窗、命令面板(Ctrl+K)、启动引导
 * P1-3 拆分自 page.ts(基线 682d4fc 行 3539-3828):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const SHELL = `  // ---- sidebar actions ----
  /** A fresh DRAFT session: its own container + draft id; the first task
   *  submitted from it carries this id, so the server thread and this view
   *  are the same session from the very first message. */
  function newSession() {
    flushStream();
    switchView('chat');
    var sid = 'draft-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var v = viewFor(sid);
    v.loaded = true;
    v.cwd = (curWs && curWs.path) || '';
    v.root.innerHTML = '<div id="empty"><div style="font-size:30px">\\u2699\\uFE0F</div><div style="margin:8px 0 4px;font-size:16px">' + L.emptyTitle + '</div><div style="font-size:12.5px">' + L.emptySub + '</div><div style="margin-top:14px"></div>' +
      '<div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div>' +
      '<div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div>' +
      '<div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div>';
    mountView(sid);
    wireExamples();
    document.getElementById('rightbar').classList.remove('open');
  }
  function wireExamples() {
    Array.prototype.forEach.call(document.querySelectorAll('#empty .ex'), function (ex) {
      ex.onclick = function () {
        document.getElementById('input').value = ex.getAttribute('data-ex');
        document.getElementById('send').click();
      };
    });
  }
  document.getElementById('newbtn').onclick = newSession;
  document.getElementById('ws-new').onclick = openPick;
  document.getElementById('clear').onclick = newSession;
  document.getElementById('ws-refresh').onclick = loadSessions;
  // settled design W14: 📂 opens the active workspace in the system file
  // manager — POST /api/open (insideWs guard server-side; explorer /select)
  document.getElementById('ws-open').onclick = function () {
    if (!curWs.path) return;
    fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: curWs.path }) })
      .then(function (r) { return r.json(); })
      .then(function (d2) { if (d2 && d2.error) alert(d2.error); })
      .catch(function (err) { alert(String(err)); });
  };
  document.getElementById('board-refresh').onclick = loadBoard;
  document.getElementById('dev-refresh').onclick = loadDevices;
  document.getElementById('search').oninput = function () { renderSessions(this.value); };
  wireExamples();

  // mobile drawer (docx P1 #10): hamburger toggles the sidebar overlay; picking
  // a session or an example auto-closes it so the chat fills the phone screen
  document.getElementById('sideburger').onclick = function () {
    document.body.classList.toggle('mobside');
  };
  document.getElementById('side').addEventListener('click', function (ev) {
    var s = ev.target.closest && ev.target.closest('.sess');
    if (s && document.body.classList.contains('mobside')) document.body.classList.remove('mobside');
  });

  /* ---- phone pairing (2026-09-28, DSH Desktop pattern): topbar 📱 opens a
     modal; WiFi tab QRs the one-time /pair?token link (scan = connected,
     no password on same WiFi); 互联网 tab brings up a free tunnel so any
     network works — the phone then also enters a 6-digit PIN shown here.
     The QR token rotates every 5 minutes; the countdown auto-refreshes. */
  var pairMode = 'lan';
  var pairData = null;
  var pairTimer = null;
  var pairUrl = '';
  function pel(id) { return document.getElementById(id); }
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return '二维码 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' 后失效（自动刷新）';
  }
  function renderPair() {
    var t = (pairData && pairData.tunnel) || {};
    var lan = pairMode === 'lan';
    pel('pair-lan').style.borderColor = lan ? 'var(--accent)' : 'var(--line)';
    pel('pair-wan').style.borderColor = lan ? 'var(--line)' : 'var(--accent)';
    if (lan) {
      pairUrl = (pairData && pairData.lanPairingUrl) || '';
      pel('pair-pin').style.display = 'none';
      pel('pair-pinlab').style.display = 'none';
      pel('pair-line').style.display = 'none';
      pel('pair-hint').textContent = '手机与电脑连接同一 WiFi，扫码即可连接（无需密码）';
      if (!pairUrl) {
        pel('pair-qr').removeAttribute('src');
        pel('pair-url').textContent = '未找到可用的局域网 IP';
        pel('pair-hint').textContent = '请确认电脑已连接 WiFi/网线（虚拟网卡已自动排除）';
        pel('pair-count').textContent = '';
        return;
      }
    } else {
      pairUrl = (pairData && pairData.tunnelPairingUrl) || '';
      pel('pair-hint').textContent = '任何网络均可远程（4G/5G/其他 WiFi），同步实时性中等';
      pel('pair-line').style.display = t.active ? '' : 'none';
      if (t.loading) {
        pel('pair-qr').removeAttribute('src');
        pel('pair-url').textContent = '隧道启动中…（首次使用会自动下载 cloudflared）';
        pel('pair-pin').style.display = 'none';
        pel('pair-pinlab').style.display = 'none';
        pel('pair-count').textContent = '';
        return;
      }
      if (!t.active) {
        pel('pair-qr').removeAttribute('src');
        pel('pair-url').textContent = '互联网模式未开启';
        pel('pair-pin').style.display = 'none';
        pel('pair-pinlab').style.display = 'none';
        pel('pair-count').textContent = '';
        pel('pair-hint').textContent = '点击下方「开启互联网连接」按钮，通过免费隧道从任何网络远程';
        var btn = pel('pair-line');
        btn.textContent = '开启互联网连接';
        btn.style.display = '';
        return;
      }
      pel('pair-line').textContent = '换一条线路';
      pel('pair-pin').style.display = '';
      pel('pair-pinlab').style.display = '';
      pel('pair-pin').textContent = pairData.pin || '—';
    }
    pel('pair-url').textContent = pairUrl;
    pel('pair-qr').src = '/api/qr?text=' + encodeURIComponent(pairUrl);
    tickPair();
  }
  function tickPair() {
    if (!pairData || !pairData.expiresAt) { pel('pair-count').textContent = ''; return; }
    pel('pair-count').textContent = fmtCountdown(pairData.expiresAt - Date.now());
  }
  function refreshPair() {
    api('/api/pair-info').then(function (r) { return r.json(); })
      .then(function (d) { pairData = d; renderPair(); })
      .catch(function () {
        pel('pair-url').textContent = '获取配对信息失败（服务器需 --exposure=lan 启动）';
      });
  }
  var pairPolls = 0;
  function openPairModal() {
    var mod = pel('pairmod');
    mod.classList.add('on');
    refreshPair();
    clearInterval(pairTimer);
    pairTimer = setInterval(function () {
      if (!pel('pairmod').classList.contains('on')) { clearInterval(pairTimer); return; }
      if (!pairData) return;
      if (pairData.expiresAt - Date.now() < 3000) { refreshPair(); tickPair(); return; }
      // live poll every ~5s: a restarted/self-healed tunnel changes the URL,
      // and a stale QR would send the phone to a Cloudflare 1033 dead link
      pairPolls += 1;
      if (pairPolls % 5 === 0) refreshPair();
      else if (pairData.tunnel && pairData.tunnel.loading) refreshPair();
      tickPair();
    }, 1000);
  }
  pel('phone-pair').onclick = openPairModal;
  pel('pair-lan').onclick = function () { pairMode = 'lan'; renderPair(); };
  pel('pair-wan').onclick = function () {
    pairMode = 'wan';
    // entering the internet tab with no tunnel: start it on demand
    if (pairData && pairData.tunnel && !pairData.tunnel.active && !pairData.tunnel.loading) {
      api('/api/tunnel/toggle', { method: 'POST', body: JSON.stringify({ enable: true }) })
        .then(function () { refreshPair(); })
        .catch(function () { refreshPair(); });
      pairData.tunnel.loading = true;
    }
    renderPair();
    refreshPair();
  };
  pel('pair-line').onclick = function () {
    var t = pairData && pairData.tunnel;
    if (t && t.loading) return;
    api('/api/tunnel/switch-line', { method: 'POST', body: '{}' })
      .then(function () { refreshPair(); })
      .catch(function () { refreshPair(); });
    if (pairData && pairData.tunnel) pairData.tunnel.loading = true;
    renderPair();
  };
  pel('pair-copy').onclick = function () {
    if (!pairUrl) return;
    try { navigator.clipboard.writeText(pairUrl); } catch (e) {}
    var b = pel('pair-copy'); b.textContent = '已复制 ✓';
    setTimeout(function () { b.textContent = '复制链接'; }, 1400);
  };
  pel('pair-close').onclick = function () {
    pel('pairmod').classList.remove('on');
    clearInterval(pairTimer);
  };
  el('pairmod').onclick = function (e) {
    if (e.target === this) { this.classList.remove('on'); clearInterval(pairTimer); }
  };

  /* ---- command palette (docx Web 专项): Ctrl+K opens a global console with
     commands, view switches, model routes and session search - full keyboard. */
  var CMDPAL_ACTIONS = function () {
    var acts = [];
    WEB_CMD_NAMES.forEach(function (n) { acts.push({ k: n, d: (L && L.webCmds && L.webCmds[n]) || '', run: function () { document.getElementById('input').value = n + ' '; document.getElementById('input').focus(); } }); });
    ['chat', 'board', 'devices', 'skills', 'settings', 'label'].forEach(function (v) {
      acts.push({ k: '\\u2192 ' + v, d: (L && ({ chat: L.viewChat, board: L.viewBoard, devices: L.viewDev, skills: L.viewSk, settings: L.viewSet, label: L.navLabel })[v]) || v, run: function () { switchView(v); } });
    });
    acts.push({ k: '+ new session', d: (L ? L.newLabel : 'new'), run: function () { newSession(); } });
    (state && state.providers || []).forEach(function (p) {
      if (p.purposes && p.purposes.indexOf('chat') >= 0) return; // current route needs no entry
      acts.push({ k: '\\u21C4 ' + p.name, d: p.model, run: function () {
        fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name }) }).catch(function () {});
      } });
    });
    sessData.slice(0, 12).forEach(function (s) {
      var label = s.title || s.task || s.id;
      acts.push({ k: '\\u{1F5C3} ' + String(label).slice(0, 44), d: String(s.cwd || '').split(/[\\\\/]/).pop() || '', sid: s.id, run: function () { viewSession(s.id); } });
    });
    return acts;
  };
  var palOpen = false;
  var palActs = [];
  var palSelIdx = 0;
  function openCmdPal() {
    palOpen = true;
    palActs = CMDPAL_ACTIONS();
    palSelIdx = 0;
    document.getElementById('cmdpal').classList.add('on');
    var inp = document.getElementById('cmdpal-in');
    inp.value = '';
    renderCmdPal('');
    inp.focus();
  }
  function closeCmdPal() {
    palOpen = false;
    document.getElementById('cmdpal').classList.remove('on');
    document.getElementById('input').focus();
  }
  function renderCmdPal(q) {
    var list = document.getElementById('cmdpal-list');
    var f = (q || '').toLowerCase();
    var hits = palActs.filter(function (a) { return !f || (a.k + ' ' + a.d).toLowerCase().indexOf(f) >= 0; }).slice(0, 14);
    palActs = hits.length ? hits : palActs.slice(0, 0);
    list.innerHTML = '';
    palSelIdx = Math.min(palSelIdx, Math.max(0, palActs.length - 1));
    palActs.forEach(function (a, i) {
      var row = document.createElement('div');
      row.className = 'row' + (i === palSelIdx ? ' sel' : '');
      var k = document.createElement('span'); k.className = 'k'; k.textContent = a.k;
      var d = document.createElement('span'); d.className = 'd'; d.textContent = a.d;
      row.appendChild(k); row.appendChild(d);
      row.onclick = function () { a.run(); closeCmdPal(); };
      row.onmouseenter = function () { palSelIdx = i; renderCmdPal(q); };
      list.appendChild(row);
    });
    if (!palActs.length) {
      var e = document.createElement('div');
      e.className = 'row'; e.style.color = 'var(--dim)';
      e.textContent = '(无匹配 / no match)';
      list.appendChild(e);
    }
  }
  document.getElementById('cmdpal').onclick = function (e) { if (e.target === this) closeCmdPal(); };
  var cmdIn = document.getElementById('cmdpal-in');
  cmdIn.oninput = function () { palSelIdx = 0; renderCmdPal(this.value); };
  cmdIn.onkeydown = function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSelIdx = Math.min(palActs.length - 1, palSelIdx + 1); renderCmdPal(this.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSelIdx = Math.max(0, palSelIdx - 1); renderCmdPal(this.value); }
    else if (e.key === 'Enter') { e.preventDefault(); if (palActs[palSelIdx]) { palActs[palSelIdx].run(); closeCmdPal(); } }
    else if (e.key === 'Escape') { e.preventDefault(); closeCmdPal(); }
  };
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (palOpen) closeCmdPal(); else openCmdPal();
    } else if (e.key === 'Escape' && palOpen) { closeCmdPal(); }
  });

  api('/api/state').then(function (r) { return r.json(); }).then(renderState);
  loadWorkspaces();
  loadSessions();
  // boot: the static welcome card moves into the first DRAFT session view, so
  // the very first task already runs inside a proper per-session container.
  // Refresh-recovery: if the user was viewing a real session, reopen THAT.
  (function () {
    var last = null;
    try { last = localStorage.getItem('hmh-last-sid'); } catch (e) {}
    if (last && last.indexOf('draft-') !== 0) {
      viewSession(last); // fetches the transcript (loaded stays false until then)
      return;
    }
    var sid = 'draft-boot';
    var v = viewFor(sid);
    v.loaded = true;
    var empty = document.getElementById('empty');
    if (empty && empty.parentNode === log) v.root.appendChild(empty);
    mountView(sid);
    wireExamples();
  })();
  // first paint: the sidebar and the welcome view drift in
  window.__AN.stagger('#side .nav');
  window.__AN.viewIn(document.getElementById('view-chat'));
})();
`;
