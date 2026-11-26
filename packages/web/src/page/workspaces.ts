/**
 * @hmharness/web - page/workspaces.ts - 工作区列表(切换/移除注册)与目录选择器(服务端盘符浏览/面包屑/命名添加)
 * P1-3 拆分自 page.ts(基线 682d4fc 行 1278-1438):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const WORKSPACES = `  /* ---- workspaces (the agent's project contexts) ---- */
  var wsItems = [];
  var curWs = { id: '', name: '', path: '' };
  function loadWorkspaces() {
    fetch('/api/workspaces').then(function (r) { return r.json(); }).then(function (d) {
      wsItems = d.items || [];
      if (d.current && d.items) {
        for (var i = 0; i < d.items.length; i++) {
          if (d.items[i].id === d.current) { curWs = d.items[i]; break; }
        }
      }
      renderWsList();
      renderSessions(document.getElementById('search').value);
    });
  }
  function setWsBox(open) {
    document.getElementById('wsbox').classList.toggle('open', open);
    document.getElementById('wscur').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function renderWsList() {
    document.getElementById('wscur-name').textContent = curWs.name || '…';
    var box = document.getElementById('ws-items');
    box.innerHTML = '';
    wsItems.forEach(function (w) {
      var item = document.createElement('div');
      item.className = 'wsi' + (w.id === curWs.id ? ' on' : '');
      var nm = document.createElement('div'); nm.className = 'nm';
      var dot = document.createElement('span'); dot.className = 'dot';
      var t = document.createElement('span');
      t.style.whiteSpace = 'nowrap'; t.style.overflow = 'hidden'; t.style.textOverflow = 'ellipsis';
      t.textContent = w.name;
      nm.appendChild(dot); nm.appendChild(t);
      var pt = document.createElement('div'); pt.className = 'pt'; pt.textContent = w.path;
      var x = document.createElement('button'); x.className = 'wsx'; x.type = 'button'; x.textContent = '\\u00D7';
      x.title = L ? L.wsRemove : 'remove';
      // the name disambiguates: "remove" alone reads the same on every row
      x.setAttribute('aria-label', (L ? L.wsRemove : 'remove') + ' ' + w.name);
      // the active workspace cannot be removed (the server refuses it): say so here
      // instead of offering a button that can only end in an error dialog
      if (w.id === curWs.id) {
        x.disabled = true;
        x.title = L ? L.wsActive : 'active workspace';
        x.setAttribute('aria-label', (L ? L.wsActive : 'active workspace') + ' ' + w.name);
      }
      x.onclick = function (ev) {
        ev.stopPropagation();
        fetch('/api/workspaces/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: w.id }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.items) { wsItems = d.items; renderWsList(); }
            else if (d.error) { alert(d.error); }
          })
          .catch(function (e) { alert(String(e)); });
      };
      // the switch target is a real button and the remove button its sibling: a button
      // may not contain another one, and the keyboard has to reach both
      var main = document.createElement('button'); main.type = 'button'; main.className = 'wmain';
      main.appendChild(nm); main.appendChild(pt);
      item.appendChild(main); item.appendChild(x);
      main.onclick = function () {
        if (w.id === curWs.id) { setWsBox(false); return; }
        fetch('/api/workspaces/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: w.id }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setWsBox(false);
            if (d.error) { alert(d.error); return; }
            if (d.items) wsItems = d.items;
            curWs = w;
            renderWsList();
            loadSessions();
          })
          .catch(function (e) { alert(String(e)); });
      };
      box.appendChild(item);
    });
  }
  document.getElementById('wscur').onclick = function () {
    var box = document.getElementById('wsbox');
    setWsBox(!box.classList.contains('open'));
    if (box.classList.contains('open')) {
      renderWsList();
      window.__AN.stagger('#ws-items .wsi');
    }
  };
  document.getElementById('ws-add').onclick = openPick;

  /* ---- workspace directory picker (server-side drive/folder listing) ---- */
  var pickPath = '';
  var pickTrigger = null;   // where focus goes back when the picker closes
  function openPick() {
    pickTrigger = document.activeElement;
    setWsBox(false);
    document.getElementById('wspick').classList.add('on');
    document.getElementById('wsp-name').value = '';
    loadFs('');
    window.__AN.popIn(document.getElementById('wsp-card'));
    // a dialog takes the focus when it opens; the page behind it is inert by now
    document.getElementById('wsp-path').focus();
  }
  function closePick() {
    document.getElementById('wspick').classList.remove('on');
    syncModals();
    // back to the control that opened the picker (the list's add button is hidden again
    // once the list is closed, so its owner gets the focus)
    var t = pickTrigger;
    if (t && t.offsetParent === null) t = document.getElementById('wscur');
    if (t && t.focus) t.focus();
  }
  document.getElementById('wsp-close').onclick = closePick;
  document.getElementById('wsp-cancel').onclick = closePick;
  document.getElementById('wspick').onclick = function (e) {
    if (e.target === this) closePick();
  };
  document.getElementById('wsp-path').onkeydown = function (e) {
    if (enterConfirmed(e)) loadFs(this.value.trim());
  };
  function renderCrumb(segs) {
    var c = document.getElementById('wsp-crumb');
    c.innerHTML = '';
    var pc = document.createElement('button');
    pc.type = 'button';
    pc.className = 'pc';
    pc.textContent = L ? L.thisPC : 'This PC';
    pc.onclick = function () { loadFs(''); };
    c.appendChild(pc);
    segs.forEach(function (s) {
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' \\u203A ';
      sep.setAttribute('aria-hidden', 'true');
      c.appendChild(sep);
      var seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'seg';
      seg.textContent = s.name;
      seg.title = s.path;
      seg.onclick = function () { loadFs(s.path); };
      c.appendChild(seg);
    });
  }
  function loadFs(path) {
    var list = document.getElementById('wsp-list');
    list.innerHTML = '<div class="hint">' + esc((L ? L.loading : '...')) + '</div>';
    fetch('/api/fs' + (path ? '?path=' + encodeURIComponent(path) : '')).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (!res.ok) { list.innerHTML = '<div class="hint err">' + esc((res.d && res.d.error) || 'failed') + '</div>'; return; }
      var d = res.d;
      pickPath = d.path || '';
      document.getElementById('wsp-path').value = d.path || '';
      document.getElementById('wsp-sel').textContent = pickPath || (L ? L.thisPC : '');
      renderCrumb(d.segments || []);
      list.innerHTML = '';
      if (d.parent) {
        var up = document.createElement('button');
        up.type = 'button';
        up.className = 'wsp-item up';
        up.innerHTML = '<span class="ic" aria-hidden="true">\\u2191</span> ' + (L ? L.up : 'up');
        up.onclick = function () { loadFs(d.parent); };
        list.appendChild(up);
      }
      (d.dirs || []).forEach(function (dir) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'wsp-item';
        var ic = document.createElement('span'); ic.className = 'ic'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = '\\uD83D\\uDCC1';
        var nm = document.createElement('span'); nm.textContent = dir.name;
        item.appendChild(ic); item.appendChild(nm);
        item.onclick = function () { loadFs(dir.path); };
        list.appendChild(item);
      });
      if (!(d.dirs || []).length && !d.parent) {
        list.innerHTML += '<div class="hint">' + L.none2 + '</div>';
      }
      window.__AN.stagger('.wsp-item', list);
      // keyboard: the row that was just activated went away with the previous listing,
      // which drops the focus to the page; park it on the first row of the new listing
      if (!document.getElementById('wspick').contains(document.activeElement)) {
        var first = list.querySelector('.wsp-item');
        if (first) first.focus();
      }
    }).catch(function (e) { list.innerHTML = '<div class="hint err">' + esc(String(e)) + '</div>'; });
  }
  function submitPick() {
    if (!pickPath) return;
    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('wsp-name').value.trim(), path: pickPath })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
      if (!res.ok) { alert(res.d && res.d.error ? res.d.error : 'failed'); return; }
      if (res.d.items) { wsItems = res.d.items; renderWsList(); }
      closePick();
    }).catch(function (e) { alert(String(e)); });
  }
  document.getElementById('wsp-ok').onclick = submitPick;
  document.getElementById('wsp-name').onkeydown = function (e) {
    if (enterConfirmed(e)) submitPick();
  };
`;
