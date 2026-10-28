/**
 * @hmharness/web - page/core.ts - 页面 JS 内核:GSAP 动效层、per-session 视图容器(W15)、i18n LABELS 双语表、视图切换、渲染原语(el/thinkBlock/sayBlock)、运行状态与任务驾驶舱、renderState、模型选择器
 * P1-3 拆分自 page.ts(基线 682d4fc 行 708-1276):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const CORE = `(function () {
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
`;
