/**
 * @hmh/web - page
 * The whole frontend as one embedded HTML string: no build step, no assets,
 * no dependencies. Vanilla JS over fetch + EventSource. Keep this file free
 * of backticks and template-literal syntax in the page body (it is exported
 * inside a template literal).
 */
export const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hmh web</title>
<style>
  :root { --bg:#101418; --panel:#171d24; --line:#242c36; --text:#dbe4ee; --dim:#7d8b9c;
          --accent:#31a8ff; --ok:#3fb950; --warn:#e3b341; --err:#f85149; --mono:ui-monospace,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,"Segoe UI",sans-serif; height:100vh; display:flex; flex-direction:column; }
  header { display:flex; gap:14px; align-items:center; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
  header b { color:var(--accent); font-size:16px; }
  header .dim { color:var(--dim); font-size:12px; }
  #busy { margin-left:auto; font-size:12px; color:var(--dim); }
  #busy.on { color:var(--warn); }
  main { flex:1; display:flex; min-height:0; }
  #side { width:320px; border-right:1px solid var(--line); overflow-y:auto; padding:12px; }
  #side h3 { margin:14px 0 6px; font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  #side .item { padding:4px 6px; border-radius:6px; font-size:12.5px; color:var(--text); }
  #side .item .d { color:var(--dim); display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #side .item.click:hover { background:var(--panel); cursor:pointer; }
  #stage { flex:1; display:flex; flex-direction:column; min-width:0; }
  #log { flex:1; overflow-y:auto; padding:16px 20px; }
  .think { color:var(--dim); font-style:italic; white-space:pre-wrap; }
  .say { white-space:pre-wrap; }
  .tool { color:var(--accent); font-family:var(--mono); font-size:12.5px; margin:6px 0 2px; }
  .toolres { color:var(--dim); font-family:var(--mono); font-size:12px; white-space:pre-wrap; }
  .err { color:var(--err); }
  .final { border-top:1px dashed var(--line); margin-top:10px; padding-top:10px; }
  #approval { display:none; background:#2a2313; border:1px solid var(--warn); border-radius:8px; padding:10px 14px; margin:8px 20px; }
  #approval .name { color:var(--warn); font-family:var(--mono); }
  #approval button { margin-right:8px; }
  form { display:flex; gap:8px; padding:12px 20px; border-top:1px solid var(--line); background:var(--panel); }
  textarea { flex:1; resize:none; background:var(--bg); color:var(--text); border:1px solid var(--line);
             border-radius:8px; padding:8px 10px; font:inherit; min-height:44px; max-height:160px; }
  button { background:var(--accent); color:#08243a; border:0; border-radius:8px; padding:8px 18px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  button.danger { background:var(--err); color:#fff; }
  button:disabled { opacity:.45; cursor:default; }
  .badge { display:inline-block; font-size:11px; padding:1px 7px; border-radius:10px; background:var(--panel); color:var(--dim); margin-left:6px; }
</style>
</head>
<body>
<header>
  <b>hmh web</b>
  <span class="dim" id="model"></span>
  <span class="dim" id="home"></span>
  <span id="busy">idle</span>
  <button id="clear" class="ghost" style="padding:2px 10px;font-size:12px">clear</button>
</header>
<main>
  <div id="side">
    <h3 id="ph-skills">skills</h3><div id="skills"></div>
    <h3 id="ph-sessions">recent sessions</h3><div id="sessions"></div>
    <h3 id="ph-insights">insights</h3><div id="insights"></div>
    <h3 id="ph-evolution">evolution</h3><div id="evolution"></div>
  </div>
  <div id="stage">
    <div id="log"></div>
    <div id="approval">
      <div><span id="approval-req-label">审批请求:</span><span class="name" id="ap-name"></span> <span id="ap-args" class="dim" style="font-family:var(--mono)"></span></div>
      <div style="margin-top:8px">
        <button id="ap-yes">批准</button>
        <button id="ap-no" class="danger">拒绝</button>
      </div>
    </div>
    <form id="form">
      <textarea id="input" placeholder="给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)"></textarea>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--dim)"><input type="checkbox" id="yes"><span id="yes-label">自动批准</span></label>
      <button id="send" type="submit">运行</button>
    </form>
  </div>
</main>
<script>
(function () {
  var log = document.getElementById('log');
  var state = null;
  var L = null;
  var LABELS = {
    zh: { title:'hmh web', idle:'空闲', running:'运行中…', send:'运行', approve:'批准', deny:'拒绝',
          approvalReq:'审批请求:', skills:'技能库', sessions:'最近会话', insights:'近期洞察', evolution:'进化记录',
          none:'(无)', noCycles:'(尚无进化轮次)', placeholder:'给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
          end:'--- (以下新任务将开始全新对话) ---', none2:'(无)' },
    en: { title:'hmh web', idle:'idle', running:'running…', send:'Run', approve:'Approve', deny:'Deny',
          approvalReq:'Approval request:', skills:'skills', sessions:'recent sessions', insights:'insights', evolution:'evolution',
          none:'(none)', noCycles:'(no cycles yet)', placeholder:'give hmh a task… (Enter to send, Shift+Enter for newline)',
          end:'--- (new tasks below start a fresh conversation) ---', none2:'(none)' }
  };
  function setLabels(loc) {
    L = LABELS[loc === 'en' ? 'en' : 'zh'];
    document.title = L.title;
    document.getElementById('send').textContent = L.send;
    document.getElementById('ap-yes').textContent = L.approve;
    document.getElementById('ap-no').textContent = L.deny;
    document.getElementById('approval-req-label').textContent = L.approvalReq;
    document.getElementById('clear').textContent = loc === 'en' ? 'clear' : '清屏';
    document.getElementById('input').placeholder = L.placeholder;
    document.getElementById('yes-label').textContent = loc === 'en' ? 'auto-approve' : '自动批准';
    document.getElementById('ph-skills').textContent = L.skills;
    document.getElementById('ph-sessions').textContent = L.sessions;
    document.getElementById('ph-insights').textContent = L.insights;
    document.getElementById('ph-evolution').textContent = L.evolution;
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
  function setBusy(b) {
    var badge = document.getElementById('busy');
    badge.textContent = b ? L.running : L.idle;
    badge.className = b ? 'on' : '';
    document.getElementById('send').disabled = b;
  }

  function renderState(s) {
    state = s;
    setLabels(s.locale || 'zh');
    document.getElementById('model').textContent = s.model;
    document.getElementById('home').textContent = s.home;
    var sk = document.getElementById('skills');
    sk.innerHTML = '';
    s.skills.active.forEach(function (x) {
      sk.innerHTML += '<div class="item"><span>' + x.name + '</span><span class="d">' + (x.description || '') + '</span></div>';
    });
    s.skills.drafts.forEach(function (x) {
      sk.innerHTML += '<div class="item"><span>' + x.name + '</span><span class="badge">draft</span><span class="d">' + (x.description || '') + '</span></div>';
    });
    if (!s.skills.active.length && !s.skills.drafts.length) sk.innerHTML = '<div class="item dim">' + L.none + '</div>';
    var ins = document.getElementById('insights');
    ins.innerHTML = '';
    s.insights.forEach(function (i) {
      ins.innerHTML += '<div class="item"><span class="d">[' + i.outcome + '] ' + i.task + '</span></div>';
    });
    var ev = document.getElementById('evolution');
    ev.innerHTML = '';
    (s.evolution || []).slice().reverse().forEach(function (r) {
      var line = (r.time || '') + ' ' + ((r.outcomes || []).map(function (o) { return o.action + ':' + o.name; }).join(' ') || '(no proposals)');
      ev.innerHTML += '<div class="item"><span class="d">' + line + '</span></div>';
    });
    if (!(s.evolution || []).length) ev.innerHTML = '<div class="item dim">' + L.noCycles + '</div>';
  }

  function loadSessions() {
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      var box = document.getElementById('sessions');
      box.innerHTML = '';
      d.sessions.slice(0, 12).forEach(function (id) {
        var div = document.createElement('div');
        div.className = 'item click';
        div.textContent = id;
        div.onclick = function () { viewSession(id, div); };
        box.appendChild(div);
      });
      if (!d.sessions.length) box.innerHTML = '<div class="item dim">' + L.none2 + '</div>';
    });
  }
  function viewSession(id, sourceEl) {
    flushStream();
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      log.innerHTML = '';
      el('div', 'tool', '--- session ' + d.id + ' (' + d.model + ') ---');
      d.messages.forEach(function (m) {
        if (m.role === 'user') el('div', 'say', '▶ ' + m.text);
        else if (m.role === 'assistant') el('div', m.tools && m.tools.length ? 'tool' : 'say', m.text || ('[calls: ' + (m.tools || []).join(', ') + ']'));
        else el('div', 'toolres', m.text);
      });
      el('div', 'tool', L.end);
      log.scrollTop = log.scrollHeight;
    });
  }

  // ---- SSE ----
  // Streaming display: one element per assistant segment (thinking / text);
  // chunks APPEND to it until the segment changes. Creating an element per
  // chunk shreds CJK text into vertical confetti - never again.
  var curEl = null;
  var curKind = null;
  function flushStream() { curEl = null; curKind = null; }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function autoscroll() { if (nearBottom()) log.scrollTop = log.scrollHeight; }

  var es = new EventSource('/api/events');
  es.addEventListener('hello', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('state', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('busy', function (e) {
    var d = JSON.parse(e.data);
    setBusy(d.busy);
    flushStream();
    if (d.busy) el('div', 'tool', '▶ ' + d.task);
  });
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    if (curKind !== d.kind) {
      flushStream();
      curKind = d.kind;
      curEl = el('div', d.kind === 'reasoning' ? 'think' : 'say');
    }
    curEl.textContent += d.chunk;
    autoscroll();
  });
  es.addEventListener('line', function (e) { flushStream(); el('div', 'toolres', '  ' + JSON.parse(e.data).text); autoscroll(); });
  es.addEventListener('tool', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    el('div', 'tool', '  [tool] ' + d.name + ' ' + JSON.stringify(d.args).slice(0, 120));
    autoscroll();
  });
  es.addEventListener('toolResult', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    el('div', d.isError ? 'toolres err' : 'toolres', '  [' + d.name + (d.isError ? ' ERROR' : ' ok') + '] ' + d.preview.slice(0, d.isError ? 160 : 120).replace(/
/g, ' '));
    autoscroll();
  });
  es.addEventListener('approvalReq', function (e) {
    var d = JSON.parse(e.data);
    document.getElementById('ap-name').textContent = d.name;
    document.getElementById('ap-args').textContent = JSON.stringify(d.args).slice(0, 200);
    document.getElementById('approval').style.display = 'block';
  });
  es.addEventListener('approvalDone', function (e) {
    document.getElementById('approval').style.display = 'none';
    flushStream();
    var d = JSON.parse(e.data);
    el('div', 'toolres', '  [approval ' + d.name + ': ' + (d.granted ? 'granted' : 'DENIED') + ']');
  });
  es.addEventListener('final', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    var tok = (d.usage && (d.usage.promptTokens + d.usage.completionTokens) > 0) ? ' · ~' + d.usage.promptTokens + '/' + d.usage.completionTokens + ' tok' : '';
    el('div', 'toolres final', '(done · ' + d.turns + ' turns · ' + d.toolUses + ' tool uses' + tok + ' · session ' + d.sessionId + ')');
    loadSessions();
  });
  es.addEventListener('error', function (e) {
    if (e.data) el('div', 'err', 'error: ' + JSON.parse(e.data).message);
  });

  function decide(granted) {
    fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: granted })
    });
    document.getElementById('approval').style.display = 'none';
  }
  document.getElementById('ap-yes').onclick = function () { decide(true); };
  document.getElementById('ap-no').onclick = function () { decide(false); };

  // ---- task form ----
  document.getElementById('form').onsubmit = function (ev) {
    ev.preventDefault();
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, yes: document.getElementById('yes').checked })
    }).then(function (r) {
      if (r.status === 409) { el('div', 'err', 'a task is already running'); }
      return r.json();
    }).catch(function (err) { el('div', 'err', String(err)); });
  };
  document.getElementById('input').onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('form').requestSubmit();
    }
  };

  document.getElementById('clear').onclick = function () { flushStream(); log.innerHTML = ''; };

  fetch('/api/state').then(function (r) { return r.json(); }).then(renderState);
  loadSessions();
})();
</script>
</body>
</html>
`;
