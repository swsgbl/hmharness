/**
 * @hmharness/web - page/sessions.ts - 会话侧栏(运行徽标/行操作重命名·归档·导出·删除/按项目分组折叠/加载与打开历史会话)
 * P1-3 拆分自 page.ts(基线 682d4fc 行 2031-2270):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const SESSIONS = `  /** W15: reflect runningSids onto every session row badge (called on busy
   *  events and after re-render). */
  function refreshRunBadge(row, sid) {
    var el = row.querySelector('.srun');
    if (el) el.style.display = runningSids[sid] ? '' : 'none';
  }
  function refreshAllRunBadges() {
    document.querySelectorAll('.sess').forEach(function (r) {
      if (r.dataset && r.dataset.sid) refreshRunBadge(r, r.dataset.sid);
    });
  }
  function sessRow(s) {
    var b = document.createElement('button');
    b.className = 'sess';
    b.title = s.id;
    var t1 = document.createElement('div'); t1.className = 't1';
    var dot = document.createElement('span'); dot.className = 'dot';
    var time = document.createElement('span'); time.className = 'time';
    time.textContent = sessTime(s.id);
    t1.appendChild(dot); t1.appendChild(time);
    var label = s.title || s.task || s.id;
    if (label) { var tk = document.createElement('span'); tk.style.flex = '1'; tk.style.overflow = 'hidden'; tk.style.textOverflow = 'ellipsis'; tk.textContent = label.slice(0, 40); t1.appendChild(tk); }
    // W15: per-session RUNNING badge (dsh parity) - a live task in THIS
    // session pulses the row regardless of which view is open
    var run = document.createElement('span'); run.className = 'srun'; run.textContent = '\\u25CF';
    run.title = 'running';
    run.style.cssText = 'color:var(--ok);font-size:8px;flex:none;display:none';
    t1.appendChild(run);
    b.appendChild(t1);
    var t2 = null;
    if (label) { t2 = document.createElement('div'); t2.className = 'task'; t2.textContent = label; b.appendChild(t2); }
    b.dataset.sid = s.id;
    refreshRunBadge(b, s.id);
    b.onclick = function (ev) {
      if (ev.target.closest && ev.target.closest('.sacts')) return;
      if (ev.target.classList && ev.target.classList.contains('ren')) return;
      viewSession(s.id);
    };
    // hover actions: rename (inline edit), archive, delete (trash, recoverable)
    var acts = document.createElement('span'); acts.className = 'sacts';
    function mk(ch, cls, tip, fn) {
      var x = document.createElement('button'); x.type = 'button'; x.textContent = ch; x.title = tip;
      if (cls) x.className = cls;
      x.onclick = function (ev) { ev.stopPropagation(); fn(); };
      return x;
    }
    acts.appendChild(mk('\\u270E', '', L ? L.sesRename : 'rename', function () {
      var input = document.createElement('input');
      input.className = 'ren';
      input.value = s.title || s.task || '';
      if (t2) t2.replaceWith(input); else b.appendChild(input);
      input.focus();
      input.onkeydown = function (ev) {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          var v = input.value.trim();
          if (!v) { loadSessions(); return; }
          fetch('/api/sessions/' + encodeURIComponent(s.id) + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v }) })
            .then(function () { loadSessions(); });
        }
        if (ev.key === 'Escape') loadSessions();
      };
    }));
    acts.appendChild(mk('\\uD83D\\uDCE5', '', L ? L.sesArchive : 'archive', function () {
      fetch('/api/sessions/' + encodeURIComponent(s.id) + '/archive', { method: 'POST' }).then(function () { loadSessions(); });
    }));
    // one-click export (2026-09-25): full transcript as a Markdown download,
    // same builder as hmh export / TUI /export
    acts.appendChild(mk('\\u2B07', '', L ? (L.sesExport || 'export markdown') : 'export markdown', function () {
      window.location.href = '/api/sessions/' + encodeURIComponent(s.id) + '/export.md';
    }));
    acts.appendChild(mk('\\uD83D\\uDDD1', 'del', L ? L.sesDelete : 'delete', function () {
      if (!window.confirm(L ? L.sesConfirmDel : 'delete?')) return;
      fetch('/api/sessions/' + encodeURIComponent(s.id) + '/delete', { method: 'POST' }).then(function () { loadSessions(); });
    }));
    b.appendChild(acts);
    return b;
  }
  /** Group sessions BY PROJECT (their cwd), one collapsible section each.
   *  Registered workspaces show their display name; unregistered folders show
   *  the last path segment. The current workspace's group is first and open;
   *  others are collapsed by default so the sidebar stays scannable with
   *  hundreds of sessions (user request: "按项目为主菜单归类"). */
  // user-toggled group open/closed state, keyed by project path - survives the
  // renderSessions reruns that every state broadcast triggers (the sidebar used
  // to snap every group back to its default fold on each task finish)
  var grpOpen = {};
  function renderSessions(filter) {
    var mine = document.getElementById('sessions');
    var other = document.getElementById('sessions-other');
    mine.innerHTML = '';
    other.innerHTML = '';
    var f = (filter || '').toLowerCase();
    var curPath = (curWs.path || '').toLowerCase();

    // workspace path -> display name (registered ones win)
    var nameByPath = {};
    (wsItems || []).forEach(function (w) {
      if (w && w.path) nameByPath[String(w.path).toLowerCase()] = w.name || String(w.path).split(/[\\\\/]/).pop();
    });
    function projName(p) {
      var key = String(p || '').toLowerCase();
      if (nameByPath[key]) return nameByPath[key];
      var seg = String(p || '').split(/[\\\\/]/).filter(Boolean).pop();
      return seg || (L.ungrouped || 'ungrouped');
    }

    // bucket sessions by project path (newest-first order preserved from API)
    var groups = {};
    var groupOrder = [];
    sessData.forEach(function (s) {
      if (f && (s.id + ' ' + s.task + ' ' + (s.title || '')).toLowerCase().indexOf(f) < 0) return;
      var key = String(s.cwd || '').toLowerCase();
      if (!groups[key]) { groups[key] = { path: s.cwd || '', items: [] }; groupOrder.push(key); }
      groups[key].items.push(s);
    });
    // current workspace first, then groups by size (biggest project first)
    groupOrder.sort(function (a, b) {
      if (a === curPath) return -1;
      if (b === curPath) return 1;
      return groups[b].items.length - groups[a].items.length;
    });

    var groupsEl = document.getElementById('sessions');
    groupOrder.forEach(function (key, idx) {
      var g = groups[key];
      var isCur = key === curPath;
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'projgrp' + (isCur ? ' cur' : '');
      var defOpen = isCur || idx === 0 || !!f;
      var open = Object.prototype.hasOwnProperty.call(grpOpen, key) ? grpOpen[key] : defOpen;
      head.innerHTML = '<span class="pcaret">' + (open ? '\\u25BE' : '\\u25B8') + '</span>'
        + '<span class="pname">' + esc(projName(g.path)) + '</span>'
        + '<span class="pcount">' + g.items.length + '</span>';
      groupsEl.appendChild(head);
      var body = document.createElement('div');
      body.className = 'projbody';
      body.style.display = open ? '' : 'none';
      g.items.forEach(function (s) { body.appendChild(sessRow(s)); });
      groupsEl.appendChild(body);
      head.onclick = function () {
        var vis = body.style.display !== 'none';
        body.style.display = vis ? 'none' : '';
        grpOpen[key] = !vis;
        head.querySelector('.pcaret').textContent = vis ? '\\u25B8' : '\\u25BE';
      };
    });

    if (!groupOrder.length) {
      groupsEl.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px">' + esc(L.none2) + '</div>';
    }
    // legacy elements are unused now (superseded by per-project groups)
    if (other) other.style.display = 'none';
    var ph = document.getElementById('ph-other');
    if (ph) ph.style.display = 'none';
  }
  function loadSessions() {
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      sessData = d.sessions || [];
      if (d.workspace) curWs = d.workspace;
      renderSessions(document.getElementById('search').value);
    });
  }
  /** Open one session's view. History sessions render into their own
   *  container (once), live sessions keep their streaming container - either
   *  way mounting NEVER disturbs any other session's content. */
  function viewSession(id) {
    flushStream();
    switchView('chat');
    var v = viewFor(id);
    if (v.cwd) { /* already known */ }
    mountView(id);
    if (v.loaded) { updateTopbarCwd(); return; }
    v.loaded = true;
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.cwd) { v.cwd = d.cwd; if (curSid === id) updateTopbarCwd(); }
      var root = v.root;
      root.innerHTML = '';
      var st = document.createElement('div'); st.className = 'stats';
      st.textContent = '--- session ' + d.id + ' \u00B7 ' + d.model + ' ---';
      root.appendChild(st);
      // one-click export (2026-09-25): the viewed session as Markdown
      var xbtn = document.createElement('button');
      xbtn.type = 'button'; xbtn.textContent = '\\u2B07 ' + (L ? (L.sesExportBtn || '导出全文') : 'export');
      xbtn.style.cssText = 'margin:4px 16px;padding:3px 10px;font:12px inherit;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer';
      xbtn.onclick = function () { window.location.href = '/api/sessions/' + encodeURIComponent(d.id) + '/export.md'; };
      root.appendChild(xbtn);
      // A15: session full-text search (filters the rendered previews)
      var sbox = document.createElement('div');
      sbox.style.cssText = 'display:flex;gap:6px;margin:4px 16px';
      var sin = document.createElement('input');
      sin.placeholder = (L ? L.sessSearch : 'search in session…');
      sin.style.cssText = 'flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px inherit;outline:none';
      sbox.appendChild(sin);
      root.appendChild(sbox);
      // A13: trajectory timeline — every tool call in order, one dot per call
      var tools = [];
      d.messages.forEach(function (m) { (m.tools || []).forEach(function (tn) { tools.push(tn); }); });
      if (tools.length) {
        var names = {};
        tools.forEach(function (tn) { names[tn] = (names[tn] || 0) + 1; });
        var strip = document.createElement('div');
        strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:0 16px 6px;font-size:11px;color:var(--dim)';
        Object.keys(names).forEach(function (tn) {
          var c = document.createElement('span');
          c.textContent = '\\u25CF ' + tn + '\\u00D7' + names[tn];
          c.title = tn + ' called ' + names[tn] + 'x';
          strip.appendChild(c);
        });
        root.appendChild(strip);
      }
      var rows = [];
      d.messages.forEach(function (m) {
        if (m.role === 'user') rows.push({ kind: 'msg-user', html: m.text });
        else if (m.role === 'assistant') rows.push({ kind: m.tools && m.tools.length ? 'toolrow' : 'say', html: m.text || ('[calls: ' + (m.tools || []).join(', ') + ']') });
        else rows.push({ kind: 'toolres', html: m.text });
      });
      function renderRows(filter) {
        var existing = root.querySelectorAll('.msg-user,.toolrow,.say,.toolres');
        Array.prototype.forEach.call(existing, function (n) { n.remove(); });
        var q = (filter || '').toLowerCase();
        rows.forEach(function (r) {
          if (q && r.html.toLowerCase().indexOf(q) < 0) return;
          var e = document.createElement('div');
          e.className = r.kind;
          e.textContent = r.html;
          root.insertBefore(e, endMark);
        });
        var endMark2 = root.querySelector('.endmark');
        if (curSid === id) log.scrollTop = log.scrollHeight;
      }
      var endMark = document.createElement('div');
      endMark.className = 'stats endmark';
      endMark.textContent = '--- end ---';
      root.appendChild(endMark);
      sin.oninput = function () { renderRows(sin.value); };
      renderRows('');
    });
  }
`;
