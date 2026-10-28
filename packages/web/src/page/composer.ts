/**
 * @hmharness/web - page/composer.ts - 输入区(发送/停止单按钮、mode 记忆、注入/排队)、斜杠命令面板、@ 文件搜索、图片附件、队列条
 * P1-3 拆分自 page.ts(基线 682d4fc 行 3187-3537):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const COMPOSER = `  // ---- composer ----
  // Codex-style single button: it is a SEND button when there is text to
  // send (idle: runs now; busy: queues) and a STOP button when the agent is
  // running and the box is empty. No slash commands, no separate stop
  // control - one affordance, state decides.
  // remembered approval mode (user principle: one choice sticks across reloads).
  // Scope: per-task intent only - flipping the GLOBAL default stays with the
  // explicit /yolo command (no hidden side effects from a dropdown pick).
  (function () {
    var sel = document.getElementById('mode');
    try {
      var m0 = localStorage.getItem('hmh-mode');
      if (m0 === 'ask' || m0 === 'auto' || m0 === 'yolo') sel.value = m0;
    } catch (e) {}
    sel.onchange = function () {
      try { localStorage.setItem('hmh-mode', sel.value); } catch (e) {}
    };
  })();

  function updateSendBtn() {
    if (!L) return; // first frame before /api/state resolves - keep the static label
    var btn = document.getElementById('send');
    var hasText = !!document.getElementById('input').value.trim();
    var running = !!window.__agentBusy;
    if (running && !hasText) {
      btn.textContent = '\\u23F9 ' + L.stop;
      btn.classList.add('stop');
      btn.title = L.stopTitle;
    } else {
      btn.textContent = hasText ? L.sendNow : L.send;
      btn.classList.remove('stop');
      btn.title = running ? L.queueTitle : '';
    }
  }
  // authenticated fetch wrapper: attaches the remote-control key when present
  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, AUTH_KEY ? { 'X-Hmh-Key': AUTH_KEY } : {});
    return fetch(url, opts);
  }
  function interrupt() {
    fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: curSid || undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.error) el('div', 'err', d.error); })
      .catch(function (err) { el('div', 'err', String(err)); });
  }
  function sendTask(text, sidIn) {
    regenSid = sidIn || null;
    sendTaskInner(text);
  }
  var regenSid = null;
  function sendTaskInner(text) {
    if (!text) return;
    clearEmpty();
    switchView('chat');
    // slash commands route to /api/command (settled design W5: web subset),
    // never the agent loop
    if (text.charAt(0) === '/') {
      if (text === '/clear') { newSession(); return; }
      if (text === '/help') { renderCmdResult(WEB_CMD_NAMES.map(function (n) { return n + ' \\u2014 ' + ((L && L.webCmds && L.webCmds[n]) || ''); }).join('\\n')); return; }
      if (text === '/status') {
        renderCmdResult((state ? state.model : '?') + ' · ' + (state ? state.locale : 'zh') + ' · ' + ((state && state.queue && state.queue.length) ? state.queue.length + ' queued' : 'idle'));
        return;
      }
      el('div', 'msg-user', text);
      api('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: text }) })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.status === 404 || (res.d && res.d.error)) renderCmdResult(res.d && res.d.error ? res.d.error : 'unknown command', true);
          else if (res.d && res.d.text) renderCmdResult(res.d.text);
        })
        .catch(function (err) { renderCmdResult(String(err), true); });
      return;
    }
    // the user bubble always shows right where the user typed it - even when
    // the task will queue (busy); without this the send press gave zero
    // feedback in away views
    el('div', 'msg-user', text, true);
    echoedTask = text; echoedAt = Date.now(); // busy-event echo dedup
    var submitSid = (regenSid || curSid) || '';
    var v0 = submitSid ? views.get(submitSid) : null;
    if (v0) v0.lastTask = text;
    regenSid = null;
    var body = { text: text, yes: document.getElementById('mode').value !== 'ask', mode: document.getElementById('mode').value, sessionId: submitSid, fresh: /^draft-/.test(submitSid) };
    var files = [];
    var images = [];
    attachments.forEach(function (a) { if (a.kind === 'image') images.push({ name: a.name, dataUrl: a.dataUrl }); else files.push(a.path); });
    if (files.length) body.attachments = files;
    if (images.length) body.images = images;
    attachments = [];
    renderAtts();
    api('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.d && res.d.queued) {
          el('div', 'queued', (L.queuedHint || 'queued') + ' #' + res.d.position + ' \u2014 ' + text, true);
        } else if (res.status === 409) {
          el('div', 'err', L.alreadyRunning);
        }
      })
      .catch(function (err) { el('div', 'err', String(err)); });
  }
  function renderCmdResult(text, isErr) {
    var d = document.createElement('div');
    d.className = isErr ? 'toolres err' : 'toolres';
    var h = document.createElement('span');
    h.style.color = 'var(--accent)';
    h.textContent = '[/ ' + (L ? L.cmdOk : 'cmd') + '] ';
    d.appendChild(h);
    d.appendChild(document.createTextNode(text));
    log.appendChild(d);
    autoscroll();
  }
  /* ---- slash palette (A2) + @ file search (A2) + attachments (A2) ---- */
  var WEB_CMD_NAMES = ['/help', '/clear', '/status', '/model', '/lang', '/yolo', '/providers', '/tools', '/skills', '/mcp', '/ops', '/ops scan', '/resume', '/web', '/exit'];
  function webCmdItems() {
    return WEB_CMD_NAMES.map(function (n) { return { name: n, desc: (L && L.webCmds && L.webCmds[n]) || '' }; });
  }
  var attachments = [];
  var palMode = null;  // 'slash' | 'at' | null
  var palItems = [];
  var palSel = 0;
  var atTimer = null;
  var atToken = 0;
  function closePal() {
    document.getElementById('slashpanel').classList.remove('on');
    document.getElementById('atpanel').classList.remove('on');
    palMode = null;
    palItems = [];
  }
  function renderPal() {
    if (!palMode) { closePal(); return; }
    var panel = palMode === 'slash' ? document.getElementById('slashpanel') : document.getElementById('atpanel');
    var other = palMode === 'slash' ? document.getElementById('atpanel') : document.getElementById('slashpanel');
    other.classList.remove('on');
    panel.classList.add('on');
    panel.innerHTML = '';
    var list = palItems;
    palSel = Math.max(0, Math.min(palSel, list.length - 1));
    list.slice(0, 8).forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'pickrow' + (i === palSel ? ' sel' : '');
      var pn = document.createElement('span'); pn.className = 'pn'; pn.textContent = it.name;
      var pd = document.createElement('span'); pd.className = 'pd'; pd.textContent = it.desc || '';
      row.appendChild(pn); row.appendChild(pd);
      if (it.path) { var ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = it.path; row.appendChild(ph); }
      row.onmousedown = function (ev) { ev.preventDefault(); pickPal(it); };
      row.onmouseenter = function () { if (palSel !== i) { palSel = i; renderPal(); } };
      panel.appendChild(row);
    });
    if (!list.length) {
      var em = document.createElement('div');
      em.className = 'pickfoot';
      em.textContent = palMode === 'at' ? (L.atNone || 'no matching files') : '';
      panel.appendChild(em);
    }
    var foot = document.createElement('div');
    foot.className = 'pickfoot';
    foot.textContent = palMode === 'slash' ? L.slashHint : L.atHint;
    panel.appendChild(foot);
  }
  function pickPal(it) {
    var input = document.getElementById('input');
    if (palMode === 'slash') {
      input.value = it.name + ' ';
    } else if (palMode === 'at') {
      addFileAtt(it);
      input.value = input.value.replace(/@[\\w./\\-]*$/, '');
    }
    closePal();
    input.focus();
    updateSendBtn();
  }
  function atQuery(v) {
    var m = String(v).match(/@([\\w./\\-]*)$/);
    return m ? m[1] : null;
  }
  function scheduleAtSearch(q) {
    if (atTimer) clearTimeout(atTimer);
    atTimer = setTimeout(function () { doAtSearch(q); }, 150);
  }
  function doAtSearch(q) {
    var token = ++atToken;
    if (!q) { palItems = []; palSel = 0; renderPal(); return; }
    fetch('/api/fs/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (token !== atToken || palMode !== 'at') return;
        var hits = (res.ok ? (res.d.results || res.d.items || []) : []);
        palItems = hits.map(function (it) { return { name: it.rel, desc: '', path: it.path }; });
        palSel = 0;
        renderPal();
      })
      .catch(function () {});
  }
  function renderAtts() {
    var bar = document.getElementById('attbar');
    bar.innerHTML = '';
    bar.classList.toggle('on', attachments.length > 0);
    attachments.forEach(function (a, i) {
      var chip = document.createElement('span');
      chip.className = 'attchip';
      if (a.kind === 'image') {
        var img = document.createElement('img');
        img.src = a.dataUrl;
        img.alt = a.name;
        chip.appendChild(img);
      }
      var nm = document.createElement('span');
      nm.textContent = a.kind === 'image' ? a.name : a.rel;
      nm.title = a.path || a.name;
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'atx'; x.textContent = '\\u00D7';
      x.onclick = function () { attachments.splice(i, 1); renderAtts(); };
      chip.appendChild(nm); chip.appendChild(x);
      bar.appendChild(chip);
    });
  }
  function addFileAtt(it) {
    if (attachments.some(function (a) { return a.kind === 'file' && a.path === it.path; })) return;
    attachments.push({ kind: 'file', rel: it.name, path: it.path });
    renderAtts();
  }
  function addImage(dataUrl, name) {
    if (attachments.filter(function (a) { return a.kind === 'image'; }).length >= 3) { alert('max 3 images'); return; }
    attachments.push({ kind: 'image', name: name, dataUrl: dataUrl });
    renderAtts();
  }
  function injectNow(text) {
    fetch('/api/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, sessionId: curSid || undefined }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok && res.d && res.d.error) { el('div', 'err', res.d.error); return; }
        document.getElementById('input').value = '';
        updateSendBtn();
      })
      .catch(function (err) { el('div', 'err', String(err)); });
  }
  document.getElementById('send').onclick = function () {
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (text) {
      input.value = '';
      updateSendBtn();
      sendTask(text);
      return;
    }
    if (window.__agentBusy) interrupt();
  };
  document.getElementById('input').onkeydown = function (e) {
    if (palMode) {
      if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); renderPal(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPal(); return; }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (palItems[palSel]) pickPal(palItems[palSel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closePal(); return; }
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (e.ctrlKey) {
        // settled design W6: 运行中 Ctrl+Enter = 注入当前轮;空闲时与 Enter 同义
        var it = this.value.trim();
        if (!it) return;
        if (window.__agentBusy) {
          injectNow(it);
        } else {
          this.value = '';
          updateSendBtn();
          sendTask(it);
        }
        return;
      }
      if (!e.shiftKey) document.getElementById('send').click();
    }
  };
  document.getElementById('input').oninput = function () {
    updateSendBtn();
    var v = this.value;
    var aq = atQuery(v);
    if (aq !== null) {
      palMode = 'at';
      scheduleAtSearch(aq);
    } else if (v.charAt(0) === '/') {
      palMode = 'slash';
      palItems = webCmdItems().filter(function (c) { return c.name.indexOf(v) === 0; });
      palSel = 0;
      renderPal();
    } else {
      closePal();
    }
  };
  // paste images (A2): the vision chain describes them server-side before the task runs
  document.getElementById('input').addEventListener('paste', function (ev) {
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it && it.kind === 'file' && /^image\\//.test(it.type)) {
        ev.preventDefault();
        var f = it.getAsFile();
        if (!f) continue;
        if (f.size > 6 * 1024 * 1024) { alert('image too large (max 6MB)'); continue; }
        var reader = new FileReader();
        reader.onload = function () { addImage(String(reader.result), f.name || 'paste.png'); };
        reader.readAsDataURL(f);
        return;
      }
    }
  });
  document.getElementById('attach').onclick = function () { document.getElementById('imgfile').click(); };
  document.getElementById('imgfile').onchange = function () {
    var files = this.files || [];
    for (var i = 0; i < files.length; i++) {
      (function (f) {
        if (!f || !/^image\\//.test(f.type)) return;
        if (f.size > 6 * 1024 * 1024) { alert('image too large (max 6MB)'); return; }
        var reader = new FileReader();
        reader.onload = function () { addImage(String(reader.result), f.name || 'image.png'); };
        reader.readAsDataURL(f);
      })(files[i]);
    }
    this.value = '';
  };

  // ---- queue bar ----
  function renderQueue(items) {
    var bar = document.getElementById('queuebar');
    if (!bar) return;
    bar.innerHTML = '';
    var list = items || [];
    bar.classList.toggle('on', list.length > 0);
    if (!list.length) return;
    list.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'qrow';
      var n = document.createElement('span'); n.className = 'qn'; n.textContent = '#' + (i + 1);
      var tx = document.createElement('span'); tx.className = 'qt'; tx.textContent = t; tx.title = t;
      var x = document.createElement('button'); x.type = 'button'; x.title = L.queueRemove; x.textContent = '\\u00D7';
      x.onclick = function () {
        fetch('/api/queue?i=' + i, { method: 'DELETE' }).catch(function () {});
      };
      row.appendChild(n); row.appendChild(tx); row.appendChild(x);
      bar.appendChild(row);
    });
    var clear = document.createElement('button');
    clear.id = 'qclear'; clear.type = 'button'; clear.textContent = L.queueClear;
    clear.onclick = function () { fetch('/api/queue', { method: 'DELETE' }).catch(function () {}); };
    bar.appendChild(clear);
  }
`;
