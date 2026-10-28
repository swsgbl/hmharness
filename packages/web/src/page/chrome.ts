/**
 * @hmharness/web - page/chrome.ts - 顶栏杂项:locale 切换、主题三态、权限预设弹层、会话目标 chip、计划卡、交付物 chips
 * P1-3 拆分自 page.ts(基线 682d4fc 行 3047-3185):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const CHROME = `  // ---- locale switch (persisted server-side; SSE state fans the new locale back) ----
  document.getElementById('locale-chip').onclick = function () {
    var next = this.textContent === 'zh' ? 'en' : 'zh';
    fetch('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next })
    });
  };

  // ---- A11 theme (dark/light/system; CSS tokens only, persisted) ----
  function applyTheme(mode) {
    document.body.setAttribute('data-theme', mode || 'dark');
    var chip = document.getElementById('theme-chip');
    chip.textContent = mode === 'light' ? '☀' : mode === 'system' ? '◐' : '🌓';
  }
  document.getElementById('theme-chip').onclick = function () {
    var cur = (state && state.settings && state.settings.theme) || 'dark';
    var next = cur === 'dark' ? 'light' : cur === 'light' ? 'system' : 'dark';
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
    applyTheme(next);
  };

  // ---- A8 permission presets (ask/auto/yolo cards with danger notes) ----
  var presetBtn = document.getElementById('preset-btn');
  var presetPop = document.getElementById('presetpop');
  presetBtn.onclick = function (ev) { ev.stopPropagation(); presetPop.classList.toggle('on'); };
  Array.prototype.forEach.call(presetPop.querySelectorAll('.preset'), function (b) {
    b.onclick = function () {
      var modeSel = document.getElementById('mode');
      modeSel.value = b.getAttribute('data-mode');
      presetPop.classList.remove('on');
      if (modeSel.onchange) modeSel.onchange();
    };
  });
  document.addEventListener('click', function () { presetPop.classList.remove('on'); });

  // ---- A6 session goal (chip toggles the goal row; shared kernel store) ----
  var goalChip = document.getElementById('goal-chip');
  var goalRow = document.getElementById('goalrow');
  goalChip.onclick = function () {
    goalRow.style.display = goalRow.style.display === 'none' ? 'flex' : 'none';
    if (goalRow.style.display === 'flex') {
      var inp = document.getElementById('goal-input');
      inp.placeholder = L ? L.goalPh : '会话目标';
      // strip the display prefix - editing must not bake '\\uD83C\\uDFAF ' into the saved goal
      inp.value = (state && state.goal) ? state.goal : '';
      inp.focus();
    }
  };
  document.getElementById('goal-set').onclick = function () {
    var v = document.getElementById('goal-input').value.trim();
    fetch('/api/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: v, sessionId: curSid || '' })
    });
    goalRow.style.display = 'none';
  };
  document.getElementById('goal-clear').onclick = function () {
    fetch('/api/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '', sessionId: curSid || '' })
    });
    goalRow.style.display = 'none';
  };

  // ---- A6 plan card (checkable numbered-step list pinned at the top) ----
  /** Plan card renders INTO the session's own container (per-view state);
   *  the one pinned #plancard element shows the CURRENT session's plan and is
   *  refreshed on mount. */
  function renderPlanCard(v, text) {
    v.planText = text || '';
    if (activeSinkSidVal === curSid) renderPlanCardInto(v);
  }
  function renderPlanCardInto(v) {
    var card = document.getElementById('plancard');
    if (!v || !v.planText) { if (card) card.style.display = 'none'; return; }
    var steps = extractPlan(v.planText);
    if (steps.length === 0) { card.style.display = 'none'; return; }
    var title = document.getElementById('plancard-title');
    title.textContent = (L ? L.planCard : '计划') + ' (' + steps.length + ')';
    var box = document.getElementById('plancard-steps');
    box.innerHTML = '';
    steps.forEach(function (st) {
      var row = document.createElement('label'); row.className = 'pstep';
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.onchange = function () { row.classList.toggle('done', cb.checked); };
      var sp = document.createElement('span'); sp.textContent = st;
      row.appendChild(cb); row.appendChild(sp);
      box.appendChild(row);
    });
    card.style.display = 'block';
    var logBox = document.getElementById('log');
    if (card.parentNode !== logBox) logBox.parentNode.insertBefore(card, logBox);
  }

  // ---- A9 deliverables chips (edit_file/write_file paths -> preview) ----
  function renderDeliverables(v) {
    var paths = extractDeliverables(v.deliverables);
    if (paths.length === 0) return;
    var box = document.createElement('div');
    box.id = 'deliv';
    // deliverable summary (docx Web 专项): the task-end card names WHAT was
    // produced so the next action (review/open) is one click away
    var head = document.createElement('div');
    head.style.cssText = 'font-size:11px;color:var(--dim);margin:6px 0 2px';
    head.textContent = (L && L.localeKey === 'en')
      ? '\\u{1F4E6} Deliverables (' + paths.length + ') - click to preview'
      : '\\u{1F4E6} 本次产出 ' + paths.length + ' 个文件 - 点击预览';
    box.appendChild(head);
    var wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '6px';
    paths.forEach(function (p) {
      var chip = document.createElement('span');
      chip.className = 'deliv';
      chip.textContent = p.split(/[\\\\/]/).pop();
      chip.title = p;
      chip.onclick = function () { openPreview(p); };
      wrap.appendChild(chip);
    });
    box.appendChild(wrap);
    var stats = v.root.querySelector('.stats');
    if (stats) v.root.insertBefore(box, stats); else v.root.appendChild(box);
  }
  /** A6/A9: extractPlan and extractDeliverables are the tested uilite
   *  functions injected above — no page-local copies. */
  es.addEventListener('goal', function (e) {
    var g = JSON.parse(e.data).goal;
    var gc = document.getElementById('goal-chip');
    if (g) { gc.style.display = ''; gc.textContent = '\\uD83C\\uDFAF ' + g; gc.title = g; }
    else { gc.style.display = 'none'; }
    if (state) state.goal = g || null;
  });
`;
