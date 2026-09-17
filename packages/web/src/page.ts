/**
 * @hmharness/web - page (three-column layout, deepseek-harness inspired)
 * Sidebar (brand / new session / nav: chat·board·devices·skills / workspace
 * search / session tree, collapsible to an icon rail) | main (topbar, view
 * switcher, chat flow with user bubbles + collapsible thinking + code blocks
 * with copy + regenerate, composer-takeover approvals) | details (selected
 * tool call: args + full output). Vanilla JS, no build step.
 * Template-literal rules: no raw backticks in the page body (use \u0060),
 * regex backslashes doubled, no ${} inside the page JS (string concat only).
 * The uilite pure helpers are inlined via ONE template hole: ${uiLiteSource()}.
 */
import { uiLiteSource } from './uilite.ts';

export const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hmh web</title>
<style>
  :root { --bg:#101418; --panel:#171d24; --panel2:#1c242e; --line:#242c36; --text:#dbe4ee; --dim:#7d8b9c;
          --accent:#31a8ff; --ok:#3fb950; --warn:#e3b341; --err:#f85149; --mono:ui-monospace,Consolas,monospace; }
  /* A11 theme: light + system modes override the semantic tokens; the page
     only ever reads var(--*) so one switch flips everything */
  body[data-theme="light"] { --bg:#f5f7fa; --panel:#ffffff; --panel2:#eef1f5; --line:#dde3ea; --text:#1c2733; --dim:#5b6b7c;
          --accent:#0a7fd4; --ok:#1a7f37; --warn:#9a6700; --err:#cf222e; }
  @media (prefers-color-scheme: dark) {
    body[data-theme="system"] { --bg:#101418; --panel:#171d24; --panel2:#1c242e; --line:#242c36; --text:#dbe4ee; --dim:#7d8b9c;
          --accent:#31a8ff; --ok:#3fb950; --warn:#e3b341; --err:#f85149; }
  }
  @media (prefers-color-scheme: light) {
    body[data-theme="system"] { --bg:#f5f7fa; --panel:#ffffff; --panel2:#eef1f5; --line:#dde3ea; --text:#1c2733; --dim:#5b6b7c;
          --accent:#0a7fd4; --ok:#1a7f37; --warn:#9a6700; --err:#cf222e; }
  }
  /* A6 plan card: pinned checklist at the top of the conversation */
  #plancard { margin:8px 16px 0; padding:8px 12px; background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:8px; font-size:12.5px; }
  #plancard .phead { display:flex; align-items:center; gap:8px; font-weight:600; color:var(--warn); cursor:pointer; }
  #plancard .psteps { margin-top:6px; }
  #plancard .pstep { display:flex; gap:7px; align-items:flex-start; padding:2px 0; }
  #plancard .pstep input { margin-top:3px; }
  #plancard .pstep.done { color:var(--dim); text-decoration:line-through; }
  /* A7 subagent call: distinct nested card */
  .toolrow.subagent { border-left:3px solid var(--accent); }
  .toolrow.subagent .nm { color:var(--accent); font-weight:600; }
  /* A9 deliverables chips */
  #deliv { display:flex; flex-wrap:wrap; gap:6px; margin:2px 0 4px; }
  #deliv .deliv { font-size:11px; font-family:var(--mono); color:var(--accent); background:var(--panel2); border:1px solid var(--line); border-radius:5px; padding:1px 7px; cursor:pointer; }
  #deliv .deliv:hover { border-color:var(--accent); }
  /* A8 permission preset popover */
  #presetpop { display:none; position:absolute; bottom:calc(100% + 6px); right:0; z-index:60; width:270px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:6px; }
  #presetpop.on { display:block; }
  #presetpop .preset { display:block; width:100%; text-align:left; background:none; border:0; color:var(--text); padding:7px 9px; border-radius:7px; cursor:pointer; font:12.5px inherit; }
  #presetpop .preset:hover { background:var(--panel2); }
  #presetpop .preset .pt { font-weight:600; }
  #presetpop .preset .pd { color:var(--dim); font-size:11px; margin-top:1px; }
  /* A10 feedback buttons */
  .acts .fb { font-size:13px; }
  .acts .fb.on { color:var(--ok); }
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
  .queued { color:var(--warn); font-size:12.5px; margin:4px 0 4px auto; width:fit-content; max-width:74%; opacity:.85; }
  .projgrp { width:100%; display:flex; align-items:center; gap:6px; background:none; border:0; color:var(--dim); font-size:12px; font-weight:600; padding:6px 8px; margin-top:8px; cursor:pointer; border-radius:6px; text-align:left; }
  .projgrp:hover { color:var(--text); background:var(--panel2); }
  .projgrp.cur { color:var(--cyan); }
  .projgrp .pcaret { width:12px; flex:0 0 auto; opacity:.8; }
  .projgrp .pname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .projgrp .pcount { flex:0 0 auto; opacity:.65; font-weight:500; }
  .projbody { padding-left:4px; }
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
  #send { margin-left:auto; min-width:72px; transition:background .12s ease; }
  #send.stop { background:var(--err); color:#fff; }

  /* ---- queue bar (visible queue between runstatus and input card) ---- */
  #queuebar { display:none; flex-direction:column; gap:4px; margin:0 2px 8px; }
  #queuebar.on { display:flex; }
  .qrow { display:flex; align-items:center; gap:8px; background:var(--panel2); border:1px solid var(--line); border-radius:8px; padding:4px 8px 4px 10px; font-size:12.5px; color:var(--dim); }
  .qrow .qn { color:var(--accent); font-family:var(--mono); font-size:11px; flex-shrink:0; }
  .qrow .qt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .qrow button { background:none; border:0; color:var(--dim); cursor:pointer; font-size:13px; padding:0 2px; border-radius:4px; flex-shrink:0; }
  .qrow button:hover { color:var(--err); background:var(--bg); }
  #qclear { background:none; border:0; color:var(--dim); cursor:pointer; font-size:11.5px; padding:0 4px; width:fit-content; align-self:flex-end; border-radius:4px; }
  #qclear:hover { color:var(--err); background:var(--panel2); }

  /* ---- right column: tabbed (detail / files / preview), collapsible, draggable ---- */
  /* settled design, W7: 右栏三 tab（详情/文件/预览），整体可折叠，宽度 300-600px
     拖拽记忆（localStorage hmh-right-w）。取代旧的单功能工具详情抽屉。 */
  #rightbar { width:0; overflow:hidden; border-left:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; position:relative; }
  #rightbar.open { width:360px; }
  #rdrag { position:absolute; left:-3px; top:0; bottom:0; width:6px; cursor:col-resize; z-index:5; }
  #rightbar.open #rdrag:hover { background:var(--accent); opacity:.35; }
  #rhead { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--line); }
  #rtabs { display:flex; gap:2px; background:var(--panel2); border-radius:7px; padding:2px; }
  .rtab { background:none; border:0; color:var(--dim); cursor:pointer; font-size:12px; padding:3px 10px; border-radius:5px; }
  .rtab.on { background:var(--bg); color:var(--accent); }
  .rtab:hover { color:var(--text); }
  #rhead .ghost { padding:2px 7px; }
  #rbody { flex:1; overflow:hidden; display:flex; flex-direction:column; min-height:0; }
  .rtabpane { display:none; flex:1; overflow-y:auto; min-height:0; }
  .rtabpane.on { display:block; }
  #dname { color:var(--accent); font-family:var(--mono); font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:10px 14px 0; }
  #dbody { padding:12px 14px; font-family:var(--mono); font-size:12px; }
  #dbody h4 { margin:10px 0 4px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  #dbody pre { white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:0; }
  #dempty { color:var(--dim); font-size:12px; margin:auto; text-align:center; padding:0 18px; }
  /* ---- files tab (workspace tree, lazy dirs) ---- */
  #ftree { padding:6px 8px; font-family:var(--mono); font-size:12px; }
  .frow { display:flex; gap:7px; align-items:center; padding:3px 8px; border-radius:6px; cursor:pointer; white-space:nowrap; overflow:hidden; }
  .frow:hover { background:var(--panel2); }
  .frow .fic { flex:none; }
  .frow.dir { color:var(--text); }
  .frow.file { color:var(--dim); }
  .frow.file:hover { color:var(--accent); }
  .fkids { margin-left:14px; border-left:1px solid var(--line); padding-left:2px; }
  /* ---- preview tab ---- */
  #pview { padding:10px 12px; }
  .pvhead { color:var(--accent); font-family:var(--mono); font-size:12px; margin-bottom:8px; word-break:break-all; }
  .pvcode { white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:0; font-family:var(--mono); font-size:12px; }

  /* ---- composer overlays: slash palette, @ file search, attachments ---- */
  #composer { position:relative; }
  #slashpanel, #atpanel { display:none; position:absolute; bottom:calc(100% - 4px); left:16px; right:16px; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 14px 40px rgba(0,0,0,.55); z-index:40; max-height:280px; overflow-y:auto; padding:4px; }
  #slashpanel.on, #atpanel.on { display:block; }
  .pickrow { display:flex; gap:10px; align-items:baseline; padding:7px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
  .pickrow:hover, .pickrow.sel { background:var(--panel2); }
  .pickrow .pn { font-family:var(--mono); color:var(--accent); white-space:nowrap; }
  .pickrow .pd { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pickrow .ph { font-family:var(--mono); color:var(--dim); font-size:11px; margin-left:auto; flex:none; }
  .pickfoot { color:var(--dim); font-size:11px; padding:5px 10px 2px; border-top:1px dashed var(--line); margin-top:2px; }
  #attbar { display:none; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  #attbar.on { display:flex; }
  .attchip { display:flex; gap:6px; align-items:center; background:var(--panel2); border:1px solid var(--line); border-radius:8px; padding:3px 6px 3px 9px; font-size:12px; font-family:var(--mono); color:var(--accent); max-width:280px; }
  .attchip .atx { background:none; border:0; color:var(--dim); cursor:pointer; font-size:13px; padding:0 3px; border-radius:4px; }
  .attchip .atx:hover { color:var(--err); }
  .attchip img { max-height:34px; max-width:64px; border-radius:4px; display:block; }
  #attach { background:none; border:1px solid var(--line); color:var(--dim); cursor:pointer; font-size:14px; padding:2px 8px; border-radius:6px; }
  #attach:hover { color:var(--accent); border-color:var(--accent); }
  .msg-inject { color:var(--accent); background:rgba(49,168,255,.08); border:1px dashed rgba(49,168,255,.4); border-radius:10px; padding:5px 12px; margin:4px 0 4px auto; width:fit-content; max-width:74%; font-size:12.5px; }

  /* ---- diff rendering (edit_file/write_file results) ---- */
  .diffbox { border:1px solid var(--line); border-radius:8px; overflow:hidden; margin:6px 0; background:var(--panel); }
  .diffbox .dhead { display:flex; align-items:center; background:var(--panel2); padding:4px 10px; font-size:11px; color:var(--dim); font-family:var(--mono); }
  .diffbox .dhead .copy { margin-left:auto; background:none; border:0; color:var(--dim); cursor:pointer; font-size:11px; padding:1px 4px; }
  .diffbox .dhead .copy:hover { color:var(--accent); }
  .diffbox pre { margin:0; font-family:var(--mono); font-size:12px; line-height:1.55; overflow-x:auto; white-space:pre; }
  .diffbox .dline { min-width:max-content; padding:0 10px; }
  .diffbox .dline.add { background:rgba(63,185,80,.13); color:#a5e6b0; }
  .diffbox .dline.del { background:rgba(248,81,73,.13); color:#f2a9a5; }
  .diffbox .dline.hunk { background:rgba(49,168,255,.08); color:var(--accent); }
  .diffbox .dline.file { color:var(--dim); }
  /* ---- web_search link cards ---- */
  .linkcard { display:flex; gap:8px; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:4px 0; font-size:12.5px; }
  .linkcard a { color:var(--accent); text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .linkcard a:hover { text-decoration:underline; }
  .linkcard .lh { color:var(--dim); font-size:11px; font-family:var(--mono); margin-left:auto; flex:none; }
  /* ---- syntax token colors (mini highlighter) ---- */
  .tok-k { color:#ff7b72; }
  .tok-s { color:#a5d6ff; }
  .tok-c { color:#8b949e; font-style:italic; }
  .tok-n { color:#79c0ff; }
  /* ---- upgraded markdown ---- */
  .say h1, .say h2, .say h3, .say h4 { margin:12px 0 6px; line-height:1.3; }
  .say h1 { font-size:19px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  .say h2 { font-size:16.5px; }
  .say h3 { font-size:14.5px; }
  .say h4 { font-size:13.5px; color:var(--dim); }
  .say p { margin:6px 0; }
  .say ul, .say ol { margin:6px 0 6px 0; padding-left:24px; }
  .say li { margin:2px 0; }
  .say blockquote { margin:8px 0; padding:2px 12px; border-left:3px solid var(--line); color:var(--dim); }
  .say a { color:var(--accent); }
  .say i { color:var(--text); opacity:.9; }
  .say table { border-collapse:collapse; margin:8px 0; font-size:12.5px; }
  .say table th, .say table td { border:1px solid var(--line); padding:4px 10px; text-align:left; }
  .say table th { background:var(--panel2); }
  .say code { cursor:text; }
  /* ---- settings view ---- */
  .setbox { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .provrow { display:flex; gap:10px; align-items:center; border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin-bottom:8px; background:var(--bg); }
  .provrow .pmain { flex:1; min-width:0; }
  .provrow .pnm { font-family:var(--mono); color:var(--accent); font-weight:600; font-size:13px; }
  .provrow .pmeta { color:var(--dim); font-family:var(--mono); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .provrow .pkey { font-size:11px; color:var(--ok); font-family:var(--mono); }
  .provrow .pkey.none { color:var(--warn); }
  .provrow .ppur { font-size:10.5px; color:var(--dim); background:var(--panel2); border-radius:8px; padding:0 7px; }
  .provrow .pacts { display:flex; gap:4px; flex:none; }
  .provform { border:1px solid var(--accent); border-radius:10px; padding:12px 14px; margin-bottom:10px; background:var(--panel); }
  .provform .fgrid { display:grid; grid-template-columns:110px 1fr; gap:7px 10px; align-items:center; }
  .provform label { font-size:12px; color:var(--dim); }
  .provform input[type=text], .provform input[type=password] { background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:6px; padding:5px 8px; font:12px var(--mono); outline:none; width:100%; }
  .provform input:focus { border-color:var(--accent); }
  .presetgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:8px; }
  .presetrow { display:flex; align-items:center; gap:8px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:12px; }
  .presetrow .pm { font-family:var(--mono); color:var(--text); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .presetrow .penv { font-size:10.5px; color:var(--dim); font-family:var(--mono); }
  .setrow { display:flex; align-items:center; gap:12px; padding:7px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  .setrow:last-of-type { border-bottom:0; }
  .setrow span { flex:1; }
  .setrow input[type=number] { width:80px; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:6px; padding:4px 8px; font:12px var(--mono); outline:none; }
  #set-msg { color:var(--ok); font-size:12.5px; margin-left:10px; }
  #set-msg.err { color:var(--err); }
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
      <button class="nav" data-view="settings"><span class="ico">⚙️</span><span class="txt minhide">设置</span></button>
      <button class="nav" data-view="label"><span class="ico">⭐</span><span class="txt minhide">RL 标注</span></button>
    </nav>
    <div class="wshead"><span class="minhide" id="ws-label">工作区</span><span class="wsacts minhide"><button id="ws-refresh" title="刷新会话列表">↻</button><button id="ws-open" title="在文件管理器中打开工作区">📂</button><button id="ws-new" title="添加工作区">＋</button></span></div>
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
      <span class="chip" id="goal-chip" title="会话目标" style="display:none;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <button id="theme-chip" class="ghost sm" title="theme">🌓</button>
      <span id="topspacer" style="margin-left:auto"></span>
      <button id="clear" class="ghost sm">clear</button>
    </div>
    <div id="view-chat" class="vwrap on">
      <div id="goalrow" style="display:none;margin:8px 16px 0;display:none;gap:6px;align-items:center;max-width:640px"><input id="goal-input" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px inherit;outline:none" placeholder=""><button id="goal-set" type="button" class="ghost sm">✓</button><button id="goal-clear" type="button" class="ghost sm">✕</button></div>
      <div id="plancard" style="display:none"><div class="phead"><span>▦</span><span id="plancard-title"></span><span style="margin-left:auto;color:var(--dim)">▲</span></div><div class="psteps" id="plancard-steps"></div></div>
      <div id="log"><div id="empty"><div style="font-size:30px">⚙️</div><div id="empty-title" style="margin:8px 0 4px;font-size:16px">给 hmh 一个任务</div><div id="empty-sub" style="font-size:12.5px">流式输出 · 浏览器审批 · 全程审计</div><div style="margin-top:14px"></div><div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div><div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div><div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div></div>
      <button id="tobot" class="ghost sm">↓</button>
      <div id="composer">
        <div id="runstatus"><span id="rs-spin">✻</span><span id="rs-text"></span></div>
        <div id="queuebar"></div>
        <div id="approval">
          <div><span id="approval-req-label">审批请求:</span><span class="name" id="ap-name"></span> <span id="ap-args" class="dim" style="font-family:var(--mono);color:var(--dim)"></span></div>
          <div style="margin-top:8px"><button id="ap-yes" class="primary sm">批准</button> <button id="ap-no" class="danger sm">拒绝</button></div>
        </div>
        <div id="slashpanel"></div>
        <div id="atpanel"></div>
        <div id="attbar"></div>
        <input type="file" id="imgfile" accept="image/png,image/jpeg,image/webp" multiple style="display:none">
        <div id="inputcard">
          <textarea id="input" placeholder="给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)"></textarea>
          <div id="tools-row">
          <button id="attach" type="button" title="粘贴或选择图片附件">📎</button>
          <div style="position:relative">
          <select id="mode" title="approval mode">
            <option value="ask">🔒 审批询问</option>
            <option value="auto">⚡ 自动批准</option>
            <option value="yolo">🔥 YOLO</option>
          </select>
          <button id="preset-btn" type="button" title="权限预设">▾</button>
          <div id="presetpop">
            <button type="button" class="preset" data-mode="ask"><span class="pt">🔒 审批询问</span><div class="pd">每步危险操作都弹审批,逐步确认</div></button>
            <button type="button" class="preset" data-mode="auto"><span class="pt">⚡ 自动批准</span><div class="pd">常规操作自动放行,破坏性命令仍硬拒</div></button>
            <button type="button" class="preset" data-mode="yolo"><span class="pt">🔥 YOLO</span><div class="pd">完全无人值守,危险命令仍硬拒</div></button>
          </div>
          </div>
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
    </div>
    <div id="view-ssh" class="view">
      <div class="vhead"><h2 id="ssh-title">SSH</h2><button id="ssh-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="ssh-body">
        <div id="ssh-empty" class="hint">未配置 SSH 主机 — 在 config.json 添加 sshHosts({name,host,user,port,keyPath}) 后刷新</div>
        <div id="ssh-panels"></div>
      </div>
    </div>
    <div id="view-skills" class="view">
      <div class="vhead"><h2 id="sk-title">技能中心</h2></div>
      <div id="sk-body"></div>
    </div>
    <div id="view-settings" class="view">
      <div class="vhead"><h2 id="set-title">设置</h2></div>
      <div class="setbox" id="set-model">
        <h3 class="sec" id="set-model-title">模型 / Providers</h3>
        <div id="prov-list"></div>
        <button id="prov-add" class="ghost sm">＋ 新增 provider</button>
        <h3 class="sec" id="set-presets-title">内置预设（一键添加）</h3>
        <div id="prov-presets" class="presetgrid"></div>
      </div>
      <div class="setbox" id="set-general">
        <h3 class="sec" id="set-general-title">常规</h3>
        <div class="setrow"><span id="set-locale-label">语言 locale</span><select id="set-locale"><option value="zh">中文</option><option value="en">English</option></select></div>
        <div class="setrow"><span id="set-approval-label">默认审批模式</span><select id="set-approval"><option value="ask">🔒 ask（询问）</option><option value="auto">⚡ auto（自动放行）</option></select></div>
        <div class="setrow"><span id="set-evolve-label">自动进化间隔 autoEvolveEvery（0=关闭）</span><input id="set-evolve" type="number" min="0" max="100"></div>
        <div class="setrow"><span id="set-patch-label">代码级自进化 evolution.autoPatch（危险）</span><input id="set-patch" type="checkbox"></div>
        <div style="margin-top:10px"><button id="set-save" class="primary sm">保存</button><span id="set-msg"></span></div>
      </div>
    </div>
    <div id="view-label" class="view">
      <div class="vhead"><h2 id="label-title">RL 标注</h2></div>
      <div id="label-prog" style="margin:0 0 10px;font-size:12.5px;color:var(--dim)"></div>
      <div id="label-hint" style="margin:0 0 12px;font-size:12px;color:var(--dim)"></div>
      <div id="label-body"></div>
    </div>
  </div>
  <div id="rightbar">
    <div id="rdrag"></div>
    <div id="rhead">
      <div id="rtabs">
        <button type="button" class="rtab on" data-tab="detail" id="rtab-detail">详情</button>
        <button type="button" class="rtab" data-tab="files" id="rtab-files">文件</button>
        <button type="button" class="rtab" data-tab="preview" id="rtab-preview">预览</button>
      </div>
      <button id="rcollapse" class="ghost sm" title="折叠右栏" style="margin-left:auto">»</button>
      <button id="rclose" class="ghost sm" title="关闭右栏">✕</button>
    </div>
    <div id="rbody">
      <div id="rtab-detail-pane" class="rtabpane on">
        <div id="dname"></div>
        <div id="dbody"><div id="dempty">点击对话流中的工具行查看详情</div></div>
      </div>
      <div id="rtab-files-pane" class="rtabpane">
        <div id="ftree"></div>
      </div>
      <div id="rtab-preview-pane" class="rtabpane">
        <div id="pview"><div class="hint" style="padding:10px">在文件树或对话中点击文件路径在此预览</div></div>
      </div>
    </div>
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
${uiLiteSource()}
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
    zh: { title:'hmh web', idle:'空闲', running:'运行中…', send:'运行', sendNow:'发送', stop:'停止', stopTitle:'停止当前任务(排队任务继续)', queueTitle:'发送后将排队,当前任务完成后自动运行', queueClear:'清空队列', queueRemove:'移除该排队任务', approve:'批准', deny:'拒绝',
          fbUp:'有帮助', fbDown:'没帮助', planCard:'计划', goalPh:'会话目标(Enter 保存 / 点 ✕ 清除)', sessSearch:'搜索本会话内容…',
          approvalReq:'审批请求:', skills:'技能', sessions:'最近会话', none2:'(无)', ungrouped:'未归类',
          placeholder:'给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
          newLabel:'新会话', searchPh:'搜索会话…', skillsN:'技能',
          emptyTitle:'给 hmh 一个任务', emptySub:'流式输出 · 浏览器审批 · 全程审计', alreadyRunning:'已有一个任务在运行', queuedHint:'已排队',
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
          wsAdd:'＋ 添加工作区', wsOpen:'在文件管理器中打开工作区', wsName:'名称(默认目录名)', wsPath:'或直接输入绝对路径, 回车前往', wsOk:'添加',
          pickTitle:'选择工作区目录', thisPC:'此电脑', cancel:'取消', up:'上一级',
          wsSwitch:'切换工作区', wsRemove:'移除注册(不删目录)', curSessions:'本工作区会话', otherSessions:'其他 / 未分组',
           navSet:'设置', navLabel:'RL 标注', labelTitle:'RL 奖励标注', labelHint:'给每个会话的表现打 1-5 星(5=非常好)。这些人工评分用于校准奖励信号与模型自评的相关性——RL 就绪门的最后一个条件(需要 100 条)。', labelDone:'✓ 已达 100 条,RL 门最后一格解锁!', labelEmpty:'(没有待标注的会话了——先跑几个任务再回来)', viewSet:'设置', setTitle:'设置', setModelTitle:'模型 / Providers', setPresetsTitle:'内置预设（一键添加）', setGeneralTitle:'常规',
           setLocaleLabel:'语言 locale', setApprovalLabel:'默认审批模式', setEvolveLabel:'自动进化间隔 autoEvolveEvery（0=关闭）', setPatchLabel:'代码级自进化 autoPatch（危险，默认关）', setSave:'保存', setSaved:'已保存 ✓', setFailed:'保存失败',
           provAdd:'＋ 新增 provider', provEdit:'编辑', provDelete:'删除', provSave:'保存', provCancel:'取消', provApiKeySet:'密钥已设置', provApiKeyNone:'未设置密钥', provAddPreset:'添加',
           provName:'名称', provBaseUrl:'baseUrl', provModel:'model', provApiKey:'apiKey', provAuthHeader:'authHeader(可选)', provSupportsVision:'支持视觉', provKeyPhNew:'新 provider 需要填写 apiKey', provKeyPhEdit:'留空=保持原密钥；输入空格再清空=删除密钥',
           provDeleteConfirm:'删除该 provider?（config.json 就地改写，不可撤销）', presetEnv:'需环境变量', presetLocal:'本地端点',
           rtabDetail:'详情', rtabFiles:'文件', rtabPreview:'预览', rcollapse:'折叠右栏', rclose:'关闭右栏',
           pvHint:'在文件树或对话中点击文件路径在此预览', pvBinary:'二进制文件，无法预览（', pvTrunc:'(仅前 64KB)', pvNotFile:'文件不存在或在工作区外',
           slashHint:'↑↓ 选择 · Enter 插入 · Esc 关闭', atHint:'↑↓ 选择 · Enter 插入路径 · Esc 关闭', injHint:'运行中: Enter=排队 · Ctrl+Enter=注入当前轮', injected:'已注入当前轮', queueNone:'(空)',
           cmdOk:'命令结果', cmdHelp:'命令', searchAt:'输入 @ 搜索工作区文件…',
           webCmds: { '/help':'列出 Web 可用命令', '/clear':'清屏并开新线程', '/status':'当前模型/语言/队列状态', '/model':'查看/切换模型路由', '/lang':'切换语言 zh/en', '/yolo':'全自动审批开关', '/providers':'检测本机可用厂商', '/tools':'列出全部工具', '/skills':'列出技能', '/mcp':'列出 MCP 服务器', '/ops':'鸿蒙工具链体检', '/ops scan':'生态雷达扫描', '/resume':'从左侧会话列表回看', '/web':'显示 web 地址', '/exit':'退出提示' } },
    en: { title:'hmh web', idle:'idle', running:'running…', send:'Run', sendNow:'Send', stop:'Stop', stopTitle:'stop the current task (queued tasks still run)', queueTitle:'queues; runs when the current task finishes', queueClear:'clear queue', queueRemove:'remove this queued task',
          fbUp:'helpful', fbDown:'not helpful', planCard:'Plan', goalPh:'session goal (Enter saves / ✕ clears)', sessSearch:'search in session…', approve:'Approve', deny:'Deny',
          approvalReq:'Approval request:', skills:'skills', sessions:'recent sessions', none2:'(none)', ungrouped:'ungrouped',
          placeholder:'give hmh a task… (Enter to send, Shift+Enter for newline)',
          newLabel:'New session', searchPh:'search sessions…', skillsN:'skills',
          emptyTitle:'give hmh a task', emptySub:'streaming · browser approvals · fully audited', alreadyRunning:'a task is already running', queuedHint:'queued',
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
          wsAdd:'＋ add workspace', wsOpen:'open the workspace in the file manager', wsName:'name (defaults to folder name)', wsPath:'or type an absolute path and press Enter', wsOk:'Add',
          pickTitle:'Choose workspace folder', thisPC:'This PC', cancel:'Cancel', up:'Up one level',
          wsSwitch:'switch workspace', wsRemove:'unregister (keeps the folder)', curSessions:'this workspace', otherSessions:'other / ungrouped',
           navSet:'Settings', navLabel:'RL Labels', labelTitle:'RL Reward Labels', labelHint:'Rate each session 1-5 stars (5 = excellent). These human scores calibrate the reward signal against the model self-eval - the last RL readiness gate condition (100 needed).', labelDone:'\u2713 100 reached - the last RL gate slot unlocks!', labelEmpty:'(no sessions to label - run a few tasks first)', viewSet:'Settings', setTitle:'Settings', setModelTitle:'Models / Providers', setPresetsTitle:'Built-in presets (one-click add)', setGeneralTitle:'General',
           setLocaleLabel:'locale', setApprovalLabel:'default approval mode', setEvolveLabel:'auto-evolve every N insights (0=off)', setPatchLabel:'code-level self-evolution autoPatch (dangerous, off by default)', setSave:'Save', setSaved:'Saved ✓', setFailed:'Save failed',
           provAdd:'＋ add provider', provEdit:'Edit', provDelete:'Delete', provSave:'Save', provCancel:'Cancel', provApiKeySet:'api key set', provApiKeyNone:'no api key', provAddPreset:'Add',
           provName:'name', provBaseUrl:'baseUrl', provModel:'model', provApiKey:'apiKey', provAuthHeader:'authHeader (optional)', provSupportsVision:'supports vision', provKeyPhNew:'a new provider needs its apiKey', provKeyPhEdit:'blank = keep the existing key; type a space then clear = remove it',
           provDeleteConfirm:'Delete this provider? (config.json is rewritten in place, not recoverable)', presetEnv:'needs env var', presetLocal:'local endpoint',
           rtabDetail:'Detail', rtabFiles:'Files', rtabPreview:'Preview', rcollapse:'collapse', rclose:'close',
           pvHint:'click a file path in the file tree or the chat to preview it here', pvBinary:'binary file, cannot preview (', pvTrunc:'(first 64KB only)', pvNotFile:'file not found or outside the workspace',
           slashHint:'↑↓ select · Enter insert · Esc close', atHint:'↑↓ select · Enter insert path · Esc close', injHint:'while running: Enter=queue · Ctrl+Enter=inject this turn', injected:'injected into the current turn', queueNone:'(empty)',
           cmdOk:'command output', cmdHelp:'commands', searchAt:'type @ to search workspace files…',
           webCmds: { '/help':'list web commands', '/clear':'clear screen, new thread', '/status':'model/locale/queue state', '/model':'list/switch chat route', '/lang':'switch locale zh/en', '/yolo':'toggle hands-free approvals', '/providers':'detect local providers', '/tools':'list all tools', '/skills':'list skills', '/mcp':'list MCP servers', '/ops':'harmony toolchain check', '/ops scan':'ecosystem radar scan', '/resume':'revisit sessions in the sidebar', '/web':'show the web address', '/exit':'how to quit' } }
  };
  function setLabels(loc) {
    L = LABELS[loc === 'en' ? 'en' : 'zh'];
    document.title = L.title;
    updateSendBtn();
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
    document.getElementById('ws-open').title = L.wsOpen;
    document.getElementById('wscur').title = L.wsSwitch;
    var navNames = { chat:L.navChat, board:L.navBoard, devices:L.navDev, ssh:L.navSsh, skills:L.navSk, settings:L.navSet, label:L.navLabel };
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) {
      var txt = n.querySelector('.txt');
      if (txt) txt.textContent = navNames[n.getAttribute('data-view')] || '';
    });
    document.getElementById('viewchip').textContent =
      ({ chat:L.viewChat, board:L.viewBoard, devices:L.viewDev, ssh:L.viewSsh, skills:L.viewSk, settings:L.viewSet })[curView] || curView;
    // settings view chrome
    document.getElementById('set-title').textContent = L.viewSet;
    document.getElementById('set-model-title').textContent = L.setModelTitle;
    document.getElementById('set-presets-title').textContent = L.setPresetsTitle;
    document.getElementById('set-general-title').textContent = L.setGeneralTitle;
    document.getElementById('set-locale-label').textContent = L.setLocaleLabel;
    document.getElementById('set-approval-label').textContent = L.setApprovalLabel;
    document.getElementById('set-evolve-label').textContent = L.setEvolveLabel;
    document.getElementById('set-patch-label').textContent = L.setPatchLabel;
    document.getElementById('set-save').textContent = L.setSave;
    document.getElementById('prov-add').textContent = L.provAdd;
    document.getElementById('rtab-detail').textContent = L.rtabDetail;
    document.getElementById('rtab-files').textContent = L.rtabFiles;
    document.getElementById('rtab-preview').textContent = L.rtabPreview;
    document.getElementById('rcollapse').title = L.rcollapse;
    document.getElementById('rclose').title = L.rclose;
    var pvh = document.querySelector('#pview .hint');
    if (pvh) pvh.textContent = L.pvHint;
    if (document.getElementById('dempty')) document.getElementById('dempty').textContent = L.dempty;
  }

  /* ---- view switching / sidebar collapse ---- */
  function switchView(v) {
    curView = v;
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (n) {
      n.classList.toggle('on', n.getAttribute('data-view') === v);
    });
    ['chat', 'board', 'devices', 'ssh', 'skills', 'settings', 'label'].forEach(function (k) {
      var elv = document.getElementById('view-' + k);
      if (elv) elv.classList.toggle('on', k === v);
    });
    var shown = document.getElementById('view-' + v);
    if (shown) window.__AN.viewIn(shown);
    if (L) {
      document.getElementById('viewchip').textContent =
        ({ chat:L.viewChat, board:L.viewBoard, devices:L.viewDev, ssh:L.viewSsh, skills:L.viewSk, settings:L.viewSet })[v] || v;
    }
    if (v === 'board') loadBoard();
    if (v === 'devices') loadDevices();
    if (v === 'ssh') renderSsh();
    if (v === 'skills') renderSkills();
    if (v === 'settings') renderSettings();
    if (v === 'label') renderLabels();
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
  /* Markdown/diff/plan/deliverable pure logic lives in uilite.ts and is
     injected above via uiLiteSource() — renderMarkdown / looksLikeDiff /
     parseUnifiedDiff / extractPlan / extractDeliverables. Single source of
     truth, tested by packages/web/src/__tests__/uilite.test.ts. */
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
      finalize: function () { box.classList.remove('open'); },
      discard: function () { if (box.parentNode) box.parentNode.removeChild(box); }
    };
  }
  function sayBlock() {
    clearEmpty();
    var e = el('div', 'say');
    var txt = '';
    return {
      add: function (c) { txt += c; e.textContent = txt; autoscroll(); },
      finalize: function () { e.innerHTML = renderMarkdown(txt); lastAssistantText = txt; autoscroll(); },
      discard: function () { if (e.parentNode) e.parentNode.removeChild(e); }
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
    // The input stays ENABLED while the agent runs (user request): new tasks
    // are accepted and queued server-side. The send button is also live —
    // submitting during a run shows a "queued" notice instead of being dead.
    // (Was: input.disabled = b — the input was parked during every run.)
    // settled design W6: 运行中 Enter=排队、Ctrl+Enter=注入当前轮（placeholder 提示）
    var ph = document.getElementById('input');
    if (ph) ph.placeholder = b ? L.injHint : L.placeholder;
    window.__agentBusy = !!b;
    updateSendBtn();
  }

  function renderState(s) {
    state = s;
    setLabels(s.locale || 'zh');
    renderQueue(s.queue || []);
    // mid-run page reload: no 'busy' SSE event will fire until the task ends,
    // so the composer state (stop button, runstatus) must come from state too
    if (typeof s.busy === 'boolean' && s.busy !== !!window.__agentBusy) setBusy(s.busy);
    document.getElementById('model').textContent = s.model;
    document.getElementById('model2').textContent = s.model;
    renderModelPick(s);
    var hp = s.workspace && s.workspace.path ? s.workspace.path : s.home;
    document.getElementById('home').textContent = hp;
    document.getElementById('home').title = hp;
    // A11 theme + A6 goal from the persisted state
    applyTheme((s.settings && s.settings.theme) || 'dark');
    var gc = document.getElementById('goal-chip');
    if (s.goal) { gc.style.display = ''; gc.textContent = '🎯 ' + s.goal; gc.title = s.goal; }
    else { gc.style.display = 'none'; }
    if (s.workspace) {
      curWs = s.workspace;
      var n = document.getElementById('wscur-name');
      if (n && n.textContent !== s.workspace.name) n.textContent = s.workspace.name;
      renderSessions(document.getElementById('search').value);
    }
    document.getElementById('skills-n').textContent = s.skills.active.length + s.skills.drafts.length;
    if (curView === 'skills') renderSkills();
    if (curView === 'settings') renderSettings();
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

  /* ---- settings view (A1): providers CRUD + general settings ----
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
          .then(function (res) { if (res.d && res.d.error) alert(res.d.error); })
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
    /* label queue display: the bench tasks are English templates - show a
     Chinese action summary instead (user request), original in the dim line */
  function zhTask(t) {
    var x = String(t || '');
    if (/sum of their line counts/i.test(x)) return '\u8BFB\u53D6\u4E24\u4E2A\u6587\u4EF6\uFF0C\u56DE\u7B54\u884C\u6570\u4E4B\u548C';
    if (/line count of module/i.test(x)) return '\u8BFB\u53D6\u6A21\u5757\u914D\u7F6E\u5E76\u5217\u76EE\u5F55\uFF0C\u56DE\u7B54\u884C\u6570';
    if (/mainElement/i.test(x)) return '\u8BFB\u53D6\u6A21\u5757\u914D\u7F6E\uFF0C\u56DE\u7B54 mainElement \u7684\u503C';
    if (/last word on the last line/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u672B\u884C\u672B\u8BCD';
    if (/first word of the first line/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u9996\u884C\u9996\u8BCD';
    if (/line count as a digit/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u56DE\u7B54\u884C\u6570';
    if (/FOUND if|MISSING/i.test(x)) return '\u8BFB\u53D6\u6587\u4EF6\uFF0C\u5224\u65AD\u662F\u5426\u5305\u542B\u6307\u5B9A\u8BCD';
    if (/number of files/i.test(x)) return '\u5217\u51FA\u76EE\u5F55\uFF0C\u56DE\u7B54\u6587\u4EF6\u6570\u91CF';
    return x;
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
        var t2 = document.createElement('div');
        t2.style.cssText = 'font-size:10.5px;color:var(--dim);font-family:var(--mono)';
        t2.textContent = it.session.slice(0, 18) + (it.task ? ' \u00B7 ' + it.task.slice(0, 40) : '');
        txt.appendChild(t1); txt.appendChild(t2);
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
        .then(function (res) { if (res.d && res.d.error) alert(res.d.error); })
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
  /** Group sessions BY PROJECT (their cwd), one collapsible section each.
   *  Registered workspaces show their display name; unregistered folders show
   *  the last path segment. The current workspace's group is first and open;
   *  others are collapsed by default so the sidebar stays scannable with
   *  hundreds of sessions (user request: "按项目为主菜单归类"). */
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
      var open = isCur || idx === 0 || !!f;
      head.innerHTML = '<span class="pcaret">' + (open ? '\\u25BE' : '\\u25B8') + '</span>'
        + '<span class="pname">' + projName(g.path) + '</span>'
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
        head.querySelector('.pcaret').textContent = vis ? '\\u25B8' : '\\u25BE';
      };
    });

    if (!groupOrder.length) {
      groupsEl.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px">' + L.none2 + '</div>';
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
  function viewSession(id) {
    flushStream();
    switchView('chat');
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      log.innerHTML = '';
      el('div', 'stats', '--- session ' + d.id + ' \\u00B7 ' + d.model + ' ---');
      // A15: session full-text search (filters the rendered previews)
      var sbox = document.createElement('div');
      sbox.style.cssText = 'display:flex;gap:6px;margin:4px 16px';
      var sin = document.createElement('input');
      sin.placeholder = (L ? L.sessSearch : 'search in session…');
      sin.style.cssText = 'flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px inherit;outline:none';
      sbox.appendChild(sin);
      log.appendChild(sbox);
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
        log.appendChild(strip);
      }
      var rows = [];
      d.messages.forEach(function (m) {
        if (m.role === 'user') rows.push({ kind: 'msg-user', html: m.text });
        else if (m.role === 'assistant') rows.push({ kind: m.tools && m.tools.length ? 'toolrow' : 'say', html: m.text || ('[calls: ' + (m.tools || []).join(', ') + ']') });
        else rows.push({ kind: 'toolres', html: m.text });
      });
      function renderRows(filter) {
        var existing = log.querySelectorAll('.msg-user,.toolrow,.say,.toolres');
        Array.prototype.forEach.call(existing, function (n) { n.remove(); });
        var q = (filter || '').toLowerCase();
        rows.forEach(function (r) {
          if (q && r.html.toLowerCase().indexOf(q) < 0) return;
          el('div', r.kind, r.html);
        });
        el('div', 'stats', '--- end ---');
        log.scrollTop = log.scrollHeight;
      }
      sin.oninput = function () { renderRows(sin.value); };
      renderRows('');
    });
  }

  /* ---- right column (W7): tabs 详情/文件/预览, collapsible, 300-600px drag ---- */
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
        ft.innerHTML = '<div class="hint">' + (L ? L.loading : '…') + '</div>';
        loadTree((state && state.workspace && state.workspace.path) || '', ft);
      }
    }
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
  function showDetails(seqId) {
    var d = toolRegistry[seqId];
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
        box.innerHTML = '<div class="hint">' + (L ? L.loading : '…') + '</div>';
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
        if (!res.ok) { box.innerHTML = '<div class="hint err">' + ((res.d && res.d.error) || 'failed') + '</div>'; return; }
        var d = res.d;
        (d.dirs || []).forEach(function (dir) { box.appendChild(fileRow(dir.name, dir.path, dir.path, 'dir')); });
        (d.files || []).forEach(function (f) { box.appendChild(fileRow(f.name, f.rel, f.path, 'file')); });
        if (!(d.dirs || []).length && !(d.files || []).length) box.innerHTML = '<div class="hint">' + L.none2 + '</div>';
      })
      .catch(function (e) { if (box.isConnected) box.innerHTML = '<div class="hint err">' + String(e) + '</div>'; });
  }
  function openPreview(rel) {
    openRight('preview');
    var box = document.getElementById('pview');
    box.innerHTML = '<div class="hint">' + (L ? L.loading : '…') + '</div>';
    fetch('/api/fs/read?path=' + encodeURIComponent(rel))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        var d = res.d || {};
        if (!res.ok || d.error) {
          box.innerHTML = '<div class="err">' + (d.error || L.pvNotFile) + '</div>';
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
      .catch(function (e) { box.innerHTML = '<div class="err">' + String(e) + '</div>'; });
  }
  // clickable file paths inside the chat: a path-looking <code> opens the preview tab
  function maybePath(t) {
    return /^[A-Za-z0-9_.\\/-]+\\.[a-zA-Z0-9]{1,8}$/.test(t) && t.length < 200 && t.indexOf(' ') < 0 && !/^https?:/.test(t);
  }
  log.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var code = t.closest('code');
    if (code && !t.closest('.codebar') && !t.closest('.copy') && maybePath(code.textContent.trim())) {
      openPreview(code.textContent.trim());
    }
  });

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
    log.appendChild(box);
    autoscroll();
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
      log.appendChild(card);
    });
    autoscroll();
  }
  function foldToolResult(d) {
    var fold = document.createElement('div');
    fold.className = 'toolfold' + (d.isError ? ' err' : '');
    var tri = document.createElement('span'); tri.className = 'tri'; tri.textContent = '\\u25B8';
    var lab = document.createElement('span');
    var pv = String(d.preview).replace(/\\s+/g, ' ').trim().slice(0, d.isError ? 110 : 72);
    lab.textContent = pv || '(done)';
    fold.appendChild(tri); fold.appendChild(lab);
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
    log.appendChild(fold);
    autoscroll();
  }
  var pendingToolRow = null;   // running tool row awaiting its result
  var es = new EventSource('/api/events');
  es.addEventListener('hello', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('state', function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener('busy', function (e) {
    var d = JSON.parse(e.data);
    setBusy(d.busy, d.mode);
    flushStream();
    // fromQueue: the task was already echoed when submitted - don't duplicate
    if (d.busy && !d.fromQueue) { lastTask = d.task; clearEmpty(); el('div', 'msg-user', d.task); }
  });
  es.addEventListener('queued', function (e) {
    var d = JSON.parse(e.data);
    el('div', 'queued', (L.queuedHint || 'queued') + ' #' + d.position + ' \\u2014 ' + d.task);
  });
  es.addEventListener('queue', function (e) {
    renderQueue(JSON.parse(e.data).items || []);
  });
  es.addEventListener('delta', function (e) {
    var d = JSON.parse(e.data);
    if (d.kind === 'reset') {
      // provider retried after a mid-stream cut: drop the half answer so the
      // regenerated text is not shown as a duplicate
      if (curBlock && curBlock.discard) curBlock.discard();
      curBlock = null; curKind = null;
      return;
    }
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
    // A7: spawn_agent renders as a distinct nested card (accent border + name)
    if (d.name === 'spawn_agent') row.classList.add('subagent');
    // A9: remember touched files for the deliverables chips at 'final'
    if (d.name === 'edit_file' || d.name === 'write_file') {
      var p0 = d.args && d.args.path;
      if (typeof p0 === 'string' && p0) deliverables.push({ name: d.name, args: { path: p0 } });
    }
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
    // keyed views (A4); default keeps W1: fold to one line, click to expand
    if (!d.isError && (d.name === 'edit_file' || d.name === 'write_file') && looksLikeDiff(d.full || d.preview || '')) {
      renderDiff(d);
      return;
    }
    if (d.name === 'web_search') renderSearchCards(d);
    foldToolResult(d);
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
    // A6 plan card + A9 deliverables + A10 feedback ride the final event
    if (lastAssistantText) renderPlanCard(lastAssistantText);
    renderDeliverables();
    var tok = (d.usage && (d.usage.promptTokens + d.usage.completionTokens) > 0) ? ' \\u00B7 \\u2191' + d.usage.promptTokens + ' \\u2193' + d.usage.completionTokens + ' tok' : '';
    el('div', 'stats', d.turns + ' turns \\u00B7 ' + d.toolUses + ' tool uses' + tok + ' \\u00B7 session ' + d.sessionId.slice(11));
    if (tok) document.getElementById('tokchip').textContent = tok.replace(' \\u00B7 ', '');
    if (lastAssistantText && lastTask) {
      var acts = document.createElement('div'); acts.className = 'acts';
      var bc = document.createElement('button'); bc.type = 'button'; bc.textContent = '\\u29C9 ' + L.copy;
      bc.onclick = function () { copyText(lastAssistantText); bc.textContent = '\\u2713'; setTimeout(function () { bc.textContent = '\\u29C9 ' + L.copy; }, 1200); };
      var br = document.createElement('button'); br.type = 'button'; br.textContent = '\\u27F3 ' + L.regen;
      br.onclick = function () { sendTask(lastTask); };
      var sessionId = d.sessionId;
      var fbUp = document.createElement('button'); fbUp.type = 'button'; fbUp.className = 'fb'; fbUp.textContent = '\\uD83D\\uDC4D';
      fbUp.title = L ? L.fbUp : 'helpful';
      fbUp.onclick = function () {
        fbUp.classList.add('on'); fbDown.classList.remove('on');
        fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, thumbs: 'up', text: lastAssistantText.slice(0, 200) }) });
      };
      var fbDown = document.createElement('button'); fbDown.type = 'button'; fbDown.className = 'fb'; fbDown.textContent = '\\uD83D\\uDC4E';
      fbDown.title = L ? L.fbDown : 'not helpful';
      fbDown.onclick = function () {
        fbDown.classList.add('on'); fbUp.classList.remove('on');
        fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, thumbs: 'down', text: lastAssistantText.slice(0, 200) }) });
      };
      acts.appendChild(fbUp); acts.appendChild(fbDown);
      acts.appendChild(bc); acts.appendChild(br);
      log.appendChild(acts);
      autoscroll();
    }
    loadSessions();
  });
  es.addEventListener('injected', function (e) {
    flushStream();
    clearEmpty();
    el('div', 'msg-inject', '\\u21AA ' + (L ? L.injected : 'injected') + ': ' + JSON.parse(e.data).text);
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
      inp.value = goalChip.textContent === '' ? '' : goalChip.textContent;
      inp.focus();
    }
  };
  document.getElementById('goal-set').onclick = function () {
    var v = document.getElementById('goal-input').value.trim();
    fetch('/api/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: v })
    });
    goalRow.style.display = 'none';
  };
  document.getElementById('goal-clear').onclick = function () {
    fetch('/api/goal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '' })
    });
    goalRow.style.display = 'none';
  };

  // ---- A6 plan card (checkable numbered-step list pinned at the top) ----
  function renderPlanCard(text) {
    var steps = extractPlan(text);
    var card = document.getElementById('plancard');
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
  var deliverables = [];
  function renderDeliverables() {
    var box = document.getElementById('deliv');
    if (!box) {
      box = document.createElement('div');
      box.id = 'deliv';
      log.appendChild(box);
    }
    var paths = extractDeliverables(deliverables);
    if (paths.length === 0) return;
    box.innerHTML = '';
    paths.forEach(function (p) {
      var chip = document.createElement('span');
      chip.className = 'deliv';
      chip.textContent = p.split(/[\\\\/]/).pop();
      chip.title = p;
      chip.onclick = function () { openPreview(p); };
      box.appendChild(chip);
    });
    var stats = log.querySelector('.stats');
    if (stats) log.insertBefore(box, stats);
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

  // ---- composer ----
  // Codex-style single button: it is a SEND button when there is text to
  // send (idle: runs now; busy: queues) and a STOP button when the agent is
  // running and the box is empty. No slash commands, no separate stop
  // control - one affordance, state decides.
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
  function interrupt() {
    fetch('/api/interrupt', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.error) el('div', 'err', d.error); })
      .catch(function (err) { el('div', 'err', String(err)); });
  }
  function sendTask(text) {
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
      fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: text }) })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.status === 404 || (res.d && res.d.error)) renderCmdResult(res.d && res.d.error ? res.d.error : 'unknown command', true);
          else if (res.d && res.d.text) renderCmdResult(res.d.text);
        })
        .catch(function (err) { renderCmdResult(String(err), true); });
      return;
    }
    if (!window.__agentBusy) el('div', 'msg-user', text);
    var body = { text: text, yes: document.getElementById('mode').value !== 'ask', mode: document.getElementById('mode').value };
    var files = [];
    var images = [];
    attachments.forEach(function (a) { if (a.kind === 'image') images.push({ name: a.name, dataUrl: a.dataUrl }); else files.push(a.path); });
    if (files.length) body.attachments = files;
    if (images.length) body.images = images;
    attachments = [];
    renderAtts();
    fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.d && res.d.queued) {
          el('div', 'queued', (L.queuedHint || 'queued') + ' #' + res.d.position + ' — ' + text);
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
      em.textContent = palMode === 'at' ? L.pvNotFile : '';
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
    fetch('/api/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
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

  // ---- sidebar actions ----
  function newSession() {
    flushStream();
    switchView('chat');
    log.innerHTML = '<div id="empty"><div style="font-size:30px">\\u2699\\uFE0F</div><div style="margin:8px 0 4px;font-size:16px">' + L.emptyTitle + '</div><div style="font-size:12.5px">' + L.emptySub + '</div><div style="margin-top:14px"></div>' +
      '<div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div>' +
      '<div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div>' +
      '<div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div>';
    wireExamples();
    document.getElementById('rightbar').classList.remove('open');
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
  // settled design W14: 📂 opens the active workspace in the system file
  // manager — POST /api/open (insideWs guard server-side; explorer /select)
  document.getElementById('ws-open').onclick = function () {
    if (!curWs.path) return;
    fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: curWs.path }) })
      .then(function (r) { return r.json(); })
      .then(function (d2) { if (d2 && d2.error) alert(d2.error); })
      .catch(function (err) { alert(String(err)); });
  };
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
