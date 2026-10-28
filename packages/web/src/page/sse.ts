/**
 * @hmharness/web - page/sse.ts - SSE 客户端(远程控制 key、事件去重、per-session 路由、busy/delta/tool/toolResult/final 全事件流)与审批卡(并发堆叠/风险徽标/decide)
 * P1-3 拆分自 page.ts(基线 682d4fc 行 2626-3045):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const SSE = `  /* ---- remote-control token plumbing (2026-09-28): the first visit carries
     ?key=<token>; we park it in sessionStorage and attach it to every fetch
     (header) and the SSE stream (query param - EventSource cannot set
     headers). Loopback servers never see any of this. */
  var AUTH_KEY = '';
  try {
    const qk = new URLSearchParams(location.search).get('key');
    if (qk) { sessionStorage.setItem('hmh-key', qk); history.replaceState(null, '', location.pathname); }
    AUTH_KEY = sessionStorage.getItem('hmh-key') || '';
  } catch (e) {}
  var es = new EventSource('/api/events' + (AUTH_KEY ? '?key=' + encodeURIComponent(AUTH_KEY) : ''));
  // reconnect dedup (docx): the server replays missed events via Last-Event-ID;
  // drop anything whose id we already applied (belt-and-braces vs double render)
  var seenEvtIds = {};
  ['busy','delta','line','tool','toolResult','final','queued','approvalReq','approvalDone','injected','error'].forEach(function (evName) {
    es.addEventListener(evName, function (e) {
      var id = e.lastEventId;
      if (id) {
        if (seenEvtIds[id]) { e.stopImmediatePropagation(); return; }
        seenEvtIds[id] = 1;
        var ks = Object.keys(seenEvtIds);
        if (ks.length > 4000) ks.slice(0, 2000).forEach(function (k) { delete seenEvtIds[k]; });
      }
    }, true); // capture: runs BEFORE the per-event handlers below
  });
  // connection lifecycle (docx P1 #2 Recovery First): EventSource retries on
  // its own; surface the state so a dead backend is never silent, and refresh
  // the session list after a reconnect (things may have finished meanwhile)
  var wasConnected = false;
  es.onopen = function () {
    var c = document.getElementById('connchip');
    if (c) c.classList.remove('reconnecting');
    if (wasConnected) { loadSessions(); api('/api/state').then(function (r) { return r.json(); }).then(renderState).catch(function () {}); }
    wasConnected = true;
  };
  es.onerror = function () {
    var c = document.getElementById('connchip');
    if (c) c.classList.add('reconnecting');
  };
  es.addEventListener('hello', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('state', function (e) { renderState(JSON.parse(e.data)); });
  var echoedAt = 0; var echoedTask = '';
  /** Route ONE event into its session's view: sets the active sink so every
   *  el()/thinkBlock()/renderer below writes THAT session's container, never
   *  the shared log. The view is created on demand - even for sessions this
   *  tab never opened (another tab's task) - so nothing is ever lost. */
  function route(sid) {
    var s = (typeof sid === 'string' && sid) ? sid : busySid || curSid || '';
    activeSinkSidVal = s || null;
    if (s) viewFor(s); // ensure the container exists (hidden is fine)
    return s ? views.get(s) : null;
  }
  es.addEventListener('busy', function (e) {
    var d = JSON.parse(e.data);
    var v = route(d.sessionId);
    // W15: track EVERY session's run state; the composer follows the VIEWED
    // session only (mountView re-evaluates on switches)
    if (d.busy) runningSids[d.sessionId] = d.task || true;
    else delete runningSids[d.sessionId];
    refreshAllRunBadges();
    var mine = d.sessionId === curSid || (!curSid && d.busy);
    setBusy(!!mine && d.busy, d.mode);
    if (d.busy) {
      busySid = d.sessionId || '';
      if (v) {
        if (d.cwd) v.cwd = d.cwd;
        // per-task state reset: deliverables must not leak into the next task
        v.deliverables = [];
        v.planSeenRun = false; // run-state 2.0: the planning phase re-arms per run
        v.turnVerify = 0; // Turn Card: the Verify segment re-arms per run
        hudData.verify = 0; hudData.recovering = 0; hudData.phase = ''; updateHud(); // HUD re-arms per run
        closeToolGroup(v);
      }
      if (d.cwd && curSid === busySid) updateTopbarCwd();
    } else {
      busySid = '';
    }
    flushStream();
    // echo the running task as a user bubble so OTHER tabs see it too; the
    // submitting tab already painted it in sendTask (dedup within 3s)
    if (d.busy && d.task && v) {
      v.lastTask = d.task;
      var now = Date.now();
      if (!(d.task === echoedTask && now - echoedAt < 3000)) {
        echoedTask = d.task; echoedAt = now;
        clearEmpty();
        el('div', 'msg-user', d.task);
      }
    }
  });
  es.addEventListener('queued', function (e) {
    var d = JSON.parse(e.data);
    el('div', 'queued', (L.queuedHint || 'queued') + ' #' + d.position + ' \u2014 ' + d.task, true);
  });
  es.addEventListener('queue', function (e) {
    var d = JSON.parse(e.data);
    // W15: per-session queue events only book-keep; the FLAT event (no
    // sessionId, all sessions concatenated) is what the bar renders
    if (d.sessionId) {
      var qv = views.get(d.sessionId);
      if (qv) qv.queue = d.items || [];
      return;
    }
    renderQueue(d.items || []);
  });
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    var v = route(d.sessionId);
    if (!v) return;
    if (d.kind === 'reset') {
      // provider retried after a mid-stream cut: drop the half answer so the
      // regenerated text is not shown as a duplicate
      taskPhaseEvent('recovering', 'retry'); // run-state 2.0: the recovery phase is visible, not silent
      hudData.recovering = (hudData.recovering || 0) + 1; hudData.phase = 'recovering'; updateHud();
      if (v.curBlock && v.curBlock.discard) v.curBlock.discard();
      v.curBlock = null; v.curKind = null;
      return;
    }
    if (v.curKind !== d.kind) {
      flushStream();
      clearEmpty();
      closeToolGroup(v); // model text after a tool run settles the group
      v.curKind = d.kind;
      v.curBlock = d.kind === 'reasoning' ? thinkBlock() : sayBlock();
      taskPhaseEvent(d.kind === 'reasoning' ? 'thinking' : 'responding');
    }
    v.curBlock.add(d.chunk);
  });
  es.addEventListener('line', function (e) {
    var d = JSON.parse(e.data);
    route(d.sessionId);
    flushStream();
    el('div', 'toolres', d.text);
    safeAutoscroll();
  });
  // 2026-09-25 consecutive-tool grouping: a run of tool calls with no model
  // text between them collapses into ONE group row ("N tool calls · names"),
  // showing only the LIVE call while running and folding the rest. The
  // summary stays one line however long the run - a 10-call command spree
  // used to bury the conversation under 20+ rows. (All state per-view.)
  function closeToolGroup(v) {
    if (v && v.parBox) { v.parBox.classList.add('settled'); setGroupVisible(v.parBox, false); }
    if (v) { v.parBox = null; v.parCount = 0; }
  }
  function setGroupVisible(box, open) {
    box.classList.toggle('open', open);
    for (var i = 0; i < box.children.length; i++) {
      var ch = box.children[i];
      if (ch.classList && ch.classList.contains('toolrow')) ch.style.display = open ? '' : 'none';
    }
  }
  function groupLabel(n, names) {
    var counts = {};
    Object.keys(names).forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
    var parts = Object.keys(counts).map(function (k) { return k + '\\u00D7' + counts[k]; });
    return '\\u25CF ' + n + ' ' + (L.toolGroupCalls || '个工具调用') + ' \\u00B7 ' + parts.slice(0, 4).join(' ') + (parts.length > 4 ? ' \\u2026' : '') + ' \\u00B7 ' + (L.toolGroupToggle || '点击展开');
  }
  es.addEventListener('tool', function (e) {
    var d = JSON.parse(e.data);
    var v = route(d.sessionId);
    if (!v) return;
    flushStream();
    clearEmpty();
    v.seq++;
    v.toolRegistry[v.seq] = { name: d.name, args: d.args, output: '' };
    var row = el('div', 'toolrow');
    row.setAttribute('data-seq', String(v.seq));
    var st = document.createElement('span'); st.className = 'st run'; st.textContent = '\\u25CF';
    var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = d.name;
    var ar = document.createElement('span'); ar.className = 'dim2'; ar.style.color = 'var(--dim)';
    ar.textContent = ' ' + JSON.stringify(d.args).slice(0, 110);
    row.appendChild(st); row.appendChild(nm); row.appendChild(ar);
    // A7: spawn_agent renders as a distinct nested card (accent border + name)
    if (d.name === 'spawn_agent') row.classList.add('subagent');
    // A9: remember touched files for the deliverables chips at 'final'
    if (d.name === 'edit_file' || d.name === 'write_file') {
      var p0 = d.args && d.args.path;
      if (typeof p0 === 'string' && p0) v.deliverables.push({ name: d.name, args: { path: p0 } });
    }
    var s = v.seq;
    row.onclick = function () { showDetailsIn(v, s); };
    // run-state 2.0: verification-shaped tools light their own phase (and
    // feed the Turn Card's Verify segment + the Cognitive HUD's verify count)
    if (typeof classifyToolPhase === 'function' && classifyToolPhase(d.name) === 'verifying') {
      v.turnVerify = (v.turnVerify || 0) + 1;
      hudData.verify = v.turnVerify; hudData.phase = 'verifying'; updateHud();
    }
    taskPhaseEvent(typeof classifyToolPhase === 'function' ? classifyToolPhase(d.name) : 'executing', d.name);
    v.parCount++;
    v.groupNames[d.name] = (v.groupNames[d.name] || 0) + 1;
    if (v.parCount === 2 && !v.parBox) {
      // second CONSECUTIVE call: retroactively group the previous row too.
      // Walk THIS view root's direct children backwards for the last tool row.
      v.parBox = document.createElement('div');
      v.parBox.className = 'pargrp rungrp';
      var pl = document.createElement('div');
      pl.className = 'plabel glabel';
      pl.style.cursor = 'pointer';
      v.parBox.appendChild(pl);
      v.parBox.__label = pl;
      pl.onclick = function (ev) {
        ev.stopPropagation();
        setGroupVisible(v.parBox, !v.parBox.classList.contains('open'));
      };
      var first = null;
      for (var li = v.root.children.length - 1; li >= 0; li--) {
        var lc = v.root.children[li];
        if (lc.classList && lc.classList.contains('toolrow')) { first = lc; break; }
      }
      if (first && first.parentElement === v.root) {
        v.root.insertBefore(v.parBox, first);
        v.parBox.appendChild(first);
      } else { v.root.appendChild(v.parBox); }
      v.groupNames = {};
      // recount from the rows actually inside the group
      for (var gi = 0; gi < v.parBox.children.length; gi++) {
        var gr = v.parBox.children[gi];
        if (gr.classList && gr.classList.contains('toolrow')) {
          var gn = gr.querySelector('.nm');
          if (gn) v.groupNames[gn.textContent] = (v.groupNames[gn.textContent] || 0) + 1;
        }
      }
      v.groupNames[d.name] = (v.groupNames[d.name] || 0) + 1;
    }
    if (v.parBox) {
      // fold the PREVIOUS row; only the live call stays visible
      for (var pi = 0; pi < v.parBox.children.length; pi++) {
        var pr = v.parBox.children[pi];
        if (pr.classList && pr.classList.contains('toolrow')) pr.style.display = v.parBox.classList.contains('open') ? '' : 'none';
      }
      v.parBox.appendChild(row);
      v.parBox.__label.textContent = groupLabel(v.parBox.querySelectorAll('.toolrow').length, v.groupNames);
      row.style.display = '';
    } else {
      v.root.appendChild(row);
    }
    v.pendingToolRow = { seq: s, st: st, row: v.parBox || row };
    safeAutoscroll();
  });
  es.addEventListener('toolResult', function (e) {
    var d = JSON.parse(e.data);
    var v = route(d.sessionId);
    if (!v) return;
    flushStream();
    if (v.pendingToolRow) {
      v.pendingToolRow.st.className = 'st ' + (d.isError ? 'err' : 'ok');
      v.pendingToolRow.st.textContent = d.isError ? '\\u2717' : '\\u2022';
      v.pendingToolRow = null;
      // the group stays OPEN for the next consecutive call; it closes on
      // model text / final / the next user task
    }
    // attach output to the most recent matching entry without output
    for (var k in v.toolRegistry) {
      if (v.toolRegistry[k].name === d.name && v.toolRegistry[k].output === '') { v.toolRegistry[k].output = d.full || d.preview || ''; break; }
    }
    // keyed views (A4); default keeps W1: fold to one line, click to expand
    if (!d.isError && (d.name === 'edit_file' || d.name === 'write_file') && looksLikeDiff(d.full || d.preview || '')) {
      renderDiff(d);
      return;
    }
    if (d.name === 'web_search') renderSearchCards(d);
    foldToolResult(d);
  });
  var apQueue = [];               // W15: concurrent approvals, stacked
  es.addEventListener('approvalReq', function (e) {
    var d = JSON.parse(e.data);
    apQueue.push(d);
    if (document.getElementById('approval').style.display === 'block') return; // card busy: stacked, shown next
    showApprovalCard(d);
  });
  function showApprovalCard(d) {
    document.getElementById('ap-name').textContent = d.name;
    document.getElementById('ap-args').textContent = JSON.stringify(d.args).slice(0, 200);
    var box = document.getElementById('approval');
    box.style.display = 'block';
    box.classList.add('pulse');
    box.dataset.sid = d.sessionId || '';
    box.dataset.pending = String(apQueue.length - 1); // others still queued
    window.__AN.popIn(box);
    taskPhaseEvent('waitingApproval');
    renderApprovalMeta(d);
  }
  es.addEventListener('approvalDone', function (e) {
    var d = JSON.parse(e.data);
    // only the card's OWN resolution hides it (other sessions' approvals
    // resolve independently now)
    var box = document.getElementById('approval');
    if (box.style.display === 'block' && (!box.dataset.sid || box.dataset.sid === String(d.sessionId))) {
      box.style.display = 'none';
      box.classList.remove('pulse');
      apQueue.shift();
      if (apQueue.length) showApprovalCard(apQueue[0]);
    }
    route(d.sessionId);
    flushStream();
    el('div', 'toolres', '[approval ' + d.name + ': ' + (d.granted ? 'granted' : 'DENIED') + ']');
  });
  es.addEventListener('final', function (e) {
    var d = JSON.parse(e.data);
    var v = route(d.sessionId);
    if (!v) return;
    flushStream();
    window.__lastTaskOk = true; // run-state 2.0 terminal flash source
    closeToolGroup(v); // settle any trailing tool run into its folded group
    // Turn Card (UX pack 03: Request -> Plan -> Actions -> Verification ->
    // Answer): a compact five-segment summary of the COMPLETED turn, so the
    // first glance answers "what did I ask, what happened, was it checked".
    // Data comes from what this view already tracked; nothing new is parsed.
    try {
      var planN = (v.planText && typeof extractPlan === 'function') ? extractPlan(v.planText).length : 0;
      var turn = document.createElement('div'); turn.className = 'turncard';
      var seg = function (k, val, strong) {
        var s = document.createElement('span'); s.className = 'tseg' + (strong ? ' strong' : '');
        var lab = document.createElement('span'); lab.className = 'tlab'; lab.textContent = k;
        var num = document.createElement('span'); num.className = 'tnum'; num.textContent = val;
        s.appendChild(lab); s.appendChild(num); return s;
      };
      var en = L && L.localeKey === 'en';
      var reqTxt = (v.lastTask || '').slice(0, 60) || '-';
      var req = seg(en ? 'Request' : '请求', reqTxt, false); req.title = v.lastTask || '';
      turn.appendChild(req);
      turn.appendChild(seg(en ? 'Plan' : '计划', String(planN || '-'), planN > 0));
      turn.appendChild(seg(en ? 'Actions' : '动作', String(d.toolUses || 0), false));
      turn.appendChild(seg(en ? 'Verify' : '验证', String(v.turnVerify || 0), (v.turnVerify || 0) > 0));
      turn.appendChild(seg(en ? 'Answer' : '回答', (d.turns || 0) + (en ? 't' : '轮'), true));
      v.root.appendChild(turn);
    } catch (err) { /* the turn card is decoration - never break the final */ }
    // A6 plan card + A9 deliverables + A10 feedback ride the final event
    if (v.lastAssistantText) renderPlanCard(v, v.lastAssistantText);
    renderDeliverables(v);
    var tok = (d.usage && (d.usage.promptTokens + d.usage.completionTokens) > 0) ? ' \\u00B7 \\u2191' + d.usage.promptTokens + ' \\u2193' + d.usage.completionTokens + ' tok' : '';
    el('div', 'stats', d.turns + ' turns \\u00B7 ' + d.toolUses + ' tool uses' + tok + ' \\u00B7 session ' + String(d.sessionId).slice(11));
    if (tok) document.getElementById('tokchip').textContent = tok.replace(' \\u00B7 ', '');
    if (v.lastAssistantText && v.lastTask) {
      var acts = document.createElement('div'); acts.className = 'acts';
      var bc = document.createElement('button'); bc.type = 'button'; bc.textContent = '\\u29C9 ' + L.copy;
      bc.onclick = function () { copyText(v.lastAssistantText); bc.textContent = '\\u2713'; setTimeout(function () { bc.textContent = '\\u29C9 ' + L.copy; }, 1200); };
      var br = document.createElement('button'); br.type = 'button'; br.textContent = '\\u27F3 ' + L.regen;
      br.onclick = function () { sendTask(v.lastTask, v.sid); };
      var sessionId = d.sessionId;
      var fbUp = document.createElement('button'); fbUp.type = 'button'; fbUp.className = 'fb'; fbUp.textContent = '\\uD83D\\uDC4D';
      fbUp.title = L ? L.fbUp : 'helpful';
      fbUp.onclick = function () {
        fbUp.classList.add('on'); fbDown.classList.remove('on');
        fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, thumbs: 'up', text: v.lastAssistantText.slice(0, 200) }) });
      };
      var fbDown = document.createElement('button'); fbDown.type = 'button'; fbDown.className = 'fb'; fbDown.textContent = '\\uD83D\\uDC4E';
      fbDown.title = L ? L.fbDown : 'not helpful';
      fbDown.onclick = function () {
        fbDown.classList.add('on'); fbUp.classList.remove('on');
        fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, thumbs: 'down', text: v.lastAssistantText.slice(0, 200) }) });
      };
      acts.appendChild(fbUp); acts.appendChild(fbDown);
      acts.appendChild(bc); acts.appendChild(br);
      v.root.appendChild(acts);
      safeAutoscroll();
    }
    loadSessions();
  });
  es.addEventListener('injected', function (e) {
    flushStream();
    clearEmpty();
    el('div', 'msg-inject', '\\u21AA ' + (L ? L.injected : 'injected') + ': ' + JSON.parse(e.data).text);
  });
  es.addEventListener('error', function (e) {
    if (e.data) {
      flushStream();
      window.__lastTaskOk = false; // run-state 2.0 terminal flash source
      taskPhaseEvent('failed', String(JSON.parse(e.data).message || '').slice(0, 60)); // run-state 2.0 terminal state
      el('div', 'err', 'error: ' + JSON.parse(e.data).message);
    }
  });

  /** Approval risk badge (docx P1 #3): what it does + impact + risk level in
   *  plain language. The risk tier is a static per-tool heuristic; the real
   *  gate stays server-side (this NEVER replaces the approval logic). */
  var TOOL_RISK = {
    run_command: 'high', write_file: 'medium', edit_file: 'medium',
    delete_file: 'high', web_fetch: 'low', web_search: 'low',
    read_file: 'low', list_dir: 'low', spawn_agent: 'medium',
  };
  function renderApprovalMeta(d) {
    var box = document.getElementById('approval');
    var meta = document.getElementById('ap-meta');
    if (!box || !meta) return;
    var risk = TOOL_RISK[d.name] ?? 'medium';
    var riskTxt = { low: { zh: '低风险', en: 'low' }, medium: { zh: '中风险', en: 'medium' }, high: { zh: '高风险', en: 'high' } }[risk];
    var en = L && L.localeKey === 'en';
    // plain-language what-it-does for the common gates
    var does = { zh: '', en: '' };
    if (d.name === 'run_command') { does.zh = '将在你的电脑上执行命令'; does.en = 'will run a command on your machine'; }
    else if (d.name === 'write_file' || d.name === 'edit_file') { does.zh = '将修改工作区文件'; does.en = 'will modify a workspace file'; }
    else if (d.name === 'delete_file') { does.zh = '将删除文件'; does.en = 'will delete a file'; }
    else if (d.name === 'web_fetch') { does.zh = '将访问外部网址'; does.en = 'will fetch an external URL'; }
    else if (d.name === 'spawn_agent') { does.zh = '将启动子代理'; does.en = 'will spawn a sub-agent'; }
    meta.innerHTML = '';
    var b = document.createElement('span');
    b.className = 'riskbadge ' + risk;
    b.textContent = en ? riskTxt.en : riskTxt.zh;
    meta.appendChild(b);
    if (does.zh || does.en) {
      var t = document.createElement('span');
      t.style.cssText = 'margin-left:8px;color:var(--dim);font-size:12px';
      t.textContent = en ? does.en : does.zh;
      meta.appendChild(t);
    }
  }

  function decide(granted) {
    var box = document.getElementById('approval');
    api('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: granted, sessionId: box.dataset.sid || undefined })
    });
    box.style.display = 'none';
    box.classList.remove('pulse');
  }
  document.getElementById('ap-yes').onclick = function () { decide(true); };
  document.getElementById('ap-no').onclick = function () { decide(false); };
`;
