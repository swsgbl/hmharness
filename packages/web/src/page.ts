/**
 * @hmharness/web - page(P1-3 拆分装配层)
 * 原单文件 page.ts(3832 行)按交互域拆分到 page/*.ts,本文件只剩装配:
 * 按页面原始顺序拼接各域片段 + 唯一模板洞 uiLiteSource()(uilite 纯函数
 * 内联)。最终 PAGE 与拆分前逐字节一致(拆分期守门脚本)。模板字面量规则:
 * 无裸反引号,页面 JS 内不用插值,正则反斜杠双写。
 */
import { uiLiteSource } from './uilite.ts';
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
  /* ---- per-session views (2026-09-28, deepseek-harness semantics) ----
     Every session owns ONE dedicated container + state; "the current session"
     is the root of all rendering. Switching sessions swaps which container is
     mounted - never which buffer a stream writes to. A running task's events
     keep flowing into ITS session's container whether or not you are looking
     at it; other sessions can never be painted over. This replaces the old
     shared-log + stash/liveBox state machine (the cross-session pollution
     class of bugs). */
  var views = new Map();          // sid -> view record
  var curSid = null;              // the session currently displayed
  var activeSink = null;          // write target while routing an SSE event (per-session root)
  var busySid = '';               // session whose task is running (server echo)
  var runningSids = {};           // W15: EVERY running session (parallel execution)
  function newViewRecord(sid) {
    var root = document.createElement('div');
    root.className = 'sessview';
    root.style.display = 'none';
    log.appendChild(root);
    return {
      sid: sid, root: root, loaded: false, cwd: '',
      // per-session render state (was global - the actual pollution bug)
      seq: 0, toolRegistry: {}, curBlock: null, curKind: null,
      pendingToolRow: null, parCount: 0, parBox: null, groupNames: {},
      deliverables: [], lastTask: '', lastAssistantText: '', planText: '',
    };
  }
  function viewFor(sid, create) {
    var v = views.get(sid);
    if (!v && create !== false) { v = newViewRecord(sid); views.set(sid, v); }
    return v;
  }
  /** The write target for an incoming session event: that session's own
   *  container, created on demand. Never the shared log. */
  function sink(sid) {
    var s = sid === undefined ? (activeSinkSid() || curSid) : sid;
    if (!s) return log;
    return viewFor(s).root;
  }
  function activeSinkSid() { return activeSinkSidVal; }
  var activeSinkSidVal = null;
  /** Mount one session's container as the visible view (others hidden). */
  function mountView(sid) {
    curSid = sid;
    // refresh-recovery (docx P1): remember the session being viewed; a page
    // reload reopens it instead of dropping the user back to a blank draft
    try { localStorage.setItem('hmh-last-sid', String(sid)); } catch (e) {}
    views.forEach(function (v) { v.root.style.display = (v.sid === sid) ? '' : 'none'; });
    var pv = document.getElementById('plancard');
    var v = views.get(sid);
    if (pv) {
      if (v && v.planText) { renderPlanCardInto(v, true); pv.style.display = 'block'; }
      else pv.style.display = 'none';
    }
    updateTopbarCwd();
    // W15 parallel sessions: the composer follows the VIEWED session - stop
    // button when THIS session runs, plain send when it does not (another
    // session running elsewhere never blocks the input here)
    setBusy(!!runningSids[sid], null);
    var shown = views.get(sid);
    if (shown) shown.root.scrollTop = 0;
    log.scrollTop = log.scrollHeight;
  }
  /** Topbar project/path follows the VIEWED session's cwd (user-visible fix:
   *  it used to show the server's global workspace no matter what you read). */
  function updateTopbarCwd() {
    var v = curSid ? views.get(curSid) : null;
    var path = (v && v.cwd) || (state && state.workspace && state.workspace.path) || (state && state.home) || '';
    var elc = document.getElementById('home');
    if (elc) { elc.textContent = path; elc.title = path; }
  }
  var state = null;
  var L = null;
  var curView = 'chat';
  var sessData = [];

  var LABELS = {
    zh: { localeKey: 'zh', title:'hmh web', idle:'空闲', running:'运行中…', send:'运行', sendNow:'发送', stop:'停止', stopTitle:'停止当前任务(排队任务继续)', queueTitle:'发送后将排队,当前任务完成后自动运行', queueClear:'清空队列', queueRemove:'移除该排队任务', approve:'批准', deny:'拒绝',
          fbUp:'有帮助', fbDown:'没帮助', planCard:'计划', labelAnswer:'回答: ', goalPh:'会话目标(Enter 保存 / 点 ✕ 清除)', sessSearch:'搜索本会话内容…', sesExportBtn:'导出全文',
          approvalReq:'审批请求:', skills:'技能', sessions:'最近会话', none2:'(无)', ungrouped:'未归类',
          placeholder:'给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
          newLabel:'新会话', searchPh:'搜索会话…', skillsN:'技能',
          emptyTitle:'给 hmh 一个任务', emptySub:'流式输出 · 浏览器审批 · 全程审计', alreadyRunning:'已有一个任务在运行', queuedHint:'已排队', toolGroupCalls:'个工具调用', toolGroupToggle:'点击展开', liveRunBehind:'● 任务仍在后台运行，输出已暂停显示', liveRunBack:'回到运行中的会话',
          dempty:'点击对话流中的工具行查看详情', ask:'🔒 审批询问', auto:'⚡ 自动批准', clear:'清屏',
          navChat:'对话', navBoard:'任务看板', navCog:'认知面板', navDev:'设备', navSk:'技能中心', ws:'工作区',
          viewChat:'对话', viewBoard:'任务看板', viewDev:'设备', viewSk:'技能中心',
          thinkL:'思考过程', copy:'复制', regen:'重新生成', refresh:'刷新',
          noDev:'未发现设备——连接真机或启动模拟器后刷新', noHdc:'未找到 hdc 命令——请安装 DevEco Studio / 命令行工具并加入 PATH',
          extBridge:'浏览器扩展桥', extConn:'已连接', extDisc:'未连接(扩展 popup 里连接)', extDown:'桥未运行(hmh extension serve)',
          devEmu:'模拟器', devUsb:'真机', skActive:'已启用技能', skDrafts:'技能草稿', skInsights:'近期洞察', skEvo:'进化日志',
          noSkills:'(暂无)', turnsL:'轮', toolsL:'次工具', loading:'加载中…',
          modeYolo:'🔥 YOLO(全自动)', modeAutoShort:'自动',
          navSsh:'SSH', viewSsh:'SSH', sshNoHosts:'未配置 SSH 主机 — 在 config.json 添加 sshHosts 后刷新', sshRun:'运行', sshApproveFirst:'该命令需要审批 — 点击「批准并运行」', sshApprovedRun:'批准并运行', sshPh:'远程命令, 回车运行 (ls / df -h / uptime …)',
          sesRename:'重命名', sesExport:'导出会话为 Markdown 文件', sesArchive:'归档(移入 archive,可查不占列表)', sesDelete:'删除(移入 trash,可恢复)', sesConfirmDel:'删除该会话?(文件移入 sessions/trash,可手动恢复)',
          wsAdd:'＋ 添加工作区', wsOpen:'在文件管理器中打开工作区', wsName:'名称(默认目录名)', wsPath:'或直接输入绝对路径, 回车前往', wsOk:'添加',
          pickTitle:'选择工作区目录', thisPC:'此电脑', cancel:'取消', up:'上一级',
          wsSwitch:'切换工作区', wsRemove:'移除注册(不删目录)', curSessions:'本工作区会话', otherSessions:'其他 / 未分组',
           navSet:'设置', navLabel:'RL 标注', labelTitle:'RL 奖励标注', labelHint:'对照每张卡片的【任务】与【回答】打分：★5=回答完全正确完成；★3=部分正确或不确定；★1=错误/没做/答非所问。人工评分用于校准奖励信号——RL 就绪门最后一个条件(需 100 条)。', labelDone:'✓ 已达 100 条,RL 门最后一格解锁!', labelEmpty:'(没有待标注的会话了——先跑几个任务再回来)', viewSet:'设置', setTitle:'设置', setModelTitle:'模型 / Providers', setPresetsTitle:'内置预设（一键添加）', setGeneralTitle:'常规',
           setLocaleLabel:'语言 locale', setApprovalLabel:'默认审批模式', setEvolveLabel:'自动进化间隔 autoEvolveEvery（0=关闭）', setPatchLabel:'代码级自进化 autoPatch（危险，默认关）', setSave:'保存', setSaved:'已保存 ✓', setFailed:'保存失败',
           provAdd:'＋ 新增 provider', provEdit:'编辑', provDelete:'删除', provSave:'保存', provCancel:'取消', provApiKeySet:'密钥已设置', provApiKeyNone:'未设置密钥', provAddPreset:'添加',
           provName:'名称', provBaseUrl:'baseUrl', provModel:'model', provApiKey:'apiKey', provAuthHeader:'authHeader(可选)', provSupportsVision:'支持视觉', provKeyPhNew:'新 provider 需要填写 apiKey', provKeyPhEdit:'留空=保持原密钥；输入空格再清空=删除密钥',
           provDeleteConfirm:'删除该 provider?（config.json 就地改写，不可撤销）', presetEnv:'需环境变量', presetLocal:'本地端点',
           rtabDetail:'详情', rtabFiles:'文件', rtabPreview:'预览', rcollapse:'折叠右栏', rclose:'关闭右栏',
           pvHint:'在文件树或对话中点击文件路径在此预览', pvBinary:'二进制文件，无法预览（', pvTrunc:'(仅前 64KB)', pvNotFile:'文件不存在或在工作区外',
           slashHint:'↑↓ 选择 · Enter 插入 · Esc 关闭', atHint:'↑↓ 选择 · Enter 插入路径 · Esc 关闭', injHint:'运行中: Enter=排队 · Ctrl+Enter=注入当前轮', injected:'已注入当前轮', queueNone:'(空)',
           atNone:'无匹配文件 — 继续输入或按 Esc 关闭',
           cmdOk:'命令结果', cmdHelp:'命令', searchAt:'输入 @ 搜索工作区文件…',
           webCmds: { '/help':'列出 Web 可用命令', '/clear':'清屏并开新线程', '/status':'当前模型/语言/队列状态', '/model':'查看/切换模型路由', '/lang':'切换语言 zh/en', '/yolo':'全自动审批开关', '/providers':'检测本机可用厂商', '/tools':'列出全部工具', '/skills':'列出技能', '/mcp':'列出 MCP 服务器', '/ops':'鸿蒙工具链体检', '/ops scan':'生态雷达扫描', '/resume':'从左侧会话列表回看', '/web':'显示 web 地址', '/exit':'退出提示' } },
    en: { localeKey: 'en', title:'hmh web', idle:'idle', running:'running…', send:'Run', sendNow:'Send', stop:'Stop', stopTitle:'stop the current task (queued tasks still run)', queueTitle:'queues; runs when the current task finishes', queueClear:'clear queue', queueRemove:'remove this queued task',
          fbUp:'helpful', fbDown:'not helpful', planCard:'Plan', labelAnswer:'Answer: ', goalPh:'session goal (Enter saves / ✕ clears)', sessSearch:'search in session…', sesExportBtn:'export full transcript', approve:'Approve', deny:'Deny',
          approvalReq:'Approval request:', skills:'skills', sessions:'recent sessions', none2:'(none)', ungrouped:'ungrouped',
          placeholder:'give hmh a task… (Enter to send, Shift+Enter for newline)',
          newLabel:'New session', searchPh:'search sessions…', skillsN:'skills',
          emptyTitle:'give hmh a task', emptySub:'streaming · browser approvals · fully audited', alreadyRunning:'a task is already running', queuedHint:'queued', toolGroupCalls:'tool calls', toolGroupToggle:'click to expand', liveRunBehind:'● a task is still running in the background', liveRunBack:'back to the live session',
          dempty:'click a tool row in the chat to inspect', ask:'🔒 ask approval', auto:'⚡ auto-approve', clear:'clear',
          navChat:'Chat', navBoard:'Task board', navCog:'Cognitive', navDev:'Devices', navSk:'Skills', ws:'Workspace',
          viewChat:'Chat', viewBoard:'Task board', viewDev:'Devices', viewSk:'Skills',
          thinkL:'Thinking', copy:'Copy', regen:'Regenerate', refresh:'Refresh',
          noDev:'No devices found - plug in a device or start an emulator, then refresh',
          noHdc:'hdc not found - install DevEco Studio / command-line tools and add to PATH',
          extBridge:'browser extension bridge', extConn:'connected', extDisc:'not connected (open the extension popup)', extDown:'bridge not running (hmh extension serve)',
          devEmu:'emulator', devUsb:'device', skActive:'Active skills', skDrafts:'Draft skills', skInsights:'Recent insights', skEvo:'Evolution log',
          noSkills:'(none)', turnsL:'turns', toolsL:'tool uses', loading:'loading…',
          modeYolo:'🔥 YOLO (hands-free)', modeAutoShort:'auto',
          navSsh:'SSH', viewSsh:'SSH', sshNoHosts:'No SSH hosts configured - add sshHosts to config.json, then refresh', sshRun:'Run', sshApproveFirst:'This command needs approval - click approve-and-run', sshApprovedRun:'Approve & run', sshPh:'remote command, Enter to run (ls / df -h / uptime ...)',
          sesRename:'Rename', sesExport:'export session as a Markdown file', sesArchive:'Archive (moves to archive/, out of the list)', sesDelete:'Delete (moves to trash/, recoverable)', sesConfirmDel:'Delete this session? (moved to sessions/trash, manually recoverable)',
          wsAdd:'＋ add workspace', wsOpen:'open the workspace in the file manager', wsName:'name (defaults to folder name)', wsPath:'or type an absolute path and press Enter', wsOk:'Add',
          pickTitle:'Choose workspace folder', thisPC:'This PC', cancel:'Cancel', up:'Up one level',
          wsSwitch:'switch workspace', wsRemove:'unregister (keeps the folder)', curSessions:'this workspace', otherSessions:'other / ungrouped',
           navSet:'Settings', navLabel:'RL Labels', labelTitle:'RL Reward Labels', labelHint:'Judge each card by TASK vs ANSWER: ★5 = correct and complete; ★3 = partial or unsure; ★1 = wrong, missing, off-topic. Human scores calibrate the reward signal - the last RL readiness gate condition (100 needed).', labelDone:'\u2713 100 reached - the last RL gate slot unlocks!', labelEmpty:'(no sessions to label - run a few tasks first)', viewSet:'Settings', setTitle:'Settings', setModelTitle:'Models / Providers', setPresetsTitle:'Built-in presets (one-click add)', setGeneralTitle:'General',
           setLocaleLabel:'locale', setApprovalLabel:'default approval mode', setEvolveLabel:'auto-evolve every N insights (0=off)', setPatchLabel:'code-level self-evolution autoPatch (dangerous, off by default)', setSave:'Save', setSaved:'Saved ✓', setFailed:'Save failed',
           provAdd:'＋ add provider', provEdit:'Edit', provDelete:'Delete', provSave:'Save', provCancel:'Cancel', provApiKeySet:'api key set', provApiKeyNone:'no api key', provAddPreset:'Add',
           provName:'name', provBaseUrl:'baseUrl', provModel:'model', provApiKey:'apiKey', provAuthHeader:'authHeader (optional)', provSupportsVision:'supports vision', provKeyPhNew:'a new provider needs its apiKey', provKeyPhEdit:'blank = keep the existing key; type a space then clear = remove it',
           provDeleteConfirm:'Delete this provider? (config.json is rewritten in place, not recoverable)', presetEnv:'needs env var', presetLocal:'local endpoint',
           rtabDetail:'Detail', rtabFiles:'Files', rtabPreview:'Preview', rcollapse:'collapse', rclose:'close',
           pvHint:'click a file path in the file tree or the chat to preview it here', pvBinary:'binary file, cannot preview (', pvTrunc:'(first 64KB only)', pvNotFile:'file not found or outside the workspace',
          slashHint:'↑↓ select · Enter insert · Esc close', atHint:'↑↓ select · Enter insert path · Esc close', injHint:'while running: Enter=queue · Ctrl+Enter=inject this turn', injected:'injected into the current turn', queueNone:'(empty)',
          atNone:'no matching files — keep typing or press Esc',
           cmdOk:'command output', cmdHelp:'commands', searchAt:'type @ to search workspace files…',
           webCmds: { '/help':'list web commands', '/clear':'clear screen, new thread', '/status':'model/locale/queue state', '/model':'list/switch chat route', '/lang':'switch locale zh/en', '/yolo':'toggle hands-free approvals', '/providers':'detect local providers', '/tools':'list all tools', '/skills':'list skills', '/mcp':'list MCP servers', '/ops':'harmony toolchain check', '/ops scan':'ecosystem radar scan', '/resume':'revisit sessions in the sidebar', '/web':'show the web address', '/exit':'how to quit' } }
  };
  // boot default until /api/config confirms the locale: render* callbacks
  // (sessions, cognitive panel...) can fire BEFORE setLabels() runs, and an
  // unguarded L.none2 on the empty-sessions path crashed the whole bootstrap
  L = LABELS.zh;
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
    var navNames = { chat:L.navChat, board:L.navBoard, cognitive:L.navCog, devices:L.navDev, ssh:L.navSsh, skills:L.navSk, settings:L.navSet, label:L.navLabel };
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
    ['chat', 'board', 'cognitive', 'devices', 'ssh', 'skills', 'settings', 'label'].forEach(function (k) {
      var elv = document.getElementById('view-' + k);
      if (elv) elv.classList.toggle('on', k === v);
    });
    var shown = document.getElementById('view-' + v);
    if (shown) window.__AN.viewIn(shown);
    if (L) {
      document.getElementById('viewchip').textContent =
        ({ chat:L.viewChat, board:L.viewBoard, cognitive:L.navCog, devices:L.viewDev, ssh:L.viewSsh, skills:L.viewSk, settings:L.viewSet })[v] || v;
    }
    if (v === 'board') loadBoard();
    if (v === 'cognitive') loadCognitive();
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

  function el(tag, cls, text, forceLog) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    // forceLog = user-just-typed feedback -> the VIEWED session's container.
    // Default = the EVENT's session container (activeSink routing) - a running
    // task in session A never writes into the session B the user is reading.
    var parent = forceLog ? (curSid ? viewFor(curSid).root : log) : sink();
    parent.appendChild(e);
    if (parent.style.display !== 'none') parent.scrollTop = parent.scrollHeight;
    if (parent === (curSid ? viewFor(curSid).root : null) || parent === log) {
      if (cls === 'msg-user') window.__AN.userBubble(e);
      else window.__AN.rowIn(e);
    }
    return e;
  }
  function clearEmpty() {
    // the welcome card lives INSIDE a session view; clear the routed one
    var t = sink();
    var e = t.querySelector('#empty');
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
    sink().appendChild(box);
    autoscroll();
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
      finalize: function () { e.innerHTML = renderMarkdown(txt); var v = activeSinkSidVal && views.get(activeSinkSidVal); if (v) v.lastAssistantText = txt; autoscroll(); },
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
      taskStartAt = Date.now();
      setTaskPhase('start');
    } else {
      rs.classList.remove('yolo');
      // run-state 2.0: brief terminal flash (completed/failed) before idle -
      // the outcome flag is set by the final/error SSE handlers
      var termEl = document.getElementById('rs-phase');
      if (termEl && window.__lastTaskOk !== undefined && taskStartAt) {
        var ok = window.__lastTaskOk;
        var dur = elapsedStr();
        termEl.textContent = (ok ? '\\u2713 ' + phaseLabel('completed') : '\\u2717 ' + phaseLabel('failed')) + ' \\u00B7 ' + dur;
        setTimeout(function () { if (!window.__agentBusy && termEl) termEl.textContent = ''; }, 3000);
      }
      window.__lastTaskOk = undefined;
      setTaskPhase('idle');
      taskStartAt = 0;
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

  /* ---- Long Task Cockpit (2026-09-28 docx P1): one line under the input
     answers "what is it doing / why not done / how do I stop it" without
     reading logs: phase + current tool + elapsed + queue. No chain-of-thought
     is ever shown - only operational phases derived from SSE events. */
  var taskStartAt = 0;
  var phaseTimer = null;
  var PHASE_KEYS = {
    start: { zh: '启动', en: 'starting' },
    thinking: { zh: '思考', en: 'thinking' },
    planning: { zh: '规划', en: 'planning' },
    responding: { zh: '回复', en: 'responding' },
    executing: { zh: '执行', en: 'executing' },
    verifying: { zh: '验证', en: 'verifying' },
    waitingApproval: { zh: '等待审批', en: 'waiting approval' },
    recovering: { zh: '恢复', en: 'recovering' },
    completed: { zh: '完成', en: 'completed' },
    failed: { zh: '失败', en: 'failed' },
  };
  function phaseLabel(k) {
    var p = PHASE_KEYS[k];
    if (!p) return '';
    return (L && L.localeKey === 'en') ? p.en : p.zh;
  }
  function elapsedStr() {
    if (!taskStartAt) return '';
    var s = Math.floor((Date.now() - taskStartAt) / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }
  function setTaskPhase(kind, detail) {
    var el = document.getElementById('rs-phase');
    if (!el) return;
    if (kind === 'idle') { el.textContent = ''; if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; } return; }
    var txt = '\\u25B8 ' + phaseLabel(kind) + (detail ? ' \\u00B7 ' + detail : '');
    var tick = function () { el.textContent = txt + ' \\u00B7 ' + elapsedStr(); };
    tick();
    if (!phaseTimer) phaseTimer = setInterval(function () { if (window.__agentBusy) tick(); }, 1000);
    window.__taskPhase = kind;
  }
  function taskPhaseEvent(kind, detail) {
    if (!window.__agentBusy) return;
    setTaskPhase(kind, detail);
    updateHud();
  }

  /** Cognitive HUD (UX pack 03): a compact chip in the topbar projecting
   *  the session's structured cognitive facts - the same /api/cognitive
   *  data the Evidence tab shows, compressed to one glanceable line:
   *  WM confidence · prediction status · recovery count · verify count.
   *  Structured facts ONLY - no internal thinking is ever displayed. */
  var hudData = { phase: '', verify: 0, recovering: 0 };
  function updateHud() {
    var chip = document.getElementById('hud-chip');
    if (!chip) return;
    var parts = [];
    if (hudData.phase) parts.push('\\u25B8' + phaseLabel(hudData.phase));
    if (hudData.verify > 0) parts.push('\\u2713' + hudData.verify);
    if (hudData.recovering > 0) parts.push('\\u21BB' + hudData.recovering);
    if (parts.length > 0) {
      chip.style.display = '';
      chip.textContent = parts.join(' ');
    } else {
      chip.style.display = 'none';
    }
  }
  (function initHud() {
    // verify count rides the same classifier the Turn Card uses
    var origVerify = null;
    // recovering count increments on the provider-retry branch
    // (wired at the retry discard path below)
  })();

  function renderState(s) {
    state = s;
    setLabels(s.locale || 'zh');
    renderQueue(s.queue || []);
    // mid-run page reload: no 'busy' SSE event will fire until the task ends,
    // so the composer state (stop button, runstatus) must come from state too
    // W15: with parallel sessions the composer follows the VIEWED session
    // (busySessions); legacy single-busy state falls back to the global flag
    var mineBusy = Array.isArray(s.busySessions) ? (curSid ? s.busySessions.indexOf(curSid) >= 0 : s.busySessions.length > 0) : s.busy;
    if (typeof mineBusy === 'boolean' && mineBusy !== !!window.__agentBusy) setBusy(mineBusy);
    if (Array.isArray(s.busySessions)) s.busySessions.forEach(function (bs) { runningSids[bs] = runningSids[bs] || true; });
    document.getElementById('model').textContent = s.model;
    document.getElementById('model2').textContent = s.model;
    renderModelPick(s);
    // mid-run reload: remember which session is running server-side
    if (s.activeSessionId) busySid = s.activeSessionId;
    // topbar path: the VIEWED session's cwd wins; the global workspace is the
    // fallback (user bug: switching project sessions never moved the chip)
    updateTopbarCwd();
    // phone pairing icon: visible when the server is in LAN/WAN mode
    var pp = document.getElementById('phone-pair');
    if (pp) pp.style.display = (s.exposure && s.exposure !== 'loopback') ? '' : 'none';
    // A11 theme + A6 goal from the persisted state
    applyTheme((s.settings && s.settings.theme) || 'dark');
    var gc = document.getElementById('goal-chip');
    if (s.goal) { gc.style.display = ''; gc.textContent = '🎯 ' + s.goal; gc.title = s.goal; }
    else { gc.style.display = 'none'; }
    if (s.workspace) {
      var wsPrev = curWs && curWs.path;
      curWs = s.workspace;
      var n = document.getElementById('wscur-name');
      if (n && n.textContent !== s.workspace.name) n.textContent = s.workspace.name;
      // workspace switched: the file tree's one-shot cache is stale
      if (wsPrev && wsPrev !== s.workspace.path) {
        var ft = document.getElementById('ftree');
        if (ft) { ft.removeAttribute('data-loaded'); ft.innerHTML = ''; }
      }
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
  /* ---- cognitive research panel (blueprint RD-001..008 seed): five-layer
     memory, episodic trajectory store, immutable evolution audit and the
     environment registry, from /api/cognitive. Read-only by design. ---- */
  function loadCognitive() {
    ['memory', 'world', 'traj', 'audit', 'env'].forEach(function (k) {
      var el = document.getElementById('cog-' + k);
      if (el) el.innerHTML = '<div class="hint">加载中…</div>';
    });
    api('/api/cognitive').then(function (r) { return r.json(); }).then(function (d) {
      var m = d.memory || {};
      var layers = [['working', '工作'], ['episodic', '情景'], ['semantic', '语义'], ['procedural', '程序'], ['world', '世界']];
      document.getElementById('cog-memory').innerHTML =
        layers.map(function (l) {
          return '<span class="ob ' + (m[l[0]] ? 'ok' : 'none') + '">' + l[1] + ' ' + (m[l[0]] || 0) + '</span>';
        }).join(' ') +
        (d.memoryContradictions ? ' <span class="ob err">矛盾待审 ' + d.memoryContradictions + '</span>' : '') +
        '<div class="hint" style="margin-top:6px">' + (m.total ? '共 ' + m.total + ' 条长期记录（只增不删，矛盾打标待审）' : '尚未产生认知记忆——跑一次任务即自动落盘（带溯源）') + '</div>';
      var wm = d.worldModel;
      var worldEl = document.getElementById('cog-world');
      if (wm && wm.beliefs && wm.beliefs.length) {
        worldEl.innerHTML = wm.beliefs.slice(0, 8).map(function (b) {
          return '<span class="ob ' + (b.confidence >= 0.6 ? 'ok' : b.confidence >= 0.3 ? 'tb' : 'err') + '">' + esc(b.actionType) + ' ' + (b.confidence * 100).toFixed(0) + '%<small>×' + b.evidenceCount + '</small></span>';
        }).join(' ') +
          '<div class="hint" style="margin-top:6px">' + wm.stepsReplayed + ' 步回放 · 校准 ' + (wm.calibration.meanError !== undefined ? '误差 ' + wm.calibration.meanError : '暂无预测') + ' · 可信动作 [' + (wm.plannerGate.trusted || []).map(esc).join(',') + ']</div>';
      } else {
        worldEl.innerHTML = '<div class="hint">暂无信念——任务轨迹积累后自动生成（预测先行=无泄漏回放）</div>';
      }
      // calibration report (§26-proven dimension, first-class)
      api('/api/cognitive/calibration').then(function (r) { return r.json(); }).then(function (c) {
        var el = document.getElementById('cog-calib');
        if (!c.predictedSteps) { el.innerHTML = '<div class="hint">尚无带预测的轨迹——探索/迁移实验自动记录预测</div>'; return; }
        var rows = (c.rows || []).slice(0, 6).map(function (row) {
          var cls = row.reliability >= 0.75 ? 'ok' : row.reliability >= 0.5 ? 'tb' : 'err';
          return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(row.actionType) + '</span> 可靠度 ' + (row.reliability * 100).toFixed(0) + '% <small>×' + row.predictions + ' 预测</small></div>';
        }).join('');
        el.innerHTML = '<div class="hint" style="margin-bottom:4px">总体 ' + (c.overallReliability * 100).toFixed(1) + '% 可靠（' + c.predictedSteps + '/' + c.totalSteps + ' 步带预测）</div>' + rows +
          '<div class="hint" style="margin-top:4px">校准维=harness 实证价值所在（迁移 +0.4166，全谱系唯一正读数）</div>';
      }).catch(function () {
        document.getElementById('cog-calib').innerHTML = '<div class="hint">加载失败</div>';
      });
      // per-environment learning curves (the measurable self-evolution evidence)
      Promise.all([
        api('/api/cognitive/calibration?trend=1&env=terminal').then(function (r) { return r.json(); }),
        api('/api/cognitive/calibration?trend=1&env=harmonyos').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=browser').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=desktop').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=arc3').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
      ]).then(function (trends) {
        var el = document.getElementById('cog-calib');
        if (!el) return;
        var html = '';
        [['terminal', trends[0]], ['harmonyos', trends[1]], ['browser', trends[2]], ['desktop', trends[3]], ['arc3', trends[4]]].forEach(function (pair) {
          var name = pair[0], t = pair[1];
          if (!t || !t.buckets || !t.buckets.length) return;
          var cls = t.verdict === 'improving' ? 'ok' : t.verdict === 'degrading' ? 'err' : 'tb';
          var spark = t.buckets.map(function (b) {
            var h = Math.max(2, Math.round(b.reliability * 28));
            return '<div style="display:inline-block;width:14px;margin-right:2px;background:var(--line);border-radius:2px 2px 0 0;height:' + h + 'px;vertical-align:bottom" title="' + esc(b.at.slice(0, 10)) + ' ' + (b.reliability * 100).toFixed(0) + '% (n=' + b.predictions + ')"></div>';
          }).join('');
          var delta = t.reliabilityDelta === null ? '' : (t.reliabilityDelta >= 0 ? ' +' : ' ') + (t.reliabilityDelta * 100).toFixed(1) + '%';
          html += '<div style="margin:4px 0"><span class="ob ' + cls + '">' + name + '</span>' + spark + '<small>' + delta + ' ' + t.verdict + '</small></div>';
        });
        if (html) el.insertAdjacentHTML('beforeend', '<div class="hint" style="margin-top:6px">学习曲线（按环境，自进化实证）：</div>' + html);
      }).catch(function () { /* curves are additive chrome */ });
      document.getElementById('cog-traj').innerHTML =
        '<span class="ob ' + (d.trajectories ? 'ok' : 'none') + '">' + (d.trajectories || 0) + ' 条轨迹</span>' +
        '<div class="hint" style="margin-top:6px">' + (d.trajectories ? '每次 agent 任务自动记录工具动作/结果/耗时（episodic 层）' : '任务运行后自动生成') + '</div>';
      var last = d.evolutionLastEvent;
      document.getElementById('cog-audit').innerHTML =
        '<span class="ob ' + (d.evolutionAuditEvents ? 'ok' : 'none') + '">' + (d.evolutionAuditEvents || 0) + ' 条事件</span>' +
        (last ? '<div class="hint" style="margin-top:6px">最近: ' + esc(String(last.event)) + ' · ' + esc(String(last.candidateId || '')) + '</div>' : '<div class="hint" style="margin-top:6px">进化轮次结束后自动追加（promoted/rejected/rolled-back 全记录）</div>');
      document.getElementById('cog-env').innerHTML = (d.environments || []).map(function (e) {
        return '<span class="ob ok">' + esc(e.id) + ' <small>v' + e.version + '</small></span>';
      }).join(' ') + '<div class="hint" style="margin-top:6px">环境适配器（terminal 原生 / harmonyos hdc / browser CDP / desktop / arc3 骨架）</div>';
      // lazy sections: goal drift timeline (time-ordered trend) + skill candidates
      api('/api/cognitive/drift?order=time').then(function (r) { return r.json(); }).then(function (dd) {
        var views = dd.views || [];
        var el = document.getElementById('cog-drift');
        if (!views.length) { el.innerHTML = '<div class="hint">暂无带目标的轨迹——设置会话目标后自动检测</div>'; return; }
        // mini timeline: newest last, each run a colored dot scaled by drift
        var dots = views.map(function (v) {
          var cls = v.driftScore >= 0.7 ? 'err' : v.driftScore >= 0.3 ? 'tb' : 'ok';
          return '<span class="ob ' + cls + '" title="' + esc(String(v.goalDescription).slice(0, 60)) + ' · 漂移 ' + v.driftScore.toFixed(2) + '">' + v.driftScore.toFixed(1) + '</span>';
        }).join(' → ');
        var worst = views.slice().sort(function (a, b) { return b.driftScore - a.driftScore; })[0];
        el.innerHTML =
          '<div style="margin-bottom:4px">' + dots + '</div>' +
          '<div class="hint">时间线（旧→新），最重漂移 ' + worst.driftScore.toFixed(2) + ' [' + esc(worst.recommendation) + ']：' + esc(String(worst.goalDescription).slice(0, 50)) + '</div>';
      }).catch(function () {
        document.getElementById('cog-drift').innerHTML = '<div class="hint">加载失败</div>';
      });
      api('/api/cognitive/skills').then(function (r) { return r.json(); }).then(function (dd) {
        var cands = dd.candidates || [];
        document.getElementById('cog-skills').innerHTML = cands.length
          ? cands.map(function (c) {
                  return '<div style="margin:2px 0"><span class="ob tb">' + esc(c.status) + '</span> ' + esc(c.procedure.join(' → ')) + ' <small>×' + c.evidenceTrajectories + ' 轨迹</small></div>';
            }).join('') + '<div class="hint" style="margin-top:4px">晋升仍需过基准门禁（verify → promote）</div>'
          : '<div class="hint">暂无候选——需要≥2 条含≥2 步成功动作序列的轨迹</div>';
      }).catch(function () {
        document.getElementById('cog-skills').innerHTML = '<div class="hint">加载失败</div>';
      });
      api('/api/cognitive/team').then(function (r) { return r.json(); }).then(function (dd) {
        var events = dd.events || [];
        var liveT = dd.live;
        var html = liveT && liveT.nodes && liveT.nodes.length
          ? '<div class="hint" style="margin-bottom:4px">当前拓扑: ' + liveT.nodes.map(function (n) {
              return '<span class="ob ' + (n.status === 'done' ? 'ok' : n.status === 'running' ? 'tb' : n.status === 'failed' ? 'err' : 'none') + '">' + esc(n.role) + '·' + esc(n.status) + '</span>';
            }).join(' ') + '</div>' : '';
        html += events.length
          ? events.slice(-8).reverse().map(function (e) {
              var cls = e.event === 'spawn.done' ? 'ok' : e.event === 'spawn.failed' ? 'err' : 'tb';
              var label = e.event === 'team.created' ? 'team · ' + esc(String(e.goal).slice(0, 40))
                : e.event === 'spawn.started' ? esc(e.nodeId) + ' [' + esc(e.role) + '] 预算' + e.budgetUnits
                : e.event === 'spawn.done' ? esc(e.nodeId) + ' [' + esc(e.role) + '] ' + e.durationMs + 'ms'
                : esc(e.nodeId) + ' [' + esc(e.role) + '] 失败';
              return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(String(e.at).slice(11, 19)) + '</span> ' + label + '</div>';
            }).join('')
          : '<div class="hint">暂无记录——跑一个带 spawn_agent 的任务后自动生成（角色契约+共享预算+不可变审计）</div>';
        document.getElementById('cog-team').innerHTML = html;
      }).catch(function () {
        document.getElementById('cog-team').innerHTML = '<div class="hint">加载失败</div>';
      });
      // transfer matrix: every recorded controlled experiment as a cell
      api('/api/cognitive/transfer').then(function (r) { return r.json(); }).then(function (dd) {
        var exps = dd.experiments || [];
        var el = document.getElementById('cog-transfer');
        if (!exps.length) { el.innerHTML = '<div class="hint">暂无实验——hmh cognitive transfer --run 后自动记录（双臂对照+校准差）</div>'; return; }
        var html = exps.slice(-8).reverse().map(function (e) {
          var cls = e.verdict === 'positive' ? 'ok' : e.verdict === 'negative' ? 'err' : 'tb';
          var cal = e.calibrationDelta !== undefined && e.calibrationDelta > 0 ? ' <small>校准 +' + e.calibrationDelta + '</small>' : '';
          return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(e.sourceEnv) + ' → ' + esc(e.targetEnv) + ' ' + esc(e.verdict) + '</span> ' +
            '<small>' + e.actionOverlap.length + ' 重叠动作</small>' + cal + '</div>';
        }).join('');
        el.innerHTML = html + '<div class="hint" style="margin-top:4px">正迁移=源知识改善目标预测；无重叠=诚实不构成检验</div>';
      }).catch(function () {
        document.getElementById('cog-transfer').innerHTML = '<div class="hint">加载失败</div>';
      });
      // trajectory replay viewer (RD-010): pick a run, inspect every step
      api('/api/cognitive/trajectories').then(function (r) { return r.json(); }).then(function (dd) {
        var list = dd.trajectories || [];
        var el = document.getElementById('cog-replay');
        if (!list.length) { el.innerHTML = '<div class="hint">暂无轨迹——跑任务/探索后自动生成</div>'; return; }
        var sel = '<select id="cog-replay-sel" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;max-width:100%">' +
          list.map(function (t) {
            return '<option value="' + esc(t.id) + '">' + (t.success ? '✓' : '✗') + ' ' + esc(t.id.slice(0, 34)) + ' · ' + t.actions + ' 步 · ' + esc(t.environmentId) + '</option>';
          }).join('') + '</select>';
        el.innerHTML = sel + '<div id="cog-replay-body" class="hint" style="margin-top:6px">选择上方轨迹查看逐步回放</div>';
        document.getElementById('cog-replay-sel').onchange = function () { loadReplay(this.value); };
        loadReplay(list[0].id);
      }).catch(function () {
        document.getElementById('cog-replay').innerHTML = '<div class="hint">加载失败</div>';
      });
    }).catch(function () {
      ['memory', 'world', 'traj', 'audit', 'env'].forEach(function (k) {
        var el = document.getElementById('cog-' + k);
        if (el) el.innerHTML = '<div class="hint err">加载失败</div>';
      });
    });
  }
  var cogRefresh = document.getElementById('cog-refresh');
  if (cogRefresh) cogRefresh.onclick = loadCognitive;
  function loadReplay(id) {
    var body = document.getElementById('cog-replay-body');
    if (!body) return;
    body.innerHTML = '<div class="hint">回放中…</div>';
    api('/api/cognitive/replay?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (v) {
      var steps = (v.steps || []).map(function (s) {
        var cls = s.outcome === 'success' ? 'ok' : s.outcome === 'failure' ? 'err' : 'none';
        var pred = s.prediction ? ' <small>预测 ' + Math.round(s.prediction.confidence * 100) + '%</small>' : '';
        var dur = s.durationMs !== undefined ? ' <small>' + s.durationMs + 'ms</small>' : '';
        return '<div style="margin:1px 0"><span class="ob ' + cls + '">' + s.step + '</span> ' + esc(s.actionType) + pred + dur + '</div>';
      }).join('');
      body.innerHTML =
        '<div class="hint" style="margin-bottom:4px">' + (v.goal ? '目标: ' + esc(String(v.goal).slice(0, 60)) + ' · ' : '') + esc(v.environmentId) + ' · 耗时 ' + Math.round((v.metrics.elapsedMs || 0) / 1000) + 's' + (v.metrics.brierScore !== undefined ? ' · Brier ' + v.metrics.brierScore : '') + '</div>' +
        (steps || '<div class="hint">（0 步）</div>');
    }).catch(function () {
      body.innerHTML = '<div class="hint err">回放失败</div>';
    });
  }
  function loadBoard() {
    var grid = document.getElementById('board-grid');
    grid.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>';
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      grid.innerHTML = '';
      var list = (d.sessions || []).slice(0, 24);
      if (!list.length) { grid.innerHTML = '<div class="hint">' + esc(L.none2) + '</div>'; return; }
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
    }).catch(function (e) { grid.innerHTML = '<div class="err">' + esc(String(e)) + '</div>'; });
  }
  /* Extension bridge row: renders FIRST and regardless of hdc — the user's
     real browser is a device too (green=connected, amber=bridge up but no
     extension attached, dim=bridge down). */
  function extBridgeRow(st) {
    var row = document.createElement('div'); row.className = 'devrow';
    var dot = document.createElement('span'); dot.className = 'st'; dot.textContent = '\u25CF';
    dot.style.color = st && st.connected ? 'var(--ok)' : (st && st.available ? 'var(--warn)' : 'var(--dim)');
    var tg = document.createElement('span'); tg.textContent = L.extBridge + ' 127.0.0.1:' + ((st && st.port) || 7789);
    var kd = document.createElement('span'); kd.className = 'kind';
    kd.textContent = !st || !st.available ? L.extDown : (st.connected ? L.extConn + (st.browser ? ' \u00B7 ' + st.browser : '') : L.extDisc);
    row.appendChild(dot); row.appendChild(tg); row.appendChild(kd);
    return row;
  }
  function loadDevices() {
    var box = document.getElementById('dev-body');
    box.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>';
    // extension status first (fast local probe), then the hdc inventory —
    // the ext row must survive the hdc empty/absent early-returns
    fetch('/api/extension/status').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (st) {
      var ext = extBridgeRow(st);
      fetch('/api/devices').then(function (r) { return r.json(); }).then(function (d) {
        box.innerHTML = '';
        box.appendChild(ext);
        if (!d.hdcAvailable) { var h = document.createElement('div'); h.className = 'hint'; h.textContent = L.noHdc; box.appendChild(h); return; }
        if (!d.devices.length) { var n = document.createElement('div'); n.className = 'hint'; n.textContent = L.noDev; box.appendChild(n); return; }
        d.devices.forEach(function (v) {
          var row = document.createElement('div'); row.className = 'devrow';
          var st2 = document.createElement('span'); st2.className = 'st'; st2.textContent = '\u25CF';
          var tg = document.createElement('span'); tg.textContent = v.target;
          var kd = document.createElement('span'); kd.className = 'kind';
          kd.textContent = v.kind === 'emulator' ? L.devEmu : L.devUsb;
          row.appendChild(st2); row.appendChild(tg); row.appendChild(kd);
          box.appendChild(row);
        });
        window.__AN.stagger('.devrow', box);
      }).catch(function (e) {
        box.innerHTML = '';
        box.appendChild(ext);
        var er = document.createElement('div'); er.className = 'err'; er.textContent = String(e);
        box.appendChild(er);
      });
    });
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
    if (!state) { box.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>'; return; }
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
