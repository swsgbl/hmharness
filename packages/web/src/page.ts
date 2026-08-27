/**
 * @hmh/web - page (three-column layout, dsh-web inspired)
 * Sidebar (brand / new session / search / session tree) | main (topbar,
 * chat flow, composer-takeover approvals, rich input card) | details
 * (selected tool call: args + full output). Vanilla JS, no build step.
 * Template-literal rules: no raw backticks in the page body (use \u0060),
 * regex backslashes doubled, no ${} inside the page JS (string concat only).
 */
export const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hmh web</title>
<style>
  :root { --bg:#101418; --panel:#171d24; --panel2:#1c242e; --line:#242c36; --text:#dbe4ee; --dim:#7d8b9c;
          --accent:#31a8ff; --ok:#3fb950; --warn:#e3b341; --err:#f85149; --mono:ui-monospace,Consolas,monospace; }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,"Segoe UI",sans-serif; overflow:hidden; }
  #app { display:grid; grid-template-columns:264px 1fr auto; height:100vh; }

  /* ---- sidebar ---- */
  #side { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; min-width:0; }
  #brand { display:flex; align-items:center; gap:8px; padding:12px 14px; cursor:pointer; border-bottom:1px solid var(--line); }
  #brand:hover { background:var(--panel2); }
  #brand .logo { color:var(--accent); font-size:18px; font-weight:700; }
  #brand .ver { color:var(--dim); font-size:11px; }
  #newbtn { margin:10px 12px 6px; }
  #search { margin:4px 12px 8px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:7px;
            padding:6px 9px; font:12.5px inherit; outline:none; width:calc(100% - 24px); }
  #search:focus { border-color:var(--accent); }
  #sesslist { flex:1; overflow-y:auto; padding:2px 6px; }
  #sesslist .grp { font-size:11px; color:var(--dim); padding:8px 8px 4px; text-transform:uppercase; letter-spacing:.08em; }
  .sess { display:block; width:100%; text-align:left; background:none; border:0; color:var(--text); padding:6px 8px; border-radius:7px; cursor:pointer; }
  .sess:hover { background:var(--panel2); }
  .sess .t1 { display:flex; gap:6px; align-items:center; font-size:12.5px; white-space:nowrap; overflow:hidden; }
  .sess .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
  .sess .time { color:var(--dim); font-family:var(--mono); font-size:11px; flex:none; }
  .sess .task { color:var(--dim); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #sidefoot { border-top:1px solid var(--line); padding:8px 14px; font-size:11.5px; color:var(--dim); }

  /* ---- main ---- */
  #main { display:flex; flex-direction:column; min-width:0; }
  #topbar { display:flex; gap:10px; align-items:center; padding:9px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  .chip { font-size:11.5px; padding:2px 9px; border-radius:11px; background:var(--panel2); color:var(--dim); }
  .chip.model { color:var(--accent); }
  #busy { margin-left:auto; font-size:12px; color:var(--dim); }
  #busy.on { color:var(--warn); }
  #log { flex:1; overflow-y:auto; padding:18px 26px; scroll-behavior:smooth; }
  .think { color:var(--dim); font-style:italic; white-space:pre-wrap; }
  .say { white-space:pre-wrap; }
  .say code { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:0 4px; font-family:var(--mono); font-size:12.5px; }
  .say pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.5; }
  .say b { color:#fff; }
  .msg-user { color:var(--text); background:var(--panel2); border-radius:8px; padding:6px 12px; margin:10px 0 6px; white-space:pre-wrap; }
  .msg-user::before { content:"\\276F  "; color:var(--dim); }
  .toolrow { font-family:var(--mono); font-size:12.5px; margin:6px 0 2px; cursor:pointer; padding:3px 6px; border-radius:6px; }
  .toolrow:hover { background:var(--panel2); }
  .toolrow .st { margin-right:7px; }
  .toolrow .st.run { color:var(--warn); }
  .toolrow .st.err { color:var(--err); }
  .toolrow .st.ok { color:var(--ok); }
  .toolrow .nm { color:var(--accent); font-weight:600; }
  .toolres { color:var(--dim); font-family:var(--mono); font-size:12px; white-space:pre-wrap; margin-left:22px; border-left:2px solid var(--line); padding-left:8px; }
  .err { color:var(--err); }
  .stats { color:var(--dim); font-family:var(--mono); font-size:11.5px; border-top:1px dashed var(--line); margin-top:10px; padding-top:6px; }
  #tobot { position:absolute; right:32px; bottom:130px; display:none; }
  #empty { color:var(--dim); text-align:center; margin:auto; max-width:430px; }
  #empty .ex { font-family:var(--mono); font-size:12.5px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:6px 0; cursor:pointer; }
  #empty .ex:hover { border-color:var(--accent); color:var(--text); }

  /* ---- composer (input card / approval takeover) ---- */
  #composer { border-top:1px solid var(--line); background:var(--panel); padding:10px 16px 12px; }
  #approval { display:none; background:#2a2313; border:1px solid var(--warn); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  #approval.pulse { animation:pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 0 rgba(227,179,65,0); } 50% { box-shadow:0 0 0 4px rgba(227,179,65,.25); } }
  #approval .name { color:var(--warn); font-family:var(--mono); }
  #inputcard { display:flex; flex-direction:column; gap:8px; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:var(--bg); }
  #inputcard:focus-within { border-color:var(--accent); }
  textarea { border:0; outline:none; resize:none; background:transparent; color:var(--text); font:inherit; min-height:44px; max-height:160px; }
  #tools-row { display:flex; align-items:center; gap:8px; }
  select { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:4px 8px; font-size:12px; outline:none; cursor:pointer; }
  #tokchip { color:var(--dim); font-family:var(--mono); font-size:11.5px; }
  #send { margin-left:auto; }

  /* ---- details column ---- */
  #details { width:0; overflow:hidden; border-left:1px solid var(--line); background:var(--panel); transition:width .15s ease; display:flex; flex-direction:column; }
  #details.open { width:360px; }
  #dhead { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--line); }
  #dname { color:var(--accent); font-family:var(--mono); font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #dbody { flex:1; overflow-y:auto; padding:12px 14px; font-family:var(--mono); font-size:12px; }
  #dbody h4 { margin:10px 0 4px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  #dbody pre { white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:0; }
  #dempty { color:var(--dim); font-size:12px; margin:auto; text-align:center; padding:0 18px; }
</style>
</head>
<body>
<div id="app">
  <div id="side">
    <div id="brand" title="new session"><span class="logo">hmh</span><span class="ver">web · hmharness</span></div>
    <button id="newbtn" class="primary">＋ <span id="new-label">新会话</span></button>
    <input id="search" placeholder="搜索会话…">
    <div id="sesslist"><div class="grp" id="ph-sessions">最近会话</div><div id="sessions"></div></div>
    <div id="sidefoot"><span id="skills-n">0</span> <span id="skills-label">技能</span> · <span id="model2"></span></div>
  </div>
  <div id="main" style="position:relative;">
    <div id="topbar">
      <span class="chip model" id="model"></span>
      <span class="chip" id="home"></span>
      <span class="chip" id="locale-chip">zh</span>
      <span id="busy">idle</span>
      <button id="clear" class="ghost sm">clear</button>
    </div>
    <div id="log"><div id="empty"><div style="font-size:30px">⚙️</div><div id="empty-title" style="margin:8px 0 4px;font-size:16px">给 hmh 一个任务</div><div id="empty-sub" style="font-size:12.5px">流式输出 · 浏览器审批 · 全程审计</div><div style="margin-top:14px"></div><div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div><div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div><div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div></div>
    <button id="tobot" class="ghost sm">↓</button>
    <div id="composer">
      <div id="approval">
        <div><span id="approval-req-label">审批请求:</span><span class="name" id="ap-name"></span> <span id="ap-args" class="dim" style="font-family:var(--mono);color:var(--dim)"></span></div>
        <div style="margin-top:8px"><button id="ap-yes" class="primary sm">批准</button> <button id="ap-no" class="danger sm">拒绝</button></div>
      </div>
      <div id="inputcard">
        <textarea id="input" placeholder="给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)"></textarea>
        <div id="tools-row">
          <select id="mode" title="approval mode">
            <option value="ask">🔒 审批询问</option>
            <option value="auto">⚡ 自动批准</option>
          </select>
          <span id="tokchip"></span>
          <button id="send" class="primary">运行</button>
        </div>
      </div>
    </div>
  </div>
  <div id="details">
    <div id="dhead"><span id="dname"></span><button id="dclose" class="ghost sm" style="margin-left:auto">✕</button></div>
    <div id="dbody"><div id="dempty">点击对话流中的工具行查看详情</div></div>
  </div>
</div>
<style>
  button.primary { background:var(--accent); color:#08243a; border:0; border-radius:8px; padding:7px 16px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 14px; cursor:pointer; }
  button.ghost.sm, button.primary.sm { padding:3px 10px; font-size:12px; }
  button.danger { background:var(--err); color:#fff; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; }
  button:disabled { opacity:.45; cursor:default; }
</style>
<script>
(function () {
  var log = document.getElementById('log');
  var state = null;
  var L = null;
  var toolRegistry = {};   // seq -> {name, args, output}
  var seq = 0;
  var sessData = [];

  var LABELS = {
    zh: { title:'hmh web', idle:'空闲', running:'运行中…', send:'运行', approve:'批准', deny:'拒绝',
          approvalReq:'审批请求:', skills:'技能', sessions:'最近会话', none2:'(无)',
          placeholder:'给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
          newLabel:'新会话', searchPh:'搜索会话…', skillsN:'技能',
          emptyTitle:'给 hmh 一个任务', emptySub:'流式输出 · 浏览器审批 · 全程审计', alreadyRunning:'已有一个任务在运行',
          dempty:'点击对话流中的工具行查看详情', ask:'🔒 审批询问', auto:'⚡ 自动批准', clear:'清屏' },
    en: { title:'hmh web', idle:'idle', running:'running…', send:'Run', approve:'Approve', deny:'Deny',
          approvalReq:'Approval request:', skills:'skills', sessions:'recent sessions', none2:'(none)',
          placeholder:'give hmh a task… (Enter to send, Shift+Enter for newline)',
          newLabel:'New session', searchPh:'search sessions…', skillsN:'skills',
          emptyTitle:'give hmh a task', emptySub:'streaming · browser approvals · fully audited', alreadyRunning:'a task is already running',
          dempty:'click a tool row in the chat to inspect', ask:'🔒 ask approval', auto:'⚡ auto-approve', clear:'clear' }
  };
  function setLabels(loc) {
    L = LABELS[loc === 'en' ? 'en' : 'zh'];
    document.title = L.title;
    document.getElementById('send').textContent = L.send;
    document.getElementById('ap-yes').textContent = L.approve;
    document.getElementById('ap-no').textContent = L.deny;
    document.getElementById('approval-req-label').textContent = L.approvalReq;
    document.getElementById('clear').textContent = L.clear;
    document.getElementById('input').placeholder = L.placeholder;
    document.getElementById('new-label').textContent = L.newLabel;
    document.getElementById('search').placeholder = L.searchPh;
    document.getElementById('skills-label').textContent = L.skillsN;
    document.getElementById('empty-title').textContent = L.emptyTitle;
    document.getElementById('empty-sub').textContent = L.emptySub;
    document.getElementById('ph-sessions').textContent = L.sessions;
    document.getElementById('dempty').textContent = L.dempty;
    document.getElementById('locale-chip').textContent = loc || 'zh';
    document.getElementById('mode').options[0].text = L.ask;
    document.getElementById('mode').options[1].text = L.auto;
    var badge = document.getElementById('busy');
    badge.textContent = state && state.busy ? L.running : L.idle;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    log.appendChild(e);
    log.scrollTop = log.scrollHeight;
    return e;
  }
  function clearEmpty() {
    var e = document.getElementById('empty');
    if (e) e.remove();
  }
  function mdLite(text) {
    var esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var parts = esc.split(/\\u0060\\u0060\\u0060/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out += '<pre>' + parts[i].replace(/^[a-zA-Z0-9_-]*\\n/, '') + '</pre>';
      } else {
        out += parts[i]
          .replace(/\\u0060([^\\u0060\\n]+)\\u0060/g, '<code>$1</code>')
          .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>');
      }
    }
    return out;
  }
  function sayBlock() {
    clearEmpty();
    var e = el('div', 'say');
    return { add: function (c) { e.textContent += c; }, finalize: function () { e.innerHTML = mdLite(e.textContent); autoscroll(); } };
  }
  function setBusy(b) {
    var badge = document.getElementById('busy');
    badge.textContent = b ? L.running : L.idle;
    badge.className = b ? 'on' : '';
    document.title = b ? '● ' + L.running : L.title;
    document.getElementById('send').disabled = b;
    document.getElementById('input').disabled = b;
  }

  function renderState(s) {
    state = s;
    setLabels(s.locale || 'zh');
    document.getElementById('model').textContent = s.model;
    document.getElementById('model2').textContent = s.model;
    document.getElementById('home').textContent = s.home;
    document.getElementById('skills-n').textContent = s.skills.active.length + s.skills.drafts.length;
  }

  function renderSessions(filter) {
    var box = document.getElementById('sessions');
    box.innerHTML = '';
    var f = (filter || '').toLowerCase();
    sessData.slice(0, 30).forEach(function (s) {
      if (f && (s.id + ' ' + s.task).toLowerCase().indexOf(f) < 0) return;
      var b = document.createElement('button');
      b.className = 'sess';
      b.title = s.id;
      var m = s.id.match(/^(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})/);
      var t1 = document.createElement('div'); t1.className = 't1';
      var dot = document.createElement('span'); dot.className = 'dot';
      var time = document.createElement('span'); time.className = 'time';
      time.textContent = m ? m[1].slice(5) + ' ' + m[2] + ':' + m[3] : s.id.slice(0, 12);
      t1.appendChild(dot); t1.appendChild(time);
      if (s.task) { var tk = document.createElement('span'); tk.style.flex = '1'; tk.style.overflow = 'hidden'; tk.style.textOverflow = 'ellipsis'; tk.textContent = s.task.slice(0, 40); t1.appendChild(tk); }
      b.appendChild(t1);
      if (s.task) { var t2 = document.createElement('div'); t2.className = 'task'; t2.textContent = s.task; b.appendChild(t2); }
      b.onclick = function () { viewSession(s.id); };
      box.appendChild(b);
    });
    if (!box.children.length) box.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px">' + L.none2 + '</div>';
  }
  function loadSessions() {
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      sessData = d.sessions || [];
      renderSessions(document.getElementById('search').value);
    });
  }
  function viewSession(id) {
    flushStream();
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      log.innerHTML = '';
      el('div', 'stats', '--- session ' + d.id + ' · ' + d.model + ' ---');
      d.messages.forEach(function (m) {
        if (m.role === 'user') el('div', 'msg-user', m.text);
        else if (m.role === 'assistant') el('div', m.tools && m.tools.length ? 'toolrow' : 'say', m.text || ('[calls: ' + (m.tools || []).join(', ') + ']'));
        else el('div', 'toolres', m.text);
      });
      el('div', 'stats', '--- end ---');
      log.scrollTop = log.scrollHeight;
    });
  }

  function showDetails(seqId) {
    var d = toolRegistry[seqId];
    if (!d) return;
    document.getElementById('details').classList.add('open');
    document.getElementById('dname').textContent = d.name;
    var body = document.getElementById('dbody');
    body.innerHTML = '';
    var h1 = document.createElement('h4'); h1.textContent = 'input';
    var p1 = document.createElement('pre'); p1.textContent = JSON.stringify(d.args, null, 2);
    var h2 = document.createElement('h4'); h2.textContent = 'output';
    var p2 = document.createElement('pre'); p2.textContent = d.output || '(pending)';
    body.appendChild(h1); body.appendChild(p1); body.appendChild(h2); body.appendChild(p2);
  }
  document.getElementById('dclose').onclick = function () {
    document.getElementById('details').classList.remove('open');
  };

  // ---- streaming state ----
  var curBlock = null;
  var curKind = null;
  function flushStream() {
    if (curBlock) curBlock.finalize();
    curBlock = null;
    curKind = null;
  }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function autoscroll() { if (nearBottom()) log.scrollTop = log.scrollHeight; }
  log.addEventListener('scroll', function () {
    document.getElementById('tobot').style.display = nearBottom() ? 'none' : 'block';
  });
  document.getElementById('tobot').onclick = function () { log.scrollTop = log.scrollHeight; };

  var pendingToolRow = null;   // running tool row awaiting its result
  var es = new EventSource('/api/events');
  es.addEventListener('hello', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('state', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('busy', function (e) {
    var d = JSON.parse(e.data);
    setBusy(d.busy);
    flushStream();
    if (d.busy) { clearEmpty(); el('div', 'msg-user', d.task); }
  });
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    if (curKind !== d.kind) {
      flushStream();
      clearEmpty();
      curKind = d.kind;
      if (d.kind === 'reasoning') {
        var t = el('div', 'think');
        curBlock = { add: function (c) { t.textContent += c; }, finalize: function () {} };
      } else {
        curBlock = sayBlock();
      }
    }
    curBlock.add(d.chunk);
    autoscroll();
  });
  es.addEventListener('line', function (e) { flushStream(); el('div', 'toolres', JSON.parse(e.data).text); autoscroll(); });
  es.addEventListener('tool', function (e) {
    flushStream();
    clearEmpty();
    var d = JSON.parse(e.data);
    seq++;
    toolRegistry[seq] = { name: d.name, args: d.args, output: '' };
    var row = el('div', 'toolrow');
    row.setAttribute('data-seq', String(seq));
    var st = document.createElement('span'); st.className = 'st run'; st.textContent = '\\u25CF';
    var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = d.name;
    var ar = document.createElement('span'); ar.className = 'dim2'; ar.style.color = 'var(--dim)';
    ar.textContent = ' ' + JSON.stringify(d.args).slice(0, 110);
    row.appendChild(st); row.appendChild(nm); row.appendChild(ar);
    var s = seq;
    row.onclick = function () { showDetails(s); };
    pendingToolRow = { seq: s, st: st };
    autoscroll();
  });
  es.addEventListener('toolResult', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    if (pendingToolRow) {
      pendingToolRow.st.className = 'st ' + (d.isError ? 'err' : 'ok');
      pendingToolRow.st.textContent = d.isError ? '\\u2717' : '\\u2022';
      pendingToolRow = null;
    }
    if (toolRegistry[d.seq] === undefined && d.full !== undefined) { /* noop */ }
    // attach output to the most recent matching entry without output
    for (var k in toolRegistry) {
      if (toolRegistry[k].name === d.name && toolRegistry[k].output === '') { toolRegistry[k].output = d.full || d.preview || ''; break; }
    }
    var prev = String(d.preview).slice(0, d.isError ? 160 : 120).split('\\n').join(' ');
    el('div', d.isError ? 'toolres err' : 'toolres', prev);
    autoscroll();
  });
  es.addEventListener('approvalReq', function (e) {
    var d = JSON.parse(e.data);
    document.getElementById('ap-name').textContent = d.name;
    document.getElementById('ap-args').textContent = JSON.stringify(d.args).slice(0, 200);
    var box = document.getElementById('approval');
    box.style.display = 'block';
    box.classList.add('pulse');
  });
  es.addEventListener('approvalDone', function (e) {
    document.getElementById('approval').style.display = 'none';
    document.getElementById('approval').classList.remove('pulse');
    flushStream();
    var d = JSON.parse(e.data);
    el('div', 'toolres', '[approval ' + d.name + ': ' + (d.granted ? 'granted' : 'DENIED') + ']');
  });
  es.addEventListener('final', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    var tok = (d.usage && (d.usage.promptTokens + d.usage.completionTokens) > 0) ? ' · \\u2191' + d.usage.promptTokens + ' \\u2193' + d.usage.completionTokens + ' tok' : '';
    el('div', 'stats', d.turns + ' turns \\u00B7 ' + d.toolUses + ' tool uses' + tok + ' \\u00B7 session ' + d.sessionId.slice(11));
    if (tok) document.getElementById('tokchip').textContent = tok.replace(' \\u00B7 ', '');
    loadSessions();
  });
  es.addEventListener('error', function (e) {
    if (e.data) { flushStream(); el('div', 'err', 'error: ' + JSON.parse(e.data).message); }
  });

  function decide(granted) {
    fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: granted })
    });
    document.getElementById('approval').style.display = 'none';
    document.getElementById('approval').classList.remove('pulse');
  }
  document.getElementById('ap-yes').onclick = function () { decide(true); };
  document.getElementById('ap-no').onclick = function () { decide(false); };

  // ---- composer ----
  document.getElementById('form') && null;
  document.getElementById('send').onclick = function () {
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, yes: document.getElementById('mode').value === 'auto' })
    }).then(function (r) {
      if (r.status === 409) { clearEmpty(); el('div', 'err', L.alreadyRunning); }
      return r.json();
    }).catch(function (err) { clearEmpty(); el('div', 'err', String(err)); });
  };
  document.getElementById('input').onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      document.getElementById('send').click();
    }
  };

  // ---- sidebar actions ----
  function newSession() {
    flushStream();
    log.innerHTML = '<div id="empty"><div style="font-size:30px">⚙️</div><div style="margin:8px 0 4px;font-size:16px">' + L.emptyTitle + '</div><div style="font-size:12.5px">' + L.emptySub + '</div><div style="margin-top:14px"></div>' +
      '<div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div>' +
      '<div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div>' +
      '<div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div>';
    wireExamples();
    document.getElementById('details').classList.remove('open');
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
  document.getElementById('brand').onclick = newSession;
  document.getElementById('clear').onclick = newSession;
  document.getElementById('search').oninput = function () { renderSessions(this.value); };
  wireExamples();

  fetch('/api/state').then(function (r) { return r.json(); }).then(renderState);
  loadSessions();
})();
</script>
</body>
</html>
`;
