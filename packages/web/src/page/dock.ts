/**
 * @hmharness/web - page/dock.ts - 右栏 Dock(详情/文件/预览/证据/日志五 tab、宽度拖拽)、流式状态(flushStream/autoscroll)、keyed 工具渲染(diff 卡/搜索卡/折叠行)
 * P1-3 拆分自 page.ts(基线 682d4fc 行 2272-2625):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const DOCK = `  /* ---- right column (W7): tabs 详情/文件/预览, collapsible, 300-600px drag ---- */
  function openRight(tab) {
    document.getElementById('rightbar').classList.add('open');
    if (tab) switchRightTab(tab);
  }
  function closeRight() {
    document.getElementById('rightbar').classList.remove('open');
  }
  function switchRightTab(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.rtab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.rtabpane'), function (p) {
      p.classList.toggle('on', p.id === 'rtab-' + tab + '-pane');
    });
    if (tab === 'files') {
      var ft = document.getElementById('ftree');
      if (!ft.getAttribute('data-loaded')) {
        ft.setAttribute('data-loaded', '1');
        ft.innerHTML = '<div class="hint">' + esc((L ? L.loading : '…')) + '</div>';
        loadTree((state && state.workspace && state.workspace.path) || '', ft);
      }
    }
    // Context Dock (UX pack 03): Evidence loads the current session's
    // cognitive lineage on demand; Logs streams the tail of the session log
    if (tab === 'evidence') loadEvidencePane();
    if (tab === 'logs') loadLogsPane();
  }
  /** Evidence pane: the structured cognitive facts of the viewed session -
   *  model, world-model version, skill snapshot, evidence chain. Sourced
   *  from /api/cognitive (structured facts only, never raw thinking). */
  function loadEvidencePane() {
    var ev = document.getElementById('eview');
    if (!ev) return;
    ev.innerHTML = '<div class="hint">' + esc((L ? L.loading : '…')) + '</div>';
    fetch('/api/cognitive').then(function (r) { return r.json(); }).then(function (c) {
      var rows = [];
      if (c && c.model) rows.push(['模型', c.model]);
      if (c && c.worldModel && c.worldModel.version !== undefined) rows.push(['世界模型', 'v' + c.worldModel.version + ' · ' + (c.worldModel.beliefs || 0) + ' beliefs']);
      if (c && c.skills) rows.push(['技能', Object.keys(c.skills).length + ' active']);
      if (c && c.calibration) rows.push(['校准', 'Brier ' + (c.calibration.brier !== undefined ? c.calibration.brier.toFixed(3) : '—')]);
      if (c && c.memory) rows.push(['记忆', (c.memory.episodic || 0) + 'ep · ' + (c.memory.semantic || 0) + 'sem']);
      if (c && c.evidenceChain) rows.push(['证据链', c.evidenceChain.length + ' links']);
      ev.innerHTML = '';
      if (rows.length === 0) { ev.innerHTML = '<div class="hint">暂无认知谱系数据</div>'; return; }
      rows.forEach(function (r) {
        var d = document.createElement('div');
        d.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--line)';
        var k = document.createElement('span'); k.style.cssText = 'color:var(--dim);min-width:64px'; k.textContent = r[0];
        var v = document.createElement('span'); v.textContent = String(r[1]);
        d.appendChild(k); d.appendChild(v); ev.appendChild(d);
      });
    }).catch(function () { ev.innerHTML = '<div class="hint">加载失败</div>'; });
  }
  /** Logs pane: the tail of the session's tool log - what actually ran,
   *  most recent first, capped. Structured rows, not raw stream dumps. */
  function loadLogsPane() {
    var lv = document.getElementById('lview');
    if (!lv) return;
    var v = views.get(curSid);
    lv.innerHTML = '';
    var entries = [];
    if (v && v.toolRegistry) {
      Object.keys(v.toolRegistry).forEach(function (seq) {
        var t = v.toolRegistry[seq];
        entries.push({ seq: Number(seq), name: t.name, args: t.args });
      });
      entries.sort(function (a, b) { return b.seq - a.seq; });
      entries = entries.slice(0, 50);
    }
    if (entries.length === 0) { lv.textContent = '暂无日志'; return; }
    entries.forEach(function (e) {
      var d = document.createElement('div');
      d.style.cssText = 'padding:3px 0;border-bottom:1px solid var(--line)';
      var head = document.createElement('span'); head.style.color = 'var(--text)';
      head.textContent = '#' + e.seq + ' ' + e.name;
      var ar = document.createElement('span'); ar.style.color = 'var(--dim)';
      ar.textContent = ' ' + JSON.stringify(e.args || {}).slice(0, 100);
      d.appendChild(head); d.appendChild(ar); lv.appendChild(d);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.rtab'), function (b) {
    b.onclick = function () { openRight(b.getAttribute('data-tab')); };
  });
  document.getElementById('rclose').onclick = closeRight;
  document.getElementById('rcollapse').onclick = function () {
    document.getElementById('rightbar').classList.remove('open');
  };
  // drag resize (300-600px), remembered in localStorage
  (function () {
    var rb = document.getElementById('rightbar');
    var drag = document.getElementById('rdrag');
    var dragging = false;
    function applyW(w) {
      if (w) rb.style.width = w + 'px';
    }
    try {
      var saved = localStorage.getItem('hmh-right-w');
      if (saved && Number(saved) >= 300 && Number(saved) <= 600) applyW(Number(saved));
    } catch (e) {}
    drag.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      dragging = true;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      var w = window.innerWidth - ev.clientX;
      w = Math.max(300, Math.min(600, w));
      applyW(w);
      try { localStorage.setItem('hmh-right-w', String(w)); } catch (e) {}
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });
  })();
  function showDetailsIn(v, seqId) {
    var d = v && v.toolRegistry[seqId];
    if (!d) return;
    openRight('detail');
    document.getElementById('dname').textContent = d.name;
    var body = document.getElementById('dbody');
    body.innerHTML = '';
    var h1 = document.createElement('h4'); h1.textContent = 'input';
    var p1 = document.createElement('pre'); p1.textContent = JSON.stringify(d.args, null, 2);
    var h2 = document.createElement('h4'); h2.textContent = 'output';
    var p2 = document.createElement('pre'); p2.textContent = d.output || '(pending)';
    body.appendChild(h1); body.appendChild(p1); body.appendChild(h2); body.appendChild(p2);
  }
  /* ---- files tab: lazy workspace tree (server /api/fs?files=1) ---- */
  function fileRow(name, rel, path, kind) {
    var row = document.createElement('div');
    row.className = 'frow ' + kind;
    var ic = document.createElement('span'); ic.className = 'fic';
    ic.textContent = kind === 'dir' ? '\\uD83D\\uDCC1' : '\\uD83D\\uDCC4';
    var nm = document.createElement('span');
    nm.textContent = name;
    nm.title = rel;
    row.appendChild(ic); row.appendChild(nm);
    row.onclick = function () {
      if (kind === 'dir') {
        var kids = row.nextSibling;
        if (kids && kids.className === 'fkids') {
          var hidden = kids.style.display === 'none';
          kids.style.display = hidden ? '' : 'none';
          ic.textContent = hidden ? '\\uD83D\\uDCC2' : '\\uD83D\\uDCC1';
          return;
        }
        var box = document.createElement('div');
        box.className = 'fkids';
        box.innerHTML = '<div class="hint">' + esc((L ? L.loading : '…')) + '</div>';
        row.after(box);
        ic.textContent = '\\uD83D\\uDCC2';
        loadTree(path, box);
      } else {
        openPreview(rel);
      }
    };
    return row;
  }
  function loadTree(path, box) {
    fetch('/api/fs?path=' + encodeURIComponent(path) + '&files=1')
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!box.isConnected) return;
        box.innerHTML = '';
        if (!res.ok) { box.innerHTML = '<div class="hint err">' + esc((res.d && res.d.error) || 'failed') + '</div>'; return; }
        var d = res.d;
        (d.dirs || []).forEach(function (dir) { box.appendChild(fileRow(dir.name, dir.path, dir.path, 'dir')); });
        (d.files || []).forEach(function (f) { box.appendChild(fileRow(f.name, f.rel, f.path, 'file')); });
        if (!(d.dirs || []).length && !(d.files || []).length) box.innerHTML = '<div class="hint">' + esc(L.none2) + '</div>';
      })
      .catch(function (e) { if (box.isConnected) box.innerHTML = '<div class="hint err">' + esc(String(e)) + '</div>'; });
  }
  function openPreview(rel) {
    openRight('preview');
    var box = document.getElementById('pview');
    box.innerHTML = '<div class="hint">' + esc((L ? L.loading : '…')) + '</div>';
    fetch('/api/fs/read?path=' + encodeURIComponent(rel))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        var d = res.d || {};
        if (!res.ok || d.error) {
          box.innerHTML = '<div class="err">' + esc((d.error || L.pvNotFile)) + '</div>';
          return;
        }
        if (d.binary) {
          box.innerHTML = '<div class="hint">' + L.pvBinary + d.size + ' bytes)</div>';
          return;
        }
        box.innerHTML = '';
        var h = document.createElement('div');
        h.className = 'pvhead';
        h.textContent = (d.rel || rel) + (d.truncated ? ' ' + L.pvTrunc : '');
        var pre = document.createElement('pre');
        pre.className = 'pvcode';
        pre.textContent = d.text || '';
        box.appendChild(h); box.appendChild(pre);
      })
      .catch(function (e) { box.innerHTML = '<div class="err">' + esc(String(e)) + '</div>'; });
  }
  // clickable file paths inside the chat: a path-looking <code> opens the preview tab.
  // Relative paths AND Windows/POSIX absolute paths (the old regex rejected the
  // drive letter / leading slash, so agent-quoted absolute paths were dead text)
  function maybePath(t) {
    if (/^https?:/.test(t) || t.indexOf(' ') >= 0 || t.length >= 200) return false;
    if (/^[A-Za-z]:[\\\\/][^:<>"|?*]{0,180}/.test(t)) return true;  // G:\\x\\y or C:/x/y
    if (/^\\//.test(t)) return true;                                  // /abs/posix/path
    return /^[A-Za-z0-9_.\\/-]+\\.[a-zA-Z0-9]{1,8}$/.test(t);        // rel/file.ext
  }
  log.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var code = t.closest('code');
    if (code && !t.closest('.codebar') && !t.closest('.copy') && maybePath(code.textContent.trim())) {
      openPreview(code.textContent.trim());
    }
  });

  // ---- streaming state (per-view; the active view is set by SSE routing) ----
  function flushStream() {
    var v = activeSinkSidVal ? views.get(activeSinkSidVal) : null;
    if (!v) return;
    if (v.curBlock) v.curBlock.finalize();
    // run-state 2.0: a laid-out numbered plan (>=2 steps in the VISIBLE
    // text) flips the phase to planning - once per run, derived from output
    // only, never from chain-of-thought
    if (!v.planSeenRun && v.lastAssistantText && typeof hasPlanText === 'function' && hasPlanText(v.lastAssistantText)) {
      v.planSeenRun = true;
      taskPhaseEvent('planning');
    }
    // a new model turn resets the parallel group context
    v.parCount = 0; v.parBox = null;
    v.curBlock = null;
    v.curKind = null;
  }
  function safeAutoscroll() { if (!activeSinkSidVal || activeSinkSidVal === curSid) autoscroll(); }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function autoscroll() { if (nearBottom()) log.scrollTop = log.scrollHeight; }
  log.addEventListener('scroll', function () {
    document.getElementById('tobot').style.display = nearBottom() ? 'none' : 'block';
  });
  document.getElementById('tobot').onclick = function () { log.scrollTop = log.scrollHeight; };
  // delegated: code-copy buttons + thinking-box toggles
  log.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var cp = t.closest('.copy');
    if (cp) {
      var blk = cp.closest('.codeblk');
      var pre = blk ? blk.querySelector('pre') : null;
      if (pre) copyText(pre.textContent);
      cp.textContent = '\\u2713';
      window.__AN.tick(cp);
      setTimeout(function () { cp.textContent = L ? L.copy : 'copy'; }, 1200);
      return;
    }
    var th = t.closest('.thinkhead');
    if (th) { th.parentNode.classList.toggle('open'); }
  });

  /* ---- keyed tool-result renderers (A4, pure logic from uilite.ts) ----
     edit_file/write_file 结果含 unified diff → diff 卡片;web_search → 链接卡片;
     其余保持定案 W1:折叠一行可展开,长日志折叠时只显示尾部 50 行。 */
  function renderDiff(d) {
    var box = document.createElement('div');
    box.className = 'diffbox';
    var head = document.createElement('div');
    head.className = 'dhead';
    var t = document.createElement('span');
    t.textContent = d.name;
    var cp = document.createElement('button');
    cp.type = 'button'; cp.className = 'copy'; cp.textContent = L ? L.copy : 'copy';
    cp.onclick = function () { copyText(d.full); cp.textContent = '\\u2713'; setTimeout(function () { cp.textContent = L ? L.copy : 'copy'; }, 1200); };
    head.appendChild(t); head.appendChild(cp);
    box.appendChild(head);
    var pre = document.createElement('pre');
    var segs = parseUnifiedDiff(d.full || d.preview || '');
    if (segs.length > 400) segs = segs.slice(0, 400);
    segs.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'dline' + (s.kind === 'add' ? ' add' : s.kind === 'del' ? ' del' : s.kind === 'hunk' ? ' hunk' : s.kind === 'file' ? ' file' : '');
      row.textContent = s.text;
      pre.appendChild(row);
    });
    box.appendChild(pre);
    sink().appendChild(box);
    safeAutoscroll();
  }
  function renderSearchCards(d) {
    var urls = [];
    var re = /https?:\\/\\/[^\\s)"'<>]+/g;
    var m;
    while ((m = re.exec(d.full || d.preview || '')) !== null) {
      if (urls.indexOf(m[0]) < 0) urls.push(m[0]);
      if (urls.length >= 6) break;
    }
    urls.forEach(function (u) {
      var card = document.createElement('div');
      card.className = 'linkcard';
      var a = document.createElement('a');
      a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = u;
      var h = document.createElement('span'); h.className = 'lh';
      try { h.textContent = new URL(u).host; } catch (e2) {}
      card.appendChild(a); card.appendChild(h);
      sink().appendChild(card);
    });
    safeAutoscroll();
  }
  function foldToolResult(d) {
    var fold = document.createElement('div');
    fold.className = 'toolfold' + (d.isError ? ' err' : '');
    var tri = document.createElement('span'); tri.className = 'tri'; tri.textContent = '\\u25B8';
    var lab = document.createElement('span');
    var pv = String(d.preview).replace(/\\s+/g, ' ').trim().slice(0, d.isError ? 110 : 72);
    lab.textContent = pv || '(done)';
    fold.appendChild(tri); fold.appendChild(lab);
    // Recovery First (docx P1 #2): a failure must suggest the NEXT step, not
    // just say "failed" - plain language + where the evidence lives
    if (d.isError) {
      var hint = document.createElement('span');
      hint.style.cssText = 'margin-left:8px;color:var(--warn);font-size:11px';
      hint.textContent = (L && L.localeKey === 'en')
        ? '\\u2190 failed - click this row for the full error, then retry or adjust'
        : '\\u2190 失败 - 点击本行看完整错误，可修改后重试';
      fold.appendChild(hint);
    }
    var body = null;
    fold.onclick = function () {
      fold.classList.toggle('open');
      if (!body) {
        body = document.createElement('div');
        body.className = d.isError ? 'toolres err' : 'toolres';
        var full = d.full || d.preview || '';
        var ls = full.split('\\n');
        if (ls.length > 60) {
          var cut = document.createElement('div');
          cut.style.color = 'var(--dim)';
          cut.textContent = '\\u22EF ' + (ls.length - 50) + ' lines folded \\u00B7 showing tail 50';
          body.appendChild(cut);
          full = ls.slice(-50).join('\\n');
        }
        body.appendChild(document.createTextNode(full));
        fold.after(body);
      } else { body.style.display = body.style.display === 'none' ? '' : 'none'; }
    };
    sink().appendChild(fold);
    safeAutoscroll();
  }
  var pendingToolRow = null;   // running tool row awaiting its result
`;
