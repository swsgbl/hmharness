/**
 * @hmharness/web - page/settings.ts - 设置中心(providers 增删改表单/内置预设/常规项保存)与 RL 奖励标注视图
 * P1-3 拆分自 page.ts(基线 682d4fc 行 1794-2029):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const SETTINGS = `  /* ---- settings view (A1): providers CRUD + general settings ----
     Every save rewrites config.json in place server-side and hot-swaps the
     in-memory cfg (same pattern as /api/locale); apiKey is never echoed back
     full — only hasKey + last 4 chars. No restart needed. */
  function renderSettings() {
    if (!state) return;
    var box = document.getElementById('prov-list');
    box.innerHTML = '';
    (state.providersDetail || []).forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'provrow';
      var main = document.createElement('div');
      main.className = 'pmain';
      var nm = document.createElement('div');
      nm.className = 'pnm';
      nm.textContent = p.name;
      var meta = document.createElement('div');
      meta.className = 'pmeta';
      meta.textContent = p.baseUrl + ' \\u00B7 ' + p.model;
      meta.title = meta.textContent;
      var key = document.createElement('div');
      key.className = 'pkey' + (p.hasKey ? '' : ' none');
      key.textContent = p.hasKey ? L.provApiKeySet + ' \\u00B7\\u00B7\\u00B7' + (p.keyTail || '') : L.provApiKeyNone;
      var pur = document.createElement('span');
      pur.className = 'ppur';
      pur.textContent = (p.purposes || []).join('/') || '-';
      main.appendChild(nm); main.appendChild(meta); main.appendChild(key);
      var acts = document.createElement('div');
      acts.className = 'pacts';
      var ed = document.createElement('button');
      ed.className = 'ghost sm'; ed.type = 'button'; ed.textContent = L.provEdit;
      ed.onclick = function () { openProvForm(p); };
      var del = document.createElement('button');
      del.className = 'danger sm'; del.type = 'button'; del.textContent = L.provDelete;
      del.onclick = function () {
        if (!window.confirm(L.provDeleteConfirm)) return;
        fetch('/api/providers/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) { if (res.d && res.d.error) alert(errText(res.d)); })
          .catch(function (e) { alert(String(e)); });
      };
      acts.appendChild(ed); acts.appendChild(del);
      row.appendChild(main); row.appendChild(pur); row.appendChild(acts);
      box.appendChild(row);
    });
    var pre = document.getElementById('prov-presets');
    pre.innerHTML = '';
    (state.providerPresets || []).forEach(function (p) {
      var r = document.createElement('div');
      r.className = 'presetrow';
      var nm = document.createElement('span'); nm.className = 'pm'; nm.textContent = p.name + ' \\u00B7 ' + p.model;
      var env = document.createElement('span'); env.className = 'penv';
      env.textContent = p.local ? L.presetLocal : L.presetEnv + ' ' + p.envVar;
      var add = document.createElement('button'); add.className = 'ghost sm'; add.type = 'button'; add.textContent = L.provAddPreset;
      add.onclick = function () {
        fetch('/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '' }) })
          .then(function (r2) { return r2.json().then(function (d2) { return { ok: r2.ok, d2: d2 }; }); })
          .then(function (res) { if (res.d2 && res.d2.error) alert(res.d2.error); })
          .catch(function (e) { alert(String(e)); });
      };
      r.appendChild(nm); r.appendChild(env); r.appendChild(add);
      pre.appendChild(r);
    });
    var s = state.settings || {};
    document.getElementById('set-locale').value = state.locale || 'zh';
    document.getElementById('set-approval').value = s.approval || 'ask';
    document.getElementById('set-evolve').value = String(s.autoEvolveEvery === undefined ? 3 : s.autoEvolveEvery);
    document.getElementById('set-patch').checked = s.autoPatch === true;
  }

  /* ---- RL reward labeling view (gate condition 3: 100 human scores) ---- */
  function labelProgress(n, goal) {
    var el = document.getElementById('label-prog');
    if (!el) return;
    el.textContent = (L ? '' : '') + n + ' / ' + goal + (n >= goal ? ' \u2014 ' + (L ? L.labelDone : '') : '');
  }
    function renderLabels() {
    var box = document.getElementById('label-body');
    if (!box) return;
    var hint = document.getElementById('label-hint');
    if (hint) hint.textContent = L ? L.labelHint : '';
    fetch('/api/label/list').then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { box.textContent = d.error; return; }
      labelProgress(d.labeled || 0, d.goal || 100);
      box.innerHTML = '';
      var list = d.sessions || [];
      if (!list.length) {
        var e0 = document.createElement('div');
        e0.className = 'hint';
        e0.textContent = L ? L.labelEmpty : '(empty)';
        box.appendChild(e0);
        return;
      }
      list.forEach(function (it) {
        var card = document.createElement('div');
        card.className = 'setrow';
        card.style.cssText = 'align-items:flex-start;gap:10px';
        var txt = document.createElement('div');
        txt.style.flex = '1';
        var t1 = document.createElement('div');
        t1.style.cssText = 'font-size:12.5px;color:var(--text)';
        t1.textContent = zhTask(it.task);
        txt.appendChild(t1);
        if (it.answer) {
          var ta = document.createElement('div');
          ta.style.cssText = 'font-size:11.5px;color:var(--dim);font-family:var(--mono);white-space:pre-wrap;word-break:break-all;max-height:110px;overflow:hidden;margin-top:2px';
          ta.textContent = (L ? L.labelAnswer : '\u56DE\u7B54: ') + it.answer;
          ta.title = it.answer;
          txt.appendChild(ta);
        }
        var t2 = document.createElement('div');
        t2.style.cssText = 'font-size:10.5px;color:var(--dim);font-family:var(--mono)';
        t2.textContent = it.session.slice(0, 18) + (it.outcome ? ' \u00B7 ' + it.outcome : '') + (it.toolUses ? ' \u00B7 ' + it.toolUses + ' tools' : '');
        txt.appendChild(t2);
        card.appendChild(txt);
        for (var sc = 1; sc <= 5; sc++) {
          (function (score) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ghost sm';
            b.textContent = '\u2605' + score;
            b.title = score + '/5';
            b.onclick = function () {
              b.disabled = true;
              fetch('/api/label', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: it.session, score: score })
              }).then(function (r) { return r.json(); }).then(function (d2) {
                if (d2.error) { b.disabled = false; return; }
                card.style.transition = 'opacity .3s';
                card.style.opacity = '0';
                setTimeout(function () { card.remove(); }, 300);
                labelProgress(d2.labeled || 0, d2.goal || 100);
                if (!(d.sessions || []).some(function (x) { return x.session !== it.session; })) renderLabels();
              });
            };
            card.appendChild(b);
          })(sc);
        }
        box.appendChild(card);
      });
    });
  }
  function provField(lbl, id, val, type, ph) {
    var wrap = document.createElement('div');
    var l = document.createElement('label');
    l.textContent = lbl;
    var i = document.createElement('input');
    i.type = type || 'text';
    i.id = id;
    i.value = val || '';
    if (ph) i.placeholder = ph;
    wrap.appendChild(l); wrap.appendChild(i);
    return { wrap: wrap, input: i };
  }
  function openProvForm(p) {
    // close any open form first (one form at a time)
    var old = document.getElementById('prov-form');
    if (old) old.remove();
    var box = document.getElementById('prov-list');
    var form = document.createElement('div');
    form.className = 'provform';
    form.id = 'prov-form';
    var grid = document.createElement('div');
    grid.className = 'fgrid';
    var isNew = !p;
    var fName = provField(L.provName, 'pf-name', p ? p.name : '', 'text');
    if (!isNew) { fName.input.readOnly = true; fName.input.style.opacity = '.6'; }
    var fBase = provField(L.provBaseUrl, 'pf-base', p ? p.baseUrl : '', 'text', 'https://api.example.com/v1');
    var fModel = provField(L.provModel, 'pf-model', p ? p.model : '', 'text', 'model-id');
    var fKey = provField(L.provApiKey, 'pf-key', '', 'password', isNew ? L.provKeyPhNew : L.provKeyPhEdit);
    var fAuth = provField(L.provAuthHeader, 'pf-auth', (p && p.authHeader) || '', 'text', 'X-Api-Key');
    var fVis = provField(L.provSupportsVision, 'pf-vis', '', 'checkbox');
    if (p && p.supportsVision) fVis.input.checked = true;
    fVis.wrap.style.display = 'flex'; fVis.wrap.style.gap = '6px'; fVis.wrap.style.alignItems = 'center';
    fVis.wrap.style.gridColumn = '1 / 3';
    fVis.input.style.width = 'auto';
    grid.appendChild(fName.wrap); grid.appendChild(fBase.wrap); grid.appendChild(fModel.wrap);
    grid.appendChild(fKey.wrap); grid.appendChild(fAuth.wrap); grid.appendChild(fVis.wrap);
    var acts = document.createElement('div');
    acts.style.marginTop = '10px';
    acts.style.display = 'flex';
    acts.style.gap = '8px';
    var save = document.createElement('button');
    save.className = 'primary sm'; save.type = 'button'; save.textContent = L.provSave;
    var cancel = document.createElement('button');
    cancel.className = 'ghost sm'; cancel.type = 'button'; cancel.textContent = L.provCancel;
    save.onclick = function () {
      var name = fName.input.value.trim();
      var base = fBase.input.value.trim();
      var model = fModel.input.value.trim();
      if (!name || !base || !model) { alert(L.provName + '/' + L.provBaseUrl + '/' + L.provModel + ' required'); return; }
      var payload = { name: name, baseUrl: base, model: model };
      var kv = fKey.input.value;
      if (kv === ' ') payload.apiKey = '';
      else if (kv !== '') payload.apiKey = kv;
      if (fAuth.input.value.trim()) payload.authHeader = fAuth.input.value.trim();
      payload.supportsVision = fVis.input.checked;
      fetch('/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) { if (res.d && res.d.error) alert(errText(res.d)); })
        .catch(function (e) { alert(String(e)); });
    };
    cancel.onclick = function () { form.remove(); };
    acts.appendChild(save); acts.appendChild(cancel);
    form.appendChild(grid); form.appendChild(acts);
    box.insertBefore(form, box.firstChild);
    window.__AN.popIn(form);
  }
  document.getElementById('prov-add').onclick = function () { openProvForm(null); };
  document.getElementById('set-save').onclick = function () {
    var msg = document.getElementById('set-msg');
    msg.className = '';
    msg.textContent = '';
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locale: document.getElementById('set-locale').value,
        approval: document.getElementById('set-approval').value,
        autoEvolveEvery: Number(document.getElementById('set-evolve').value) || 0,
        autoPatch: document.getElementById('set-patch').checked
      })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || (res.d && res.d.error)) {
          msg.className = 'err';
          msg.textContent = L.setFailed + ': ' + ((res.d && res.d.error) || '');
        } else {
          msg.textContent = L.setSaved;
          setTimeout(function () { msg.textContent = ''; }, 2500);
        }
      })
      .catch(function (e) { msg.className = 'err'; msg.textContent = L.setFailed + ': ' + String(e); });
  };
`;
