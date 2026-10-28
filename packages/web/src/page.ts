/**
 * @hmharness/web - page(P1-3 拆分装配层)
 * 原单文件 page.ts(3832 行)按交互域拆分到 page/*.ts,本文件只剩装配:
 * 按页面原始顺序拼接各域片段 + 唯一模板洞 uiLiteSource()(uilite 纯函数
 * 内联)。最终 PAGE 与拆分前逐字节一致(拆分期守门脚本)。模板字面量规则:
 * 无裸反引号,页面 JS 内不用插值,正则反斜杠双写。
 */
import { uiLiteSource } from './uilite.ts';
import { CORE } from './page/core.ts';
import { WORKSPACES } from './page/workspaces.ts';
import { VIEWS } from './page/views.ts';
import { SETTINGS } from './page/settings.ts';
import { SESSIONS } from './page/sessions.ts';
import { DOCK } from './page/dock.ts';
import { SSE } from './page/sse.ts';
import { CHROME } from './page/chrome.ts';
import { COMPOSER } from './page/composer.ts';
import { SHELL } from './page/shell.ts';

export const PAGE =
  `<!doctype html>
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
  /* ---- responsive (docx P1 #10 Mobile Web): tablet -> right column becomes a
     bottom sheet; phone -> sidebar becomes an overlay drawer with a hamburger,
     hover-only affordances become always-visible. Key actions never need hover. */
  @media (max-width: 768px) {
    .sess .sacts { display:flex; opacity:.85; }
    .sess { padding-right: 66px; }
    #rightbar.open { position:fixed; left:0; right:0; bottom:0; top:auto; width:auto !important; height:62vh; border-left:0; border-top:1px solid var(--line); border-radius:14px 14px 0 0; z-index:70; box-shadow:0 -18px 50px rgba(0,0,0,.5); }
    #rdrag { display:none; }
    #rtab-preview-pane .pvcode, #rtab-detail-pane #dbody pre { font-size:11px; }
    #approval button { padding:10px 18px; }
    .msg-user { max-width:92%; }
    #log { padding:12px 10px; }
  }
  @media (max-width: 640px) {
    #app { grid-template-columns:1fr auto; }
    body.mobside #side { position:fixed; left:0; top:0; bottom:0; width:280px; z-index:80; box-shadow:14px 0 40px rgba(0,0,0,.5); }
    body:not(.mobside) #side { display:none; }
    body.mobside::after { content:''; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:75; }
    #sideburger { display:inline-flex !important; }
    #viewchip, #home { display:none; }
    #composer { padding:8px 8px calc(8px + env(safe-area-inset-bottom, 0px)); }
    #input { font-size:16px !important; } /* >=16px stops iOS zoom-on-focus */
    .vhead h2 { font-size:14px; }
    #deliv .deliv { font-size:10px; }
  }
  #sideburger { display:none; background:none; border:1px solid var(--line); border-radius:7px; color:var(--text); cursor:pointer; font-size:15px; padding:3px 9px; }
  /* ---- phone pairing modal (docx remote control, deepseek-harness pattern) ---- */
  #pairmod { display:none; position:fixed; inset:0; background:rgba(4,8,12,.62); z-index:95; align-items:center; justify-content:center; }
  #pairmod.on { display:flex; }
  #pairmod .card { width:380px; max-width:92vw; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px 22px; display:flex; flex-direction:column; align-items:center; gap:10px; box-shadow:0 24px 70px rgba(0,0,0,.6); }
  #pairmod h3 { margin:0; font-size:15px; }
  #pairmod .qr { background:#fff; border-radius:10px; padding:10px; line-height:0; }
  #pairmod .qr img { width:220px; height:220px; }
  #pairmod .url { font-family:var(--mono); font-size:11px; color:var(--accent); word-break:break-all; text-align:center; max-width:100%; }
  #pairmod .pin { font-family:var(--mono); font-size:30px; font-weight:800; color:var(--ok); letter-spacing:8px; }
  #pairmod .pinlab { font-size:11px; color:var(--dim); }
  #pairmod .hint { font-size:12px; color:var(--dim); text-align:center; }
  #pairmod button { margin-top:6px; }

  /** Structured error text (docx): prefer the human action over the raw string. */
  function errText(d) {
    if (!d) return 'error';
    if (d.action) return d.action + (d.error ? ' (' + String(d.error).slice(0, 120) + ')' : '');
    return String(d.error || 'error');
  }

  /* ---- command palette (docx Web 专项): Ctrl+K global console ---- */
  #cmdpal { display:none; position:fixed; inset:0; background:rgba(4,8,12,.55); z-index:90; align-items:flex-start; justify-content:center; padding-top:12vh; }
  #cmdpal.on { display:flex; }
  #cmdpal .card { width:520px; max-width:92vw; background:var(--panel); border:1px solid var(--line); border-radius:12px; box-shadow:0 24px 70px rgba(0,0,0,.6); overflow:hidden; }
  #cmdpal input { width:100%; background:var(--bg); border:0; border-bottom:1px solid var(--line); color:var(--text); font:14px inherit; padding:12px 14px; outline:none; }
  #cmdpal .list { max-height:330px; overflow-y:auto; padding:5px; }
  #cmdpal .row { display:flex; gap:10px; align-items:baseline; padding:8px 11px; border-radius:8px; cursor:pointer; font-size:13px; }
  #cmdpal .row.sel { background:var(--panel2); }
  #cmdpal .row .k { font-family:var(--mono); color:var(--accent); white-space:nowrap; }
  #cmdpal .row .d { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #cmdpal .foot { border-top:1px dashed var(--line); color:var(--dim); font-size:11px; padding:6px 12px; }
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
  .turncard { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:baseline; padding:8px 12px; margin:10px 0 4px; border:1px solid var(--line); border-radius:10px; background:var(--panel2); font-size:12px; }
  .turncard .tseg { display:inline-flex; gap:5px; align-items:baseline; }
  .turncard .tlab { color:var(--dim); }
  .turncard .tnum { color:var(--text); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .turncard .tseg.strong .tnum { font-weight:600; }
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
  .riskbadge { font-size:11px; border-radius:9px; padding:1px 9px; font-weight:600; }
  .riskbadge.low { background:rgba(63,185,80,.15); color:var(--ok); }
  .riskbadge.medium { background:rgba(227,179,65,.15); color:var(--warn); }
  .riskbadge.high { background:rgba(248,81,73,.15); color:var(--err); }
  #connchip { display:none; font-size:11px; padding:2px 9px; border-radius:11px; background:var(--panel2); color:var(--dim); }
  #connchip.reconnecting { display:inline-block; background:rgba(227,179,65,.18); color:var(--warn); }
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
      <button class="nav" data-view="cognitive"><span class="ico">🧠</span><span class="txt minhide">认知面板</span></button>
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
      <button id="sideburger" title="会话">☰</button>
      <span class="chip" id="viewchip">对话</span>
      <span class="chip" id="home"></span>
      <span class="chip" id="locale-chip">zh</span>
      <span class="chip" id="goal-chip" title="会话目标" style="display:none;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <span class="chip" id="hud-chip" title="认知状态" style="display:none;gap:6px;font-family:var(--mono);font-size:11px;cursor:pointer"></span>
      <button id="theme-chip" class="ghost sm" title="theme">🌓</button>
      <span id="topspacer" style="margin-left:auto"></span>
      <span id="connchip" title="connection">⟳ 重连中…</span>
      <button id="phone-pair" title="📱 手机远程控制" style="display:none;background:none;border:1px solid var(--line);border-radius:7px;color:var(--text);cursor:pointer;font-size:15px;padding:3px 9px">📱</button>
      <button id="clear" class="ghost sm">clear</button>
    </div>
    <div id="view-chat" class="vwrap on">
      <div id="goalrow" style="display:none;margin:8px 16px 0;display:none;gap:6px;align-items:center;max-width:640px"><input id="goal-input" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px inherit;outline:none" placeholder=""><button id="goal-set" type="button" class="ghost sm">✓</button><button id="goal-clear" type="button" class="ghost sm">✕</button></div>
      <div id="plancard" style="display:none"><div class="phead"><span>▦</span><span id="plancard-title"></span><span style="margin-left:auto;color:var(--dim)">▲</span></div><div class="psteps" id="plancard-steps"></div></div>
      <div id="log"><div id="empty"><div style="font-size:30px">⚙️</div><div id="empty-title" style="margin:8px 0 4px;font-size:16px">给 hmh 一个任务</div><div id="empty-sub" style="font-size:12.5px">流式输出 · 浏览器审批 · 全程审计</div><div style="margin-top:14px"></div><div class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</div><div class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</div><div class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</div></div></div>
      <button id="tobot" class="ghost sm">↓</button>
      <div id="composer">
        <div id="runstatus"><span id="rs-spin">✻</span><span id="rs-text"></span><span id="rs-phase" style="margin-left:auto;font-family:var(--mono);font-size:11.5px"></span></div>
        <div id="queuebar"></div>
        <div id="approval">
          <div><span id="approval-req-label">审批请求:</span><span class="name" id="ap-name"></span> <span id="ap-args" class="dim" style="font-family:var(--mono);color:var(--dim)"></span></div>
          <div id="ap-meta" style="margin-top:4px"></div>
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
    <div id="view-cognitive" class="view">
      <div class="vhead"><h2 id="cog-title">🧠 认知面板</h2><button id="cog-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="cog-body">
        <div class="setbox"><h3 class="sec">五层记忆</h3><div id="cog-memory" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">世界模型（轨迹回放）</h3><div id="cog-world" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">校准报告（实证价值所在）</h3><div id="cog-calib" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">目标漂移检测</h3><div id="cog-drift" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">技能候选（历史挖掘）</h3><div id="cog-skills" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">多智能体（治理审计）</h3><div id="cog-team" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">迁移矩阵（对照实验）</h3><div id="cog-transfer" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">轨迹回放（RD-010）</h3><div id="cog-replay" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">轨迹库（Episodic）</h3><div id="cog-traj" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">进化审计（不可变）</h3><div id="cog-audit" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">环境注册表</h3><div id="cog-env" class="hint">加载中…</div></div>
      </div>
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
        <button type="button" class="rtab" data-tab="evidence" id="rtab-evidence">证据</button>
        <button type="button" class="rtab" data-tab="logs" id="rtab-logs">日志</button>
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
      <div id="rtab-evidence-pane" class="rtabpane">
        <div id="eview" style="padding:10px;font-size:12px;color:var(--dim)">当前会话的认知谱系：模型、世界模型版本、技能快照、证据链</div>
      </div>
      <div id="rtab-logs-pane" class="rtabpane">
        <div id="lview" style="padding:10px;font-size:11.5px;font-family:var(--mono);color:var(--dim);overflow:auto">暂无日志</div>
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
  <div id="cmdpal">
    <div class="card">
      <input id="cmdpal-in" placeholder="命令 / 视图 / 会话…">
      <div class="list" id="cmdpal-list"></div>
      <div class="foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>
  </div>
  <div id="pairmod">
    <div class="card">
      <h3>📱 连接手机</h3>
      <div style="display:flex;gap:6px;margin:4px 0">
        <button id="pair-lan" class="ghost sm" style="font-weight:600">🏠 WiFi 连接</button>
        <button id="pair-wan" class="ghost sm" style="font-weight:600">🌐 互联网连接</button>
      </div>
      <div class="qr" id="pair-qrbox"><img id="pair-qr" alt="QR"></div>
      <div class="pin" id="pair-pin" style="display:none">—</div>
      <div class="pinlab" id="pair-pinlab" style="display:none;font-size:11px;color:var(--dim)">配对密码（互联网模式，输入到手机）</div>
      <div class="url" id="pair-url">—</div>
      <div class="hint" id="pair-hint">手机扫码即可连接</div>
      <div class="hint" id="pair-count" style="color:var(--accent)">—</div>
      <div style="display:flex;gap:6px">
        <button id="pair-copy" class="ghost sm">复制链接</button>
        <button id="pair-line" class="ghost sm" style="display:none">换一条线路</button>
        <button id="pair-close" class="ghost sm">关闭</button>
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
` +
  CORE +
  `
` +
  WORKSPACES +
  `
` +
  VIEWS +
  `
` +
  SETTINGS +
  `
` +
  SESSIONS +
  `
` +
  DOCK +
  SSE +
  `
` +
  CHROME +
  `
` +
  COMPOSER +
  `
` +
  SHELL +
  `</script>
</body>
</html>
`;
