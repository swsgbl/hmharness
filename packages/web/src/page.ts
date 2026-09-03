/**
 * @hmh/web - page (three-column layout, deepseek-harness inspired)
 * Sidebar (brand / new session / nav: chat·board·devices·skills / workspace
 * search / session tree, collapsible to an icon rail) | main (topbar, view
 * switcher, chat flow with user bubbles + collapsible thinking + code blocks
 * with copy + regenerate, composer-takeover approvals) | details (selected
 * tool call: args + full output). Vanilla JS, no build step.
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
  #app { display:grid; grid-template-columns:264px 1fr auto; grid-template-rows:100vh; height:100vh; }
  body.sidemin #app { grid-template-columns:56px 1fr auto; }
  /* min-height:0 everywhere content must shrink inside the grid/flex chain,
     otherwise the transcript grows past 100vh and pushes the composer
     off-screen (invisible with overflow:hidden) */
  #main { min-height:0; }
  #log { min-height:0; }
  #composer { flex-shrink:0; }

  /* ---- sidebar ---- */
  #side { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; min-width:0; }
  #brand { display:flex; align-items:center; gap:8px; padding:12px 12px; border-bottom:1px solid var(--line); }
  #brand .logo { color:var(--accent); font-size:18px; font-weight:700; }
  #brand .badge { font-size:9.5px; color:var(--accent); border:1px solid var(--accent); border-radius:4px; padding:0 4px; letter-spacing:.06em; }
  #collapse { margin-left:auto; background:none; border:0; color:var(--dim); cursor:pointer; font-size:14px; padding:2px 6px; border-radius:6px; }
  #collapse:hover { color:var(--text); background:var(--panel2); }
  body.sidemin #brand { justify-content:center; padding:12px 4px; }
  #newbtn { margin:10px 12px 6px; white-space:nowrap; overflow:hidden; }
  body.sidemin #newbtn { padding:7px 0; text-align:center; }
  nav { display:flex; flex-direction:column; gap:2px; padding:4px 10px; }
  .nav { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:8px; background:none; border:0; color:var(--dim); cursor:pointer; font:13px inherit; text-align:left; }
  .nav:hover { background:var(--panel2); color:var(--text); }
  .nav.on { background:var(--panel2); color:var(--accent); }
  .nav .ico { width:18px; text-align:center; flex:none; }
  body.sidemin nav { padding:4px 6px; }
  body.sidemin .nav { justify-content:center; padding:8px 0; }
  .wshead { display:flex; align-items:center; padding:10px 14px 4px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  .wsacts { margin-left:auto; display:flex; gap:2px; }
  .wsacts button { background:none; border:0; color:var(--dim); cursor:pointer; font-size:13px; padding:2px 6px; border-radius:6px; }
  .wsacts button:hover { color:var(--text); background:var(--panel2); }
  #wsbox { padding:0 10px 2px; position:relative; }
  #wscur { width:100%; display:flex; gap:7px; align-items:center; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:6px 9px; cursor:pointer; font:12.5px inherit; text-align:left; }
  #wscur:hover { border-color:var(--accent); }
  #wscur .tri { color:var(--dim); font-size:10px; transition:transform .12s; }
  #wsbox.open #wscur .tri { transform:rotate(180deg); }
  #wscur #wscur-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  #wslist { display:none; background:var(--panel2); border:1px solid var(--line); border-radius:8px; margin-top:4px; padding:4px; max-height:240px; overflow-y:auto; }
  #wsbox.open #wslist { display:block; }
  .wsi { position:relative; padding:6px 8px 6px 10px; border-radius:6px; cursor:pointer; }
  .wsi:hover { background:var(--bg); }
  .wsi.on { background:var(--bg); }
  .wsi .nm { font-size:12.5px; display:flex; gap:7px; align-items:center; padding-right:18px; }
  .wsi .nm .dot { width:6px; height:6px; border-radius:50%; background:var(--line); flex:none; }
  .wsi.on .nm .dot { background:var(--ok); }
  .wsi .pt { font-size:10.5px; color:var(--dim); font-family:var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  .wsi .wsx { position:absolute; right:5px; top:5px; visibility:hidden; background:none; border:0; color:var(--dim); cursor:pointer; font-size:13px; padding:0 4px; border-radius:4px; }
  .wsi:hover .wsx { visibility:visible; }
  .wsi .wsx:hover { color:var(--err); }
  .wsadd { font-size:12px; color:var(--dim); padding:6px 8px; cursor:pointer; border-top:1px dashed var(--line); margin-top:2px; }
  .wsadd:hover { color:var(--accent); }

  /* ---- workspace directory picker ---- */
  #wspick { display:none; position:fixed; inset:0; background:rgba(4,8,12,.62); z-index:50; align-items:center; justify-content:center; }
  #wspick.on { display:flex; }
  #wsp-card { width:540px; max-width:92vw; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:8px; }
  #wsp-head { display:flex; align-items:center; font-weight:600; font-size:14px; }
  #wsp-close { margin-left:auto; background:none; border:0; color:var(--dim); cursor:pointer; font-size:13px; padding:2px 6px; border-radius:6px; }
  #wsp-close:hover { color:var(--text); background:var(--panel2); }
  #wsp-path { background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:6px 9px; font:12px var(--mono); outline:none; }
  #wsp-path:focus { border-color:var(--accent); }
  #wsp-crumb { display:flex; flex-wrap:wrap; gap:2px; font-size:12px; color:var(--dim); font-family:var(--mono); align-items:center; }
  #wsp-crumb span.pc { color:var(--accent); cursor:pointer; }
  #wsp-crumb span.pc:hover { text-decoration:underline; }
  #wsp-crumb span.sep { color:var(--line); }
  #wsp-crumb span.seg { cursor:pointer; }
  #wsp-crumb span.seg:hover { color:var(--text); text-decoration:underline; }
  #wsp-list { min-height:180px; max-height:300px; overflow-y:auto; border:1px solid var(--line); border-radius:8px; background:var(--bg); padding:4px; }
  .wsp-item { display:flex; gap:8px; align-items:center; padding:5px 9px; border-radius:6px; cursor:pointer; font-size:12.5px; }
  .wsp-item:hover { background:var(--panel2); }
  .wsp-item .ic { color:var(--warn); flex:none; }
  .wsp-item.up { color:var(--dim); border-bottom:1px dashed var(--line); margin-bottom:2px; border-radius:0; }
  #wsp-foot { display:flex; gap:8px; align-items:center; }
  #wsp-sel { color:var(--dim); font-size:11px; font-family:var(--mono); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #wsp-name { width:150px; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:5px 8px; font:12px inherit; outline:none; }
  #wsp-name:focus { border-color:var(--accent); }
  #search { margin:4px 12px 8px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:7px;
            padding:6px 9px; font:12.5px inherit; outline:none; width:calc(100% - 24px); }
  #search:focus { border-color:var(--accent); }
  #sesslist { flex:1; overflow-y:auto; padding:2px 6px; min-height:0; }
  #sesslist .grp { font-size:11px; color:var(--dim); padding:8px 8px 4px; text-transform:uppercase; letter-spacing:.08em; }
  .sess { display:block; width:100%; text-align:left; background:none; border:0; color:var(--text); padding:6px 8px; border-radius:7px; cursor:pointer; }
  .sess:hover { background:var(--panel2); }
  .sess .t1 { display:flex; gap:6px; align-items:center; font-size:12.5px; white-space:nowrap; overflow:hidden; }
  .sess .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
  .sess .time { color:var(--dim); font-family:var(--mono); font-size:11px; flex:none; }
  .sess .task { color:var(--dim); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess { position:relative; }
  .sess .sacts { position:absolute; right:4px; top:3px; display:none; gap:2px; background:var(--panel); padding:0 2px; border-radius:6px; z-index:5; }
  .sess:hover .sacts { display:flex; }
  .sess .sacts button { background:none; border:0; color:var(--dim); cursor:pointer; font-size:12px; padding:1px 4px; border-radius:4px; }
  .sess .sacts button:hover { color:var(--accent); background:var(--panel2); }
  .sess .sacts button.del:hover { color:var(--err); }
  .sess .ren { background:var(--bg); color:var(--text); border:1px solid var(--accent); border-radius:5px; font:12px inherit; padding:1px 4px; outline:none; width:95%; }
  #sidefoot { border-top:1px solid var(--line); padding:8px 14px; font-size:11.5px; color:var(--dim); white-space:nowrap; overflow:hidden; }
  body.sidemin .minhide { display:none !important; }
  body.sidemin #sidefoot { text-align:center; padding:8px 2px; font-size:10px; }

  /* ---- main + views ---- */
  #main { display:flex; flex-direction:column; min-width:0; }
  #topbar { display:flex; gap:10px; align-items:center; padding:9px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  .chip { font-size:11.5px; padding:2px 9px; border-radius:11px; background:var(--panel2); color:var(--dim); }
  .chip.model { color:var(--accent); cursor:pointer; position:relative; }
  .chip.model:hover { background:var(--panel); }
  #modelpick { display:none; position:absolute; top:calc(100% + 6px); left:0; z-index:60; min-width:250px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 12px 36px rgba(0,0,0,.5); }
  #modelpick.on { display:block; }
  .mp-row { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
  .mp-row:hover { background:var(--panel2); }
  .mp-row .dot2 { width:7px; height:7px; border-radius:50%; background:var(--line); flex:none; }
  .mp-row.cur .dot2 { background:var(--ok); }
  .mp-row .mm { font-family:var(--mono); color:var(--accent); }
  .mp-row .mp-p { color:var(--dim); font-size:10.5px; margin-left:auto; }
  .mp-empty { color:var(--dim); font-size:11.5px; padding:8px 10px; max-width:280px; }
  button.chip.locale { border:0; cursor:pointer; }
  button.chip.locale:hover { color:var(--accent); }
  #busy { margin-left:auto; font-size:12px; color:var(--dim); }
  #busy.on { color:var(--warn); }
  .vwrap { display:none; flex-direction:column; flex:1; min-height:0; }
  .vwrap.on { display:flex; }
  .view { display:none; overflow-y:auto; flex:1; padding:18px 26px; }
  .view.on { display:block; }
  .vhead { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .vhead h2 { margin:0; font-size:16px; }
  .hint { color:var(--dim); font-size:13px; padding:6px 0; }

  /* ---- chat ---- */
  #log { flex:1; overflow-y:auto; padding:18px 26px; scroll-behavior:smooth; }
  .think { color:var(--dim); font-style:italic; white-space:pre-wrap; }
  .say { white-space:pre-wrap; }
  .say code { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:0 4px; font-family:var(--mono); font-size:12.5px; }
  .say pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto; font-family:var(--mono); font-size:12.5px; line-height:1.5; }
  .say b { color:#fff; }
  .msg-user { color:var(--text); background:var(--panel2); border-radius:12px; padding:8px 14px; margin:10px 0 6px auto; width:fit-content; max-width:74%; white-space:pre-wrap; }
  .thinkbox { border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:8px; margin:8px 0; background:var(--panel); }
  .thinkhead { width:100%; display:flex; gap:8px; align-items:center; background:none; border:0; color:var(--dim); padding:6px 10px; cursor:pointer; font-size:12.5px; }
  .thinkhead:hover { color:var(--text); }
  .tri { display:inline-block; transition:transform .12s; }
  .thinkbox.open .tri { transform:rotate(90deg); }
  .thinkbody { display:none; padding:2px 14px 10px; color:var(--dim); font-style:italic; white-space:pre-wrap; }
  .thinkbox.open .thinkbody { display:block; }
  .codeblk { border:1px solid var(--line); border-radius:8px; overflow:hidden; margin:8px 0; }
  .codebar { display:flex; justify-content:space-between; align-items:center; background:var(--panel2); padding:3px 10px; font-size:11px; color:var(--dim); font-family:var(--mono); }
  .codebar .copy { background:none; border:0; color:var(--dim); cursor:pointer; font-size:11px; padding:1px 4px; }
  .codebar .copy:hover { color:var(--accent); }
  .codeblk pre { margin:0; border:0; border-radius:0; }
  .acts { display:flex; gap:14px; margin:2px 0 12px; }
  .acts button { background:none; border:0; color:var(--dim); cursor:pointer; font-size:12px; padding:2px 4px; }
  .acts button:hover { color:var(--accent); }
  .toolrow { font-family:var(--mono); font-size:12.5px; margin:6px 0 2px; cursor:pointer; padding:3px 6px; border-radius:6px; }
  .toolrow:hover { background:var(--panel2); }
  .toolrow .st { margin-right:7px; }
  .toolrow .st.run { color:var(--warn); }
  .toolrow .st.err { color:var(--err); }
  .toolrow .st.ok { color:var(--ok); }
  .toolrow .nm { color:var(--accent); font-weight:600; }
  .toolres { color:var(--dim); font-family:var(--mono); font-size:12px; white-space:pre-wrap; margin-left:22px; border-left:2px solid var(--line); padding-left:8px; }
  .pargrp { margin-left:8px; margin-bottom:2px; border-left:2px solid var(--accent); padding-left:6px; }
  .pargrp .plabel { color:var(--accent); font-size:10.5px; font-family:var(--mono); padding:1px 4px; }
  .toolfold { color:var(--dim); font-family:var(--mono); font-size:11.5px; margin-left:22px; cursor:pointer; padding:2px 6px; border-radius:6px; }
  .toolfold:hover { background:var(--panel2); color:var(--text); }
  .toolfold .tri { display:inline-block; transition:transform .12s; margin-right:5px; }
  .toolfold.open .tri { transform:rotate(90deg); }
  .err { color:var(--err); }
  .stats { color:var(--dim); font-family:var(--mono); font-size:11.5px; border-top:1px dashed var(--line); margin-top:10px; padding-top:6px; }
  #tobot { position:absolute; right:32px; bottom:130px; display:none; }
  #empty { color:var(--dim); text-align:center; margin:auto; max-width:430px; }
  #empty .ex { font-family:var(--mono); font-size:12.5px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:6px 0; cursor:pointer; }
  #empty .ex:hover { border-color:var(--accent); color:var(--text); }

  /* ---- board / devices / skills ---- */
  .bgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:10px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; }
  .card:hover { border-color:var(--accent); }
  .card .crow { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--dim); font-family:var(--mono); }
  .ob { font-size:10.5px; padding:0 7px; border-radius:8px; background:var(--bg); }
  .ob.ok { color:var(--ok); } .ob.err { color:var(--err); } .ob.tb { color:var(--warn); } .ob.none { color:var(--dim); }
  .ctask { font-size:13px; margin:7px 0 5px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .cmeta { font-size:11.5px; color:var(--dim); font-family:var(--mono); }
  .devrow { display:flex; gap:12px; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:8px; font-family:var(--mono); font-size:13px; }
  .devrow .st { color:var(--ok); }
  .devrow .kind { color:var(--dim); font-size:11.5px; margin-left:auto; }
  .sshcard { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .sshcard .sshhead { display:flex; gap:10px; align-items:center; font-family:var(--mono); }
  .sshcard .sshhead b { color:var(--accent); }
  .sshcard .sshhead .st { color:var(--ok); font-size:12px; margin-left:auto; }
  .sshcmd { display:flex; gap:8px; margin-top:10px; }
  .sshcmd input { flex:1; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font:13px var(--mono); outline:none; }
  .sshcmd input:focus { border-color:var(--accent); }
  .sshout { margin-top:10px; background:#0a0f14; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-family:var(--mono); font-size:12px; white-space:pre-wrap; max-height:280px; overflow-y:auto; }
  .sshout .err { color:var(--err); }
  .skrow { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:8px; }
  .skrow .nm { color:var(--accent); font-family:var(--mono); font-weight:600; }
  .skrow .ds { color:var(--dim); font-size:12.5px; margin-top:2px; }
  h3.sec { font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; margin:20px 0 8px; }

  /* ---- composer (input card / approval takeover) ---- */
  #composer { border-top:1px solid var(--line); background:var(--panel); padding:10px 16px 12px; }
  #runstatus { display:none; align-items:center; gap:8px; padding:2px 2px 8px; color:var(--warn); font-size:12.5px; }
  #runstatus.on { display:flex; }
  #rs-spin { display:inline-block; animation:rsspin 1.1s linear infinite; color:var(--warn); font-size:14px; }
  #runstatus.yolo #rs-text { color:var(--err); font-weight:600; }
  @keyframes rsspin { to { transform:rotate(360deg); } }
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
    <div id="brand"><span class="logo">hmh</span><span class="badge minhide">HARNESS</span><button id="collapse" title="收起侧栏">«</button></div>
    <button id="newbtn" class="primary">＋ <span id="new-label" class="minhide">新会话</span></button>
    <nav>
      <button class="nav on" data-view="chat"><span class="ico">💬</span><span class="txt minhide">对话</span></button>
      <button class="nav" data-view="board"><span class="ico">🗒</span><span class="txt minhide">任务看板</span></button>
      <button class="nav" data-view="devices"><span class="ico">📟</span><span class="txt minhide">设备</span></button>
      <button class="nav" data-view="ssh"><span class="ico">🖧</span><span class="txt minhide">SSH</span></button>
      <button class="nav" data-view="skills"><span class="ico">📚</span><span class="txt minhide">技能中心</span></button>
    </nav>
    <div class="wshead"><span class="minhide" id="ws-label">工作区</span><span class="wsacts minhide"><button id="ws-refresh" title="刷新会话列表">↻</button><button id="ws-new" title="添加工作区">＋</button></span></div>
    <div id="wsbox" class="minhide">
      <button id="wscur" type="button" title="切换工作区"><span class="tri">▾</span><span id="wscur-name">…</span></button>
      <div id="wslist">
        <div id="ws-items"></div>
        <div class="wsadd" id="ws-add">＋ 添加工作区</div>
      </div>
    </div>
    <input id="search" class="minhide" placeholder="搜索会话…">
    <div id="sesslist"><div class="grp" id="ph-sessions">最近会话</div><div id="sessions"></div><div class="grp" id="ph-other" style="display:none">其他 / 未分组</div><div id="sessions-other" style="display:none"></div></div>
    <div id="sidefoot" class="minhide"><span id="skills-n">0</span> <span id="skills-label">技能</span> · <span id="model2"></span></div>
  </div>
  <div id="main" style="position:relative;">
    <div id="topbar">
      <span class="chip model" id="model" style="position:relative"></span>
      <span class="chip" id="viewchip">对话</span>
      <span class="chip" id="home"></span>
      <span class="chip" id="locale-chip">zh</span>
      <span id="topspacer" style="margin-left:auto"></span>
      <button id="clear" class="ghost sm">clear</button>
    </div>
    <div id="view-chat" class="vwrap on">
      <div id="log"><div id="empty"><div style="font-size:30px">⚙️</div><div id="empty-title" style="margin:8px 0 4px;font-size:16px">给 hmh 一个任务</div><div id="empty-sub" style="font-size:12.5px">流式输出 · 浏览器审批 · 全程审计</div><div style="margin-top:14px"></div><div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div><div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div><div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div></div>
      <button id="tobot" class="ghost sm">↓</button>
      <div id="composer">
        <div id="runstatus"><span id="rs-spin">✻</span><span id="rs-text"></span></div>
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
            <option value="yolo">🔥 YOLO</option>
          </select>
            <span id="tokchip"></span>
            <button id="send" class="primary">运行</button>
          </div>
        </div>
      </div>
    </div>
    <div id="view-board" class="view">
      <div class="vhead"><h2 id="board-title">任务看板</h2><button id="board-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="board-grid" class="bgrid"></div>
    </div>
    <div id="view-devices" class="view">
      <div class="vhead"><h2 id="dev-title">设备</h2><button id="dev-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="dev-body"></div>
    <div id="view-ssh" class="view">
          <div class="vhead"><h2 id="ssh-title">SSH</h2><button id="ssh-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="ssh-body">
        <div id="ssh-empty" class="hint">未配置 SSH 主机 — 在 config.json 添加 sshHosts({name,host,user,port,keyPath}) 后刷新</div>
        <div id="ssh-panels"></div>
      </div>
    </div>
    </div>
    <div id="view-skills" class="view">
      <div class="vhead"><h2 id="sk-title">技能中心</h2></div>
      <div id="sk-body"></div>
    </div>
  </div>
  <div id="details">
    <div id="dhead"><span id="dname"></span><button id="dclose" class="ghost sm" style="margin-left:auto">✕</button></div>
    <div id="dbody"><div id="dempty">点击对话流中的工具行查看详情</div></div>
  </div>
  <div id="wspick">
    <div id="wsp-card">
      <div id="wsp-head"><span id="wsp-title">选择工作区目录</span><button id="wsp-close" type="button">✕</button></div>
      <input id="wsp-path" placeholder="或直接输入绝对路径, 回车前往">
      <div id="wsp-crumb"></div>
      <div id="wsp-list"></div>
      <div id="wsp-foot">
        <span id="wsp-sel"></span>
        <input id="wsp-name" placeholder="名称(默认目录名)">
        <button id="wsp-cancel" type="button" class="ghost sm">取消</button>
        <button id="wsp-ok" type="button" class="primary sm">添加</button>
      </div>
    </div>
  </div>
</div>
<style>
  button.primary { background:var(--accent); color:#08243a; border:0; border-radius:8px; padding:7px 16px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 14px; cursor:pointer; }
  button.ghost.sm, button.primary.sm { padding:3px 10px; font-size:12px; }
  button.danger { background:var(--err); color:#fff; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; }
  button:disabled { opacity:.45; cursor:default; }
</style>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script>
<script>
(function () {
  /* ---- motion layer (GSAP via CDN; everything degrades to no-animation
     when the CDN is unreachable or the user prefers reduced motion) ---- */
  var AN = (function () {
    var has = typeof gsap !== 'undefined';
    var reduce = false;
    try { reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    function go(fn) { if (has && !reduce) { try { fn(); } catch (e) {} } }
    function tgt(el) { return typeof el === 'string' ? document.querySelectorAll(el) : el; }
    return {
      ok: has && !reduce,
      viewIn: function (el) {
        go(function () { gsap.fromTo(tgt(el), { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.32, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform,visibility' }); });
      },
      stagger: function (sel, root) {
        go(function () {
          var list = (root || document).querySelectorAll(sel);
          gsap.fromTo(list, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, ease: 'power2.out', stagger: 0.04, overwrite: 'auto', clearProps: 'transform,visibility' });
        });
      },
      popIn: function (el) {
        go(function () { gsap.fromTo(tgt(el), { scale: 0.94, y: 8, autoAlpha: 0 }, { scale: 1, y: 0, autoAlpha: 1, duration: 0.36, ease: 'back.out(1.6)', overwrite: 'auto', clearProps: 'transform,visibility' }); });
      },
      userBubble: function (el) {
        go(function () { gsap.fromTo(tgt(el), { x: 26, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.28, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform,visibility' }); });
      },
      rowIn: function (el) {
        go(function () { gsap.fromTo(tgt(el), { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.24, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform,visibility' }); });
      },
      tick: function (el) {
        go(function () { gsap.fromTo(tgt(el), { scale: 1.3 }, { scale: 1, duration: 0.32, ease: 'back.out(2.2)', overwrite: 'auto', clearProps: 'transform' }); });
      },
      count: function (el, to, suffix) {
        go(function () {
          var o = { n: 0 };
          gsap.to(o, { n: to, duration: 0.9, ease: 'power2.out', onUpdate: function () { el.textContent = Math.round(o.n) + (suffix || ''); } });
        });
      }
    };
  })();
  window.__AN = AN;
  var log = document.getElementById('log');
  var state = null;
  var L = null;
  var curView = 'chat';
  var toolRegistry = {};   // seq -> {name, args, output}
  var seq = 0;
  var sessData = [];
  var lastTask = '';
  var lastAssistantText = '';

  var LABELS = {
    zh: { title:'hmh web', idle:'空闲', running:'运行中…', send:'运行', approve:'批准', deny:'拒绝',
          approvalReq:'审批请求:', skills:'技能', sessions:'最近会话', none2:'(无)',
          placeholder:'给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
          newLabel:'新会话', searchPh:'搜索会话…', skillsN:'技能',
          emptyTitle:'给 hmh 一个任务', emptySub:'流式输出 · 浏览器审批 · 全程审计', alreadyRunning:'已有一个任务在运行',
          dempty:'点击对话流中的工具行查看详情', ask:'🔒 审批询问', auto:'⚡ 自动批准', clear:'清屏',
          navChat:'对话', navBoard:'任务看板', navDev:'设备', navSk:'技能中心', ws:'工作区',
          viewChat:'对话', viewBoard:'任务看板', viewDev:'设备', viewSk:'技能中心',
          thinkL:'思考过程', copy:'复制', regen:'重新生成', refresh:'刷新',
          noDev:'未发现设备——连接真机或启动模拟器后刷新', noHdc:'未找到 hdc 命令——请安装 DevEco Studio / 命令行工具并加入 PATH',
          devEmu:'模拟器', devUsb:'真机', skActive:'已启用技能', skDrafts:'技能草稿', skInsights:'近期洞察', skEvo:'进化日志',
          noSkills:'(暂无)', turnsL:'轮', toolsL:'次工具', loading:'加载中…',
          modeYolo:'🔥 YOLO(全自动)', modeAutoShort:'自动',
          navSsh:'SSH', viewSsh:'SSH', sshNoHosts:'未配置 SSH 主机 — 在 config.json 添加 sshHosts 后刷新', sshRun:'运行', sshApproveFirst:'该命令需要审批 — 点击「批准并运行」', sshApprovedRun:'批准并运行', sshPh:'远程命令, 回车运行 (ls / df -h / uptime …)',
          sesRename:'重命名', sesArchive:'归档(移入 archive,可查不占列表)', sesDelete:'删除(移入 trash,可恢复)', sesConfirmDel:'删除该会话?(文件移入 sessions/trash,可手动恢复)',
          wsAdd:'＋ 添加工作区', wsName:'名称(默认目录名)', wsPath:'或直接输入绝对路径, 回车前往', wsOk:'添加',
          pickTitle:'选择工作区目录', thisPC:'此电脑', cancel:'取消', up:'上一级',
          wsSwitch:'切换工作区', wsRemove:'移除注册(不删目录)', curSessions:'本工作区会话', otherSessions:'其他 / 未分组' },
    en: { title:'hmh web', idle:'idle', running:'running…', send:'Run', approve:'Approve', deny:'Deny',
          approvalReq:'Approval request:', skills:'skills', sessions:'recent sessions', none2:'(none)',
          placeholder:'give hmh a task… (Enter to send, Shift+Enter for newline)',
          newLabel:'New session', searchPh:'search sessions…', skillsN:'skills',
          emptyTitle:'give hmh a task', emptySub:'streaming · browser approvals · fully audited', alreadyRunning:'a task is already running',
          dempty:'click a tool row in the chat to inspect', ask:'🔒 ask approval', auto:'⚡ auto-approve', clear:'clear',
          navChat:'Chat', navBoard:'Task board', navDev:'Devices', navSk:'Skills', ws:'Workspace',
          viewChat:'Chat', viewBoard:'Task board', viewDev:'Devices', viewSk:'Skills',
          thinkL:'Thinking', copy:'Copy', regen:'Regenerate', refresh:'Refresh',
          noDev:'No devices found - plug in a device or start an emulator, then refresh',
          noHdc:'hdc not found - install DevEco Studio / command-line tools and add to PATH',
          devEmu:'emulator', devUsb:'device', skActive:'Active skills', skDrafts:'Draft skills', skInsights:'Recent insights', skEvo:'Evolution log',
          noSkills:'(none)', turnsL:'turns', toolsL:'tool uses', loading:'loading…',
          modeYolo:'🔥 YOLO (hands-free)', modeAutoShort:'auto',
          navSsh:'SSH', viewSsh:'SSH', sshNoHosts:'No SSH hosts configured - add sshHosts to config.json, then refresh', sshRun:'Run', sshApproveFirst:'This command needs approval - click approve-and-run', sshApprovedRun:'Approve & run', sshPh:'remote command, Enter to run (ls / df -h / uptime ...)',
          sesRename:'Rename', sesArchive:'Archive (moves to archive/, out of the list)', sesDelete:'Delete (moves to trash/, recoverable)', sesConfirmDel:'Delete this session? (moved to sessions/trash, manually recoverable)',
          wsAdd:'＋ add workspace', wsName:'name (defaults to folder name)', wsPath:'or type an absolute path and press Enter', wsOk:'Add',
          pickTitle:'Choose workspace folder', thisPC:'This PC', cancel:'Cancel', up:'Up one level',
          wsSwitch:'switch workspace', wsRemove:'unregister (keeps the folder)', curSessions:'this workspace', otherSessions:'other / ungrouped' }
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
    document.getElementById('mode').options[2].text = L.modeYolo;
    document.getElementById('ws-label').textContent = L.ws;
    document.getElementById('board-title').textContent = L.viewBoard;
    document.getElementById('dev-title').textContent = L.viewDev;
    document.getElementById('sk-title').textContent = L.viewSk;
    document.getElementById('board-refresh').textContent = '\\u21BB ' + L.refresh;
    document.getElementById('dev-refresh').textContent = '\\u21BB ' + L.refresh;
    document.getElementById('ph-sessions').textContent = L.curSessions;
    document.getElementById('ph-other').textContent = L.otherSessions;
    document.getElementById('ws-add').textContent = L.wsAdd;
    document.getElementById('wsp-title').textContent = L.pickTitle;
    document.getElementById('wsp-path').placeholder = L.wsPath;
    document.getElementById('wsp-name').placeholder = L.wsName;
    document.getElementById('wsp-cancel').textContent = L.cancel;
    document.getElementById('wsp-ok').textContent = L.wsOk;
    document.getElementById('ws-new').title = L.pickTitle;
    document.getElementById('wscur').title = L.wsSwitch;
    var navNames = { chat:L.navChat, board:L.navBoard, devices:L.navDev, ssh:L.navSsh, skills:L.navSk };
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) {
      var txt = n.querySelector('.txt');
      if (txt) txt.textContent = navNames[n.getAttribute('data-view')] || '';
    });
    document.getElementById('viewchip').textContent =
      ({ chat:L.viewChat, board:L.viewBoard, devices:L.viewDev, ssh:L.viewSsh, skills:L.viewSk })[curView] || curView;
  }

  /* ---- view switching / sidebar collapse ---- */
  function switchView(v) {
    curView = v;
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) {
      n.classList.toggle('on', n.getAttribute('data-view') === v);
    });
    ['chat', 'board', 'devices', 'ssh', 'skills'].forEach(function (k) {
      var elv = document.getElementById('view-' + k);
      if (elv) elv.classList.toggle('on', k === v);
    });
    var shown = document.getElementById('view-' + v);
    if (shown) window.__AN.viewIn(shown);
    if (L) {
      document.getElementById('viewchip').textContent =
        ({ chat:L.viewChat, board:L.viewBoard, devices:L.viewDev, ssh:L.viewSsh, skills:L.viewSk })[v] || v;
    }
    if (v === 'board') loadBoard();
    if (v === 'devices') loadDevices();
    if (v === 'ssh') renderSsh();
    if (v === 'skills') renderSkills();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) {
    n.onclick = function () { switchView(n.getAttribute('data-view')); };
  });
  function applySide(min) {
    document.body.classList.toggle('sidemin', min);
    document.getElementById('collapse').textContent = min ? '\\u00BB' : '\\u00AB';
    try { localStorage.setItem('hmh-side-min', min ? '1' : '0'); } catch (e) {}
  }
  document.getElementById('collapse').onclick = function () {
    applySide(!document.body.classList.contains('sidemin'));
  };
  try { if (localStorage.getItem('hmh-side-min') === '1') applySide(true); } catch (e) {}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    log.appendChild(e);
    log.scrollTop = log.scrollHeight;
    if (cls === 'msg-user') window.__AN.userBubble(e);
    else window.__AN.rowIn(e);
    return e;
  }
  function clearEmpty() {
    var e = document.getElementById('empty');
    if (e) e.remove();
  }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s);
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
  function mdLite(text) {
    var esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var parts = esc.split(/\\u0060\\u0060\\u0060/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var m = parts[i].match(/^([a-zA-Z0-9_+#-]*)\\n([\\s\\S]*)$/);
        var lang = (m && m[1]) || '';
        var body = m ? m[2] : parts[i];
        out += '<div class="codeblk"><div class="codebar"><span>' + (lang || 'text') +
               '</span><button type="button" class="copy">' + (L ? L.copy : 'copy') + '</button></div><pre>' + body + '</pre></div>';
      } else {
        out += parts[i]
          .replace(/\\u0060([^\\u0060\\n]+)\\u0060/g, '<code>$1</code>')
          .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>');
      }
    }
    return out;
  }
  function thinkBlock() {
    clearEmpty();
    var box = document.createElement('div');
    box.className = 'thinkbox open';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'thinkhead';
    var tri = document.createElement('span'); tri.className = 'tri'; tri.textContent = '\\u25B8';
    var lbl = document.createElement('span'); lbl.textContent = (L ? L.thinkL : 'thinking');
    head.appendChild(tri); head.appendChild(lbl);
    var body = document.createElement('div');
    body.className = 'thinkbody';
    box.appendChild(head); box.appendChild(body);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
    return {
      add: function (c) { body.textContent += c; autoscroll(); },
      finalize: function () { box.classList.remove('open'); }
    };
  }
  function sayBlock() {
    clearEmpty();
    var e = el('div', 'say');
    var txt = '';
    return {
      add: function (c) { txt += c; e.textContent = txt; autoscroll(); },
      finalize: function () { e.innerHTML = mdLite(txt); lastAssistantText = txt; autoscroll(); }
    };
  }
  function setBusy(b, mode) {
    var rs = document.getElementById('runstatus');
    rs.classList.toggle('on', b);
    if (b) {
      var tag = mode === 'yolo' ? '\\uD83D\\uDD25 YOLO' : mode === 'auto' ? '\\u26A1 ' + (L ? L.modeAutoShort : 'auto') : '';
      document.getElementById('rs-text').textContent = L.running + (tag ? ' \\u00B7 ' + tag : '');
      rs.classList.toggle('yolo', mode === 'yolo');
    } else {
      rs.classList.remove('yolo');
    }
    document.title = b ? '\\u25CF ' + L.running : L.title;
    document.getElementById('send').disabled = b;
    var input = document.getElementById('input');
    input.disabled = b;
    // visual cue that typing is parked while the agent runs (content kept)
    input.style.opacity = b ? '.55' : '';
  }

  function renderState(s) {
    state = s;
    setLabels(s.locale || 'zh');
    document.getElementById('model').textContent = s.model;
    document.getElementById('model2').textContent = s.model;
    renderModelPick(s);
    var hp = s.workspace && s.workspace.path ? s.workspace.path : s.home;
    document.getElementById('home').textContent = hp;
    document.getElementById('home').title = hp;
    if (s.workspace) {
      curWs = s.workspace;
      var n = document.getElementById('wscur-name');
      if (n && n.textContent !== s.workspace.name) n.textContent = s.workspace.name;
      renderSessions(document.getElementById('search').value);
    }
    document.getElementById('skills-n').textContent = s.skills.active.length + s.skills.drafts.length;
    if (curView === 'skills') renderSkills();
  }

  /* ---- model picker (switches routing.chat; server persists + broadcasts) ---- */
  function renderModelPick(s) {
    var chip = document.getElementById('model');
    var old = document.getElementById('modelpick');
    if (old) old.remove();
    var pick = document.createElement('div');
    pick.id = 'modelpick';
    var list = (s.providers || []);
    if (!list.length) {
      var e = document.createElement('div');
      e.className = 'mp-empty';
      e.textContent = '\\u672A\\u914D\\u7F6E\\u591A\\u5382\\u5546 providers \\u2014 \\u624B\\u52A8\\u7F16\\u8F91 config.json (\\u89C1 docs/PROVIDERS.md)';
      pick.appendChild(e);
    }
    list.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'mp-row' + (p.purposes && p.purposes.indexOf('chat') >= 0 ? ' cur' : '');
      var d = document.createElement('span'); d.className = 'dot2';
      var nm = document.createElement('span'); nm.textContent = p.name;
      var mm = document.createElement('span'); mm.className = 'mm'; mm.textContent = p.model;
      var pp = document.createElement('span'); pp.className = 'mp-p'; pp.textContent = (p.purposes || []).join('/');
      row.appendChild(d); row.appendChild(nm); row.appendChild(mm); row.appendChild(pp);
      row.onclick = function () {
        pick.classList.remove('on');
        fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: p.name }) })
          .then(function (r) { return r.json(); })
          .then(function (d2) { if (d2 && d2.error) alert(d2.error); })
          .catch(function (err) { alert(String(err)); });
      };
      pick.appendChild(row);
    });
    // not-yet-configured built-in presets below, dimmed, with setup hints
    (s.providerPresets || []).slice(0, 30).forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'mp-row';
      row.style.opacity = '.55';
      var d = document.createElement('span'); d.className = 'dot2';
      var nm = document.createElement('span'); nm.textContent = p.name;
      var mm = document.createElement('span'); mm.className = 'mm'; mm.textContent = p.model;
      var pp = document.createElement('span'); pp.className = 'mp-p';
      pp.textContent = p.local ? 'local' : 'set ' + p.envVar;
      row.appendChild(d); row.appendChild(nm); row.appendChild(mm); row.appendChild(pp);
      row.title = p.local ? '\\u672C\\u5730\\u63A8\\u7406\\u7AEF\\u70B9,\\u624B\\u5DE5\\u5199\\u5165 config.json \\u5373\\u53EF' : '\\u8BBE\\u7F6E\\u73AF\\u5883\\u53D8\\u91CF ' + p.envVar + ' \\u540E\\u8FD0\\u884C hmh providers --scan';
      pick.appendChild(row);
    });
    chip.appendChild(pick);
    chip.onclick = function (ev) {
      if (ev.target.closest && ev.target.closest('.mp-row')) return;
      var wasOff = !pick.classList.contains('on');
      pick.classList.toggle('on');
      if (wasOff) {
        window.__AN.popIn(pick);
        window.__AN.stagger('.mp-row', pick);
      }
    };
  }
  document.addEventListener('click', function (ev) {
    var pick = document.getElementById('modelpick');
    var chip = document.getElementById('model');
    if (pick && pick.classList.contains('on') && !chip.contains(ev.target)) pick.classList.remove('on');
  });

  /* ---- workspaces (the agent's project contexts) ---- */
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
      item.appendChild(nm); item.appendChild(pt); item.appendChild(x);
      item.onclick = function () {
        if (w.id === curWs.id) { document.getElementById('wsbox').classList.remove('open'); return; }
        fetch('/api/workspaces/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: w.id }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            document.getElementById('wsbox').classList.remove('open');
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
    box.classList.toggle('open');
    if (box.classList.contains('open')) {
      renderWsList();
      window.__AN.stagger('#ws-items .wsi');
    }
  };
  document.getElementById('ws-add').onclick = openPick;

  /* ---- workspace directory picker (server-side drive/folder listing) ---- */
  var pickPath = '';
  function openPick() {
    document.getElementById('wsbox').classList.remove('open');
    document.getElementById('wspick').classList.add('on');
    document.getElementById('wsp-name').value = '';
    loadFs('');
    window.__AN.popIn(document.getElementById('wsp-card'));
  }
  function closePick() {
    document.getElementById('wspick').classList.remove('on');
  }
  document.getElementById('wsp-close').onclick = closePick;
  document.getElementById('wsp-cancel').onclick = closePick;
  document.getElementById('wspick').onclick = function (e) {
    if (e.target === this) closePick();
  };
  document.getElementById('wsp-path').onkeydown = function (e) {
    if (e.key === 'Enter' && !e.isComposing) loadFs(this.value.trim());
  };
  function renderCrumb(segs) {
    var c = document.getElementById('wsp-crumb');
    c.innerHTML = '';
    var pc = document.createElement('span');
    pc.className = 'pc';
    pc.textContent = L ? L.thisPC : 'This PC';
    pc.onclick = function () { loadFs(''); };
    c.appendChild(pc);
    segs.forEach(function (s) {
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' \\u203A ';
      c.appendChild(sep);
      var seg = document.createElement('span');
      seg.className = 'seg';
      seg.textContent = s.name;
      seg.title = s.path;
      seg.onclick = function () { loadFs(s.path); };
      c.appendChild(seg);
    });
  }
  function loadFs(path) {
    var list = document.getElementById('wsp-list');
    list.innerHTML = '<div class="hint">' + (L ? L.loading : '...') + '</div>';
    fetch('/api/fs' + (path ? '?path=' + encodeURIComponent(path) : '')).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (!res.ok) { list.innerHTML = '<div class="hint err">' + ((res.d && res.d.error) || 'failed') + '</div>'; return; }
      var d = res.d;
      pickPath = d.path || '';
      document.getElementById('wsp-path').value = d.path || '';
      document.getElementById('wsp-sel').textContent = pickPath || (L ? L.thisPC : '');
      renderCrumb(d.segments || []);
      list.innerHTML = '';
      if (d.parent) {
        var up = document.createElement('div');
        up.className = 'wsp-item up';
        up.innerHTML = '<span class="ic">\\u2191</span> ' + (L ? L.up : 'up');
        up.onclick = function () { loadFs(d.parent); };
        list.appendChild(up);
      }
      (d.dirs || []).forEach(function (dir) {
        var item = document.createElement('div');
        item.className = 'wsp-item';
        var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '\\uD83D\\uDCC1';
        var nm = document.createElement('span'); nm.textContent = dir.name;
        item.appendChild(ic); item.appendChild(nm);
        item.onclick = function () { loadFs(dir.path); };
        list.appendChild(item);
      });
      if (!(d.dirs || []).length && !d.parent) {
        list.innerHTML += '<div class="hint">' + L.none2 + '</div>';
      }
      window.__AN.stagger('.wsp-item', list);
    }).catch(function (e) { list.innerHTML = '<div class="hint err">' + String(e) + '</div>'; });
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
    if (e.key === 'Enter' && !e.isComposing) submitPick();
  };

  /* ---- board / devices / skills views ---- */
  function sessTime(id) {
    var m = id.match(/^(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})/);
    return m ? m[1].slice(5) + ' ' + m[2] + ':' + m[3] : id.slice(0, 12);
  }
  function obFor(o) {
    var s = document.createElement('span');
    s.className = 'ob ' + (o === 'ok' ? 'ok' : o === 'error' ? 'err' : o === 'turn-budget' ? 'tb' : 'none');
    s.textContent = o || '\\u2014';
    return s;
  }
  function loadBoard() {
    var grid = document.getElementById('board-grid');
    grid.innerHTML = '<div class="hint">' + L.loading + '</div>';
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      grid.innerHTML = '';
      var list = (d.sessions || []).slice(0, 24);
      if (!list.length) { grid.innerHTML = '<div class="hint">' + L.none2 + '</div>'; return; }
      list.forEach(function (s) {
        var card = document.createElement('div');
        card.className = 'card';
        var crow = document.createElement('div'); crow.className = 'crow';
        crow.appendChild(obFor(s.outcome));
        var tm = document.createElement('span'); tm.textContent = sessTime(s.id);
        crow.appendChild(tm);
        var task = document.createElement('div'); task.className = 'ctask';
        task.textContent = s.task || s.id;
        var meta = document.createElement('div'); meta.className = 'cmeta';
        meta.textContent = (s.turns || 0) + ' ' + L.turnsL + ' \\u00B7 ' + (s.toolUses || 0) + ' ' + L.toolsL;
        card.appendChild(crow); card.appendChild(task); card.appendChild(meta);
        card.onclick = function () { viewSession(s.id); switchView('chat'); };
        grid.appendChild(card);
      });
      window.__AN.stagger('.card', grid);
    }).catch(function (e) { grid.innerHTML = '<div class="err">' + String(e) + '</div>'; });
  }
  function loadDevices() {
    var box = document.getElementById('dev-body');
    box.innerHTML = '<div class="hint">' + L.loading + '</div>';
    fetch('/api/devices').then(function (r) { return r.json(); }).then(function (d) {
      box.innerHTML = '';
      if (!d.hdcAvailable) { box.innerHTML = '<div class="hint">' + L.noHdc + '</div>'; return; }
      if (!d.devices.length) { box.innerHTML = '<div class="hint">' + L.noDev + '</div>'; return; }
      d.devices.forEach(function (v) {
        var row = document.createElement('div'); row.className = 'devrow';
        var st = document.createElement('span'); st.className = 'st'; st.textContent = '\\u25CF';
        var tg = document.createElement('span'); tg.textContent = v.target;
        var kd = document.createElement('span'); kd.className = 'kind';
        kd.textContent = v.kind === 'emulator' ? L.devEmu : L.devUsb;
        row.appendChild(st); row.appendChild(tg); row.appendChild(kd);
        box.appendChild(row);
      });
      window.__AN.stagger('.devrow', box);
    }).catch(function (e) { box.innerHTML = '<div class="err">' + String(e) + '</div>'; });
  }
  function renderSsh() {
    var box = document.getElementById('ssh-panels');
    var empty = document.getElementById('ssh-empty');
    var hosts = (state && state.sshHosts) || [];
    empty.style.display = hosts.length ? 'none' : '';
    if (!hosts.length) { empty.textContent = L.sshNoHosts; return; }
    box.innerHTML = '';
    hosts.forEach(function (h) {
      var card = document.createElement('div'); card.className = 'sshcard';
      var head = document.createElement('div'); head.className = 'sshhead';
      var dot = document.createElement('span'); dot.textContent = '\u25CF'; dot.style.color = 'var(--ok)';
      var name = document.createElement('b'); name.textContent = h.name;
      var addr = document.createElement('span'); addr.textContent = h.user + '@' + h.host + ':' + h.port;
      addr.style.color = 'var(--dim)';
      var st = document.createElement('span'); st.className = 'st'; st.textContent = '';
      head.appendChild(dot); head.appendChild(name); head.appendChild(addr); head.appendChild(st);
      var cmd = document.createElement('div'); cmd.className = 'sshcmd';
      var input = document.createElement('input'); input.placeholder = L.sshPh;
      var run = document.createElement('button'); run.className = 'primary sm'; run.type = 'button'; run.textContent = L.sshRun;
      cmd.appendChild(input); cmd.appendChild(run);
      var out = document.createElement('div'); out.className = 'sshout'; out.style.display = 'none';
      function send(approve) {
        var command = input.value.trim();
        if (!command) return;
        run.disabled = true;
        fetch('/api/ssh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: h.name, command: command, approve: approve === true }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
          .then(function (res) {
            run.disabled = false;
            if (res.status === 403 && res.d.needsApproval) {
              out.style.display = 'block';
              out.innerHTML = '';
              var warn = document.createElement('div'); warn.className = 'err'; warn.textContent = L.sshApproveFirst;
              var ok = document.createElement('button'); ok.className = 'danger sm'; ok.type = 'button'; ok.textContent = L.sshApprovedRun;
              ok.onclick = function () { send(true); };
              out.appendChild(warn); out.appendChild(ok);
              return;
            }
            out.style.display = 'block';
            if (res.d.error) { out.innerHTML = ''; var e = document.createElement('div'); e.className = 'err'; e.textContent = res.d.error; out.appendChild(e); }
            else { out.textContent = res.d.output || '(no output)'; }
            window.__AN && window.__AN.tick(out);
          })
          .catch(function (e) { run.disabled = false; out.style.display = 'block'; out.textContent = String(e); });
      }
      run.onclick = function () { send(false); };
      input.onkeydown = function (ev) { if (ev.key === 'Enter' && !ev.isComposing) send(false); };
      card.appendChild(head); card.appendChild(cmd); card.appendChild(out);
      box.appendChild(card);
    });
    window.__AN.stagger('.sshcard', box);
  }
  function skRow(name, desc, mark) {
    var r = document.createElement('div'); r.className = 'skrow';
    var nm = document.createElement('div'); nm.className = 'nm';
    nm.textContent = mark + ' ' + name;
    var ds = document.createElement('div'); ds.className = 'ds';
    ds.textContent = desc || '';
    r.appendChild(nm); r.appendChild(ds);
    return r;
  }
  function renderSkills() {
    var box = document.getElementById('sk-body');
    box.innerHTML = '';
    if (!state) { box.innerHTML = '<div class="hint">' + L.loading + '</div>'; return; }
    var h1 = document.createElement('h3'); h1.className = 'sec'; h1.textContent = L.skActive;
    box.appendChild(h1);
    if (!state.skills.active.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    state.skills.active.forEach(function (s) { box.appendChild(skRow(s.name, s.description, '+')); });
    var h2 = document.createElement('h3'); h2.className = 'sec'; h2.textContent = L.skDrafts;
    box.appendChild(h2);
    if (!state.skills.drafts.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    state.skills.drafts.forEach(function (s) { box.appendChild(skRow(s.name, s.description, '~')); });
    var h3 = document.createElement('h3'); h3.className = 'sec'; h3.textContent = L.skInsights;
    box.appendChild(h3);
    (state.insights || []).forEach(function (i) {
      var r = document.createElement('div'); r.className = 'skrow';
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = '[' + i.outcome + '] ' + (i.task || '').slice(0, 70);
      var ds = document.createElement('div'); ds.className = 'ds';
      ds.textContent = (i.time || '').slice(0, 16) + ' \\u00B7 ' + (i.tools || []).join(',');
      r.appendChild(nm); r.appendChild(ds);
      box.appendChild(r);
    });
    var h4 = document.createElement('h3'); h4.className = 'sec'; h4.textContent = L.skEvo;
    box.appendChild(h4);
    if (!(state.evolution || []).length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    (state.evolution || []).forEach(function (e) {
      var r = document.createElement('div'); r.className = 'skrow';
      var ds = document.createElement('div'); ds.className = 'ds';
      ds.textContent = JSON.stringify(e).slice(0, 220);
      r.appendChild(ds);
      box.appendChild(r);
    });
    window.__AN.stagger('.skrow', box);
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
    b.appendChild(t1);
    var t2 = null;
    if (label) { t2 = document.createElement('div'); t2.className = 'task'; t2.textContent = label; b.appendChild(t2); }
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
    acts.appendChild(mk('\\uD83D\\uDDD1', 'del', L ? L.sesDelete : 'delete', function () {
      if (!window.confirm(L ? L.sesConfirmDel : 'delete?')) return;
      fetch('/api/sessions/' + encodeURIComponent(s.id) + '/delete', { method: 'POST' }).then(function () { loadSessions(); });
    }));
    b.appendChild(acts);
    return b;
  }
  function renderSessions(filter) {
    var mine = document.getElementById('sessions');
    var other = document.getElementById('sessions-other');
    mine.innerHTML = '';
    other.innerHTML = '';
    var f = (filter || '').toLowerCase();
    var curPath = (curWs.path || '').toLowerCase();
    var otherCount = 0;
    sessData.slice(0, 50).forEach(function (s) {
      if (f && (s.id + ' ' + s.task).toLowerCase().indexOf(f) < 0) return;
      var inWs = !!curPath && String(s.cwd || '').toLowerCase() === curPath;
      if (inWs) mine.appendChild(sessRow(s));
      else { other.appendChild(sessRow(s)); otherCount++; }
    });
    var showOther = otherCount > 0;
    document.getElementById('ph-other').style.display = showOther ? '' : 'none';
    other.style.display = showOther ? '' : 'none';
    if (!mine.children.length) mine.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px">' + L.none2 + '</div>';
  }
  function loadSessions() {
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      sessData = d.sessions || [];
      if (d.workspace) curWs = d.workspace;
      renderSessions(document.getElementById('search').value);
    });
  }
  function viewSession(id) {
    flushStream();
    switchView('chat');
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      log.innerHTML = '';
      el('div', 'stats', '--- session ' + d.id + ' \\u00B7 ' + d.model + ' ---');
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
    // a new model turn resets the parallel group context
    parCount = 0; parBox = null;
    curBlock = null;
    curKind = null;
  }
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

  var pendingToolRow = null;   // running tool row awaiting its result
  var es = new EventSource('/api/events');
  es.addEventListener('hello', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('state', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('busy', function (e) {
    var d = JSON.parse(e.data);
    setBusy(d.busy, d.mode);
    flushStream();
    if (d.busy) { lastTask = d.task; clearEmpty(); el('div', 'msg-user', d.task); }
  });
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    if (curKind !== d.kind) {
      flushStream();
      clearEmpty();
      curKind = d.kind;
      curBlock = d.kind === 'reasoning' ? thinkBlock() : sayBlock();
    }
    curBlock.add(d.chunk);
  });
  es.addEventListener('line', function (e) { flushStream(); el('div', 'toolres', JSON.parse(e.data).text); autoscroll(); });
  var parCount = 0; var parBox = null;
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
    parCount++;
    if (parCount === 2 && !parBox) {
      parBox = document.createElement('div');
      parBox.className = 'pargrp';
      var pl = document.createElement('div'); pl.className = 'plabel';
      pl.textContent = '\u29C9 parallel tools';
      parBox.appendChild(pl);
      // move the first row into the group
      var first = log.querySelector('.toolrow:last-of-type');
      if (first) { log.appendChild(parBox); parBox.appendChild(first); }
      else log.appendChild(parBox);
    }
    if (parBox) parBox.appendChild(row);
    pendingToolRow = { seq: s, st: st, row: parBox || row };
    autoscroll();
  });
  es.addEventListener('toolResult', function (e) {
    flushStream();
    var d = JSON.parse(e.data);
    if (pendingToolRow) {
      pendingToolRow.st.className = 'st ' + (d.isError ? 'err' : 'ok');
      pendingToolRow.st.textContent = d.isError ? '\\u2717' : '\\u2022';
      pendingToolRow = null;
      parCount = 0; parBox = null;
    }
    // attach output to the most recent matching entry without output
    for (var k in toolRegistry) {
      if (toolRegistry[k].name === d.name && toolRegistry[k].output === '') { toolRegistry[k].output = d.full || d.preview || ''; break; }
    }
    // human-first: raw tool output folds to one line; click to inspect
    var fold = document.createElement('div');
    fold.className = 'toolfold' + (d.isError ? ' err' : '');
    var tri = document.createElement('span'); tri.className = 'tri'; tri.textContent = '\u25B8';
    var lab = document.createElement('span');
    var pv = String(d.preview).replace(/\s+/g, ' ').trim().slice(0, d.isError ? 110 : 72);
    lab.textContent = pv || '(done)';
    fold.appendChild(tri); fold.appendChild(lab);
    var body = null;
    fold.onclick = function () {
      fold.classList.toggle('open');
      if (!body) {
        body = document.createElement('div');
        body.className = d.isError ? 'toolres err' : 'toolres';
        body.textContent = d.full || d.preview || '';
        fold.after(body);
      } else { body.style.display = body.style.display === 'none' ? '' : 'none'; }
    };
    log.appendChild(fold);
    autoscroll();
  });
  es.addEventListener('approvalReq', function (e) {
    var d = JSON.parse(e.data);
    document.getElementById('ap-name').textContent = d.name;
    document.getElementById('ap-args').textContent = JSON.stringify(d.args).slice(0, 200);
    var box = document.getElementById('approval');
    box.style.display = 'block';
    box.classList.add('pulse');
    window.__AN.popIn(box);
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
    var tok = (d.usage && (d.usage.promptTokens + d.usage.completionTokens) > 0) ? ' \\u00B7 \\u2191' + d.usage.promptTokens + ' \\u2193' + d.usage.completionTokens + ' tok' : '';
    el('div', 'stats', d.turns + ' turns \\u00B7 ' + d.toolUses + ' tool uses' + tok + ' \\u00B7 session ' + d.sessionId.slice(11));
    if (tok) document.getElementById('tokchip').textContent = tok.replace(' \\u00B7 ', '');
    if (lastAssistantText && lastTask) {
      var acts = document.createElement('div'); acts.className = 'acts';
      var bc = document.createElement('button'); bc.type = 'button'; bc.textContent = '\\u29C9 ' + L.copy;
      bc.onclick = function () { copyText(lastAssistantText); bc.textContent = '\\u2713'; setTimeout(function () { bc.textContent = '\\u29C9 ' + L.copy; }, 1200); };
      var br = document.createElement('button'); br.type = 'button'; br.textContent = '\\u27F3 ' + L.regen;
      br.onclick = function () { sendTask(lastTask); };
      acts.appendChild(bc); acts.appendChild(br);
      log.appendChild(acts);
      autoscroll();
    }
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

  // ---- locale switch (persisted server-side; SSE state fans the new locale back) ----
  document.getElementById('locale-chip').onclick = function () {
    var next = this.textContent === 'zh' ? 'en' : 'zh';
    fetch('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next })
    });
  };

  // ---- composer ----
  function sendTask(text) {
    if (!text) return;
    fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, yes: document.getElementById('mode').value !== 'ask', mode: document.getElementById('mode').value })
    }).then(function (r) {
      if (r.status === 409) { clearEmpty(); switchView('chat'); el('div', 'err', L.alreadyRunning); }
      return r.json();
    }).catch(function (err) { clearEmpty(); el('div', 'err', String(err)); });
  }
  document.getElementById('send').onclick = function () {
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendTask(text);
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
    switchView('chat');
    log.innerHTML = '<div id="empty"><div style="font-size:30px">\\u2699\\uFE0F</div><div style="margin:8px 0 4px;font-size:16px">' + L.emptyTitle + '</div><div style="font-size:12.5px">' + L.emptySub + '</div><div style="margin-top:14px"></div>' +
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
  document.getElementById('ws-new').onclick = openPick;
  document.getElementById('clear').onclick = newSession;
  document.getElementById('ws-refresh').onclick = loadSessions;
  document.getElementById('board-refresh').onclick = loadBoard;
  document.getElementById('dev-refresh').onclick = loadDevices;
  document.getElementById('search').oninput = function () { renderSessions(this.value); };
  wireExamples();

  fetch('/api/state').then(function (r) { return r.json(); }).then(renderState);
  loadWorkspaces();
  loadSessions();
  // first paint: the sidebar and the welcome view drift in
  window.__AN.stagger('#side .nav');
  window.__AN.viewIn(document.getElementById('view-chat'));
})();
</script>
</body>
</html>
`;
