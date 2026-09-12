/**
 * @hmharness/agent - i18n
 * UI-chrome strings for both frontends (cli, web), keyed and bilingual.
 * Locale comes from HmhConfig.locale (default zh). Tool descriptions and
 * model output stay as-is: models answer in the user's language already.
 */
export type Locale = 'zh' | 'en';

export interface Strings {
  // REPL / banner
  replHint: string;
  sessionFooter: (id: string, turns: number, toolUses: number) => string;
  // approval gate
  approvalPrompt: (name: string, brief: string) => string;
  approvalDeniedNoTty: (name: string, brief: string) => string;
  approvalLabel: (name: string, granted: boolean) => string;
  // skills / bench / evolve
  active: string;
  drafts: string;
  none: string;
  pass: string;
  fail: string;
  promoted: string;
  rejected: string;
  errorLabel: string;
  evolveCycle: (model: string, n: number) => string;
  nextCycleIn: (min: number) => string;
  // web page
  webTitle: string;
  idle: string;
  running: string;
  modeYolo: string;
  modeAutoShort: string;
  send: string;
  approve: string;
  deny: string;
  approvalRequest: string;
  skillsHeading: string;
  sessionsHeading: string;
  insightsHeading: string;
  evolutionHeading: string;
  inputPlaceholder: string;
  done: (turns: number, toolUses: number, session: string) => string;
  sessionEnd: (id: string) => string;
  freshBelow: string;
  noCycles: string;
  alreadyRunning: string;
  viewingNote: string;
  // fullscreen TUI
  tuiNeedsTty: string;
  tuiWelcome: (model: string) => string;
  tuiApproval: string;
  tuiApprove: string;
  tuiDeny: string;
  tuiApprovalHint: string;
  tuiHints: string;
  /** idle-box hints while a task runs (TUI): stop affordance + queue depth */
  tuiBusyHints: (queued: number) => string;
  /** live label while the model thinks (TUI) */
  thinking: string;
  /** final label after thinking folds away (TUI) */
  thought: string;
  /** busy spinner text, shown in the input-box status line (TUI) */
  tuiRunning: string;
  /* --- TUI slash-command feedback (previously hardcoded Chinese) --- */
  cmdModelHint: string;
  /** palette footer key hint: how to drive the slash/model picker (TUI) */
  panelHint: string;
  cmdModelPreset: (name: string, envVar: string) => string;
  cmdProvidersListed: string;
  /** tail hint after a bare /providers listing (TUI) */
  cmdProvidersScanHint: string;
  /** streaming label in front of reasoning output (REPL one-shot) */
  thinkingLabel: string;
  cmdProvidersNone: string;
  cmdProvidersAdded: (n: number, names: string) => string;
  tuiScrolled: string;
  tuiWebHint: string;
  updateHint: (latest: string) => string;
  cmdResume: string;
  cmdResumeNone: string;
  cmdResumeNotFound: (p: string) => string;
  cmdResumeLoaded: (n: number) => string;
  /** Codex-style resume picker (v0.8.2 transplant) */
  pickerTitle: string;
  pickerHint1: string;
  pickerHint2: string;
  pickerEmpty: string;
  pickerNoMatch: string;
  pickerLoading: string;
  pickerMore: string;
  pickerPreviewNone: string;
  pickerLabelFilter: string;
  pickerLabelSort: string;
  pickerValCwd: string;
  pickerValAll: string;
  pickerValUpdated: string;
  pickerValCreated: string;
  pickerPos: (pos: number, total: number, pct: string) => string;
  tuiRadarScanning: string;
  tuiEvolveDone: (proposals: number, insights: number, notes: number) => string;
  tuiPassRate: (pct: string) => string;
  tuiStatus: (locale: string, skills: number, model: string) => string;
  tuiSkills: string;
  cmdHelp: string;
  /** REPL feedback for a slash command that does not exist */
  unknownCommand: (line: string) => string;
  /** REPL /clear confirmation */
  cmdClearDone: string;
  cmdTools: string;
  cmdSkills: string;
  cmdModel: string;
  cmdLang: string;
  langSwitched: (locale: string) => string;
  cmdYolo: string;
  yoloOn: string;
  yoloOff: string;
  cmdProviders: string;
  cmdOps: string;
  cmdOpsScan: string;
  cmdBench: string;
  cmdEvolve: string;
  cmdMcp: string;
  cmdStatus: string;
  cmdClear: string;
  cmdWeb: string;
  cmdExit: string;
  helpAlias: string;
  // web service daemon (start/stop/status)
  webStarted: (port: number, log: string) => string;
  webStopped: string;
  webNotRunning: string;
  webRunning: (pid: number, port: number) => string;
  tuiWebLinked: (port: number) => string;
}

const zh: Strings = {
  replHint: '输入任务,/exit 退出',
  sessionFooter: (id, turns, uses) => `(会话 ${id} · ${turns} 轮 · ${uses} 次工具调用)`,
  approvalPrompt: (name, brief) => `  [审批] ${name} ${brief} — 执行吗? [y/N] `,
  approvalDeniedNoTty: (name, brief) => `  [审批] ${name} ${brief} — 已拒绝(非交互环境;用 --yes 允许)`,
  approvalLabel: (name, granted) => `  [审批 ${name}: ${granted ? '已批准' : '已拒绝'}]`,
  active: 'active',
  drafts: 'drafts',
  none: '(无)',
  pass: '通过',
  fail: '失败',
  promoted: '已晋升',
  rejected: '已拒绝',
  errorLabel: '错误',
  evolveCycle: (model, n) => `evolve · 模型 ${model} · 第 ${n} 轮`,
  nextCycleIn: (min) => `下一轮将在 ${min} 分钟后( Ctrl-C 停止)`,
  webTitle: 'hmh web',
  idle: '空闲',
  running: '运行中…',
  modeYolo: '🔥 YOLO(全自动)',
  modeAutoShort: '自动',
  send: '运行',
  approve: '批准',
  deny: '拒绝',
  approvalRequest: '审批请求:',
  skillsHeading: '技能库',
  sessionsHeading: '最近会话',
  insightsHeading: '近期洞察',
  evolutionHeading: '进化记录',
  inputPlaceholder: '给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)',
  done: (turns, uses, session) => `(完成 · ${turns} 轮 · ${uses} 次工具调用 · 会话 ${session})`,
  sessionEnd: (id) => `--- 会话结束: ${id} ---`,
  freshBelow: '--- (以下新任务将开始全新对话) ---',
  noCycles: '(尚无进化轮次)',
  alreadyRunning: '已有一个任务在运行',
  viewingNote: '正在查看历史会话',
  tuiNeedsTty: 'hmh tui 需要交互终端(raw mode)。非交互环境请用:hmh "任务"(一次性)或 hmh web(浏览器)。',
  tuiWelcome: (model) => `hmh tui · ${model} · 输入 / 查看命令 · 直接输入任务回车运行`,
  tuiApproval: '⚠ 审批',
  tuiApprove: '批准',
  tuiDeny: '拒绝',
  tuiApprovalHint: 'enter/y 批准 · esc/n 拒绝',
  tuiHints: 'enter 发送 · 滚轮/↑↓ 翻页 · ^P/^N 历史 · esc 清空 · 拖选复制 · ^C 退出 · /help',
  tuiBusyHints: (queued) => `运行中 · 空行回车=停止 · 新输入=排队(${queued}) · esc 清空 · /help`,
  thinking: '思考中',
  thought: '已完成思考',
  tuiRunning: '运行中…',
  cmdModelHint: '切换 chat 路由: /model <name>',
  panelHint: '↑↓/滚轮/点击 选择 · Enter 确认 · Esc 关闭',
  cmdModelPreset: (name, envVar) => `${name} 尚未配置 — 设置 ${envVar} 后运行 /providers scan 添加`,
  cmdProvidersListed: '未探测到新的本地厂商(环境变量/opencode 配置)',
  cmdProvidersScanHint: '/providers scan 将它们写入配置',
  thinkingLabel: '[思考中] ',
  cmdProvidersNone: '未探测到新的厂商;已配置: ',
  cmdProvidersAdded: (n, names) => `已添加 ${n} 个厂商: ${names} — /model <name> 启用`,
  tuiScrolled: '↑ 已上滚 · PgDn/End/滚轮 回底',
  tuiWebHint: '浏览器界面: 在另一个终端运行 hmh web --port=7788',
  updateHint: (latest) => `新版本 ${latest} 可用: npm i -g @hmharness/cli 更新`,
  cmdResume: '恢复历史会话(/resume 打开选择器,↑↓ 选择,Enter 载入;输入即过滤)',
  cmdResumeNone: '还没有历史会话',
  cmdResumeNotFound: (p) => `没有匹配 "${p}" 的会话`,
  cmdResumeLoaded: (n) => `已恢复会话(${n} 条消息),直接输入内容继续对话`,
  pickerTitle: '恢复会话',
  pickerHint1: 'Enter 恢复 · ↑↓ 浏览 · Tab 切筛选/排序 · ←→ 调整',
  pickerHint2: 'Esc 关闭 · 输入即过滤(标题/id/目录/分支)',
  pickerEmpty: '还没有会话',
  pickerNoMatch: '没有匹配的会话',
  pickerLoading: '正在加载会话…',
  pickerMore: '↓ 加载更多…',
  pickerPreviewNone: '(无消息)',
  pickerLabelFilter: '筛选',
  pickerLabelSort: '排序',
  pickerValCwd: '当前目录',
  pickerValAll: '全部',
  pickerValUpdated: '最近更新',
  pickerValCreated: '创建时间',
  pickerPos: (pos, total, pct) => ` ${pos} / ${total} · ${pct}% `,
  tuiRadarScanning: '雷达扫描中…',
  tuiEvolveDone: (p, i, n) => `evolve 完成: ${p} 提案 · 洞察 ${i} · 记忆 ${n}`,
  tuiPassRate: (pct) => `pass rate: ${pct}`,
  tuiStatus: (locale, skills, model) => `${locale} · ${skills} 技能 · ${model}`,
  tuiSkills: '技能',
  cmdHelp: '命令帮助',
  unknownCommand: (l) => `未知命令: ${l} (/help 查看全部)`,
  cmdClearDone: '✓ 对话已清空,下一条任务从全新上下文开始',
  cmdTools: '已注册工具(gated 标记)',
  cmdSkills: '技能库(启用 + 草稿)',
  cmdModel: '切换模型路由(输入 /model 回车打开选择面板)',
  cmdLang: '切换界面语言(/lang zh|en,省略则在中文/English 间切换)',
  langSwitched: (l) => `界面语言 → ${l === 'zh' ? '中文' : 'English'}`,
  cmdYolo: '切换全自动 YOLO(/yolo on|off;危险命令仍硬拒)',
  yoloOn: '🔥 YOLO 已开启:后续任务全自动,不再弹审批(破坏性命令仍硬拒)',
  yoloOff: '🔒 已回到审批询问模式',
  cmdProviders: '探测本地密钥并自动添加厂商(/providers scan)',
  cmdOps: '运维看板状态',
  cmdOpsScan: '扫描生态雷达并生成简报',
  cmdBench: '快速基准(非 loop 用例)',
  cmdEvolve: '运行一轮自进化循环',
  cmdMcp: '已配置 MCP 服务器',
  cmdStatus: '刷新状态',
  cmdClear: '清空转录',
  cmdWeb: '提示启动浏览器界面',
  cmdExit: '退出',
  helpAlias: '? 同义',
  webStarted: (port, log) => `hmh web 已后台启动 → http://127.0.0.1:${port}\n日志 ${log}\n状态 hmh web status · 停止 hmh web stop`,
  webStopped: 'hmh web 已停止',
  webNotRunning: 'hmh web 未在运行',
  webRunning: (pid, port) => `hmh web 运行中 (pid ${pid}) → http://127.0.0.1:${port}`,
  tuiWebLinked: (port) => `网页端已就绪 → http://127.0.0.1:${port}（本对话可在浏览器继续;hmh web stop 停止）`,
};

const en: Strings = {
  replHint: 'type a task, or /exit to quit',
  sessionFooter: (id, turns, uses) => `(session ${id} · ${turns} turns · ${uses} tool uses)`,
  approvalPrompt: (name, brief) => `  [approval] ${name} ${brief} — run it? [y/N] `,
  approvalDeniedNoTty: (name, brief) => `  [approval] ${name} ${brief} — denied (no TTY; use --yes to allow)`,
  approvalLabel: (name, granted) => `  [approval ${name}: ${granted ? 'granted' : 'DENIED'}]`,
  active: 'active',
  drafts: 'drafts',
  none: '(none)',
  pass: 'PASS',
  fail: 'FAIL',
  promoted: 'PROMOTED',
  rejected: 'REJECTED',
  errorLabel: 'ERROR',
  evolveCycle: (model, n) => `evolve · model ${model} · cycle ${n}`,
  nextCycleIn: (min) => `next cycle in ${min} min (Ctrl-C to stop)`,
  webTitle: 'hmh web',
  idle: 'idle',
  running: 'running…',
  modeYolo: '🔥 YOLO (hands-free)',
  modeAutoShort: 'auto',
  send: 'Run',
  approve: 'Approve',
  deny: 'Deny',
  approvalRequest: 'Approval request:',
  skillsHeading: 'skills',
  sessionsHeading: 'recent sessions',
  insightsHeading: 'insights',
  evolutionHeading: 'evolution',
  inputPlaceholder: 'give hmh a task… (Enter to send, Shift+Enter for newline)',
  done: (turns, uses, session) => `(done · ${turns} turns · ${uses} tool uses · session ${session})`,
  sessionEnd: (id) => `--- end of session ${id} ---`,
  freshBelow: '--- (new tasks below start a fresh conversation) ---',
  noCycles: '(no cycles yet)',
  alreadyRunning: 'a task is already running',
  viewingNote: 'viewing a past session',
  tuiNeedsTty: 'hmh tui needs an interactive terminal (raw mode). Non-interactive: use hmh "task" (one-shot) or hmh web (browser).',
  tuiWelcome: (model) => `hmh tui · ${model} · type / for commands · type a task and press Enter to run`,
  tuiApproval: '⚠ approval',
  tuiApprove: 'Approve',
  tuiDeny: 'Deny',
  tuiApprovalHint: 'enter/y approve · esc/n deny',
  tuiHints: 'enter send · wheel/arrows scroll · ^P/^N history · esc clear · drag to copy · ^C quit · /help',
  tuiBusyHints: (queued) => `running · Enter on empty line = stop · typing queues (${queued}) · esc clear · /help`,
  thinking: 'thinking',
  thought: 'thought (done)',
  tuiRunning: 'running…',
  cmdModelHint: 'switch chat route: /model <name>',
  panelHint: '↑↓ / wheel / click to select · Enter confirms · Esc closes',
  cmdModelPreset: (name, envVar) => `${name} not configured - set ${envVar}, then run /providers scan`,
  cmdProvidersListed: 'no new local providers detected (env vars / opencode config)',
  cmdProvidersScanHint: '/providers scan writes them into the config',
  thinkingLabel: '[thinking] ',
  cmdProvidersNone: 'no new providers found; configured: ',
  cmdProvidersAdded: (n, names) => `added ${n} providers: ${names} - enable via /model <name>`,
  tuiScrolled: '↑ scrolled up · PgDn/End/wheel back to bottom',
  tuiWebHint: 'web UI: run hmh web --port=7788 in another terminal',
  updateHint: (latest) => `version ${latest} available - update with: npm i -g @hmharness/cli`,
  cmdResume: 'resume a past session (/resume opens the picker; arrows + Enter, type to filter)',
  cmdResumeNone: 'no past sessions yet',
  cmdResumeNotFound: (p) => `no session matches "${p}"`,
  cmdResumeLoaded: (n) => `session resumed (${n} messages) - just type to continue`,
  pickerTitle: 'Resume session',
  pickerHint1: 'Enter resume · ↑↓ browse · Tab filter/sort · ←→ change',
  pickerHint2: 'Esc close · type to filter (title/id/dir/branch)',
  pickerEmpty: 'no sessions yet',
  pickerNoMatch: 'no results for your search',
  pickerLoading: 'Loading sessions…',
  pickerMore: '↓ loading more…',
  pickerPreviewNone: '(no message yet)',
  pickerLabelFilter: 'Filter',
  pickerLabelSort: 'Sort',
  pickerValCwd: 'Cwd',
  pickerValAll: 'All',
  pickerValUpdated: 'Updated',
  pickerValCreated: 'Created',
  pickerPos: (pos, total, pct) => ` ${pos} / ${total} · ${pct}% `,
  tuiRadarScanning: 'scanning radar…',
  tuiEvolveDone: (p, i, n) => `evolve done: ${p} proposals · ${i} insights · ${n} notes`,
  tuiPassRate: (pct) => `pass rate: ${pct}`,
  tuiStatus: (locale, skills, model) => `${locale} · ${skills} skills · ${model}`,
  tuiSkills: 'skills',
  cmdHelp: 'command help',
  unknownCommand: (l) => `unknown command: ${l} (/help lists all)`,
  cmdClearDone: '✓ conversation cleared; the next task starts a fresh context',
  cmdTools: 'registered tools (gated marked)',
  cmdSkills: 'skill library (active + drafts)',
  cmdModel: 'switch model route (type /model + Enter opens the picker)',
  cmdLang: 'switch UI language (/lang zh|en; bare toggles)',
  langSwitched: (l) => `UI language → ${l === 'zh' ? '中文' : 'English'}`,
  cmdYolo: 'toggle hands-free YOLO (/yolo on|off; destructive hard-deny stays)',
  yoloOn: '🔥 YOLO on: tasks run unattended, no approval cards (destructive hard-deny stays)',
  yoloOff: '🔒 back to ask-approval mode',
  cmdProviders: 'detect local keys and add providers (/providers scan)',
  cmdOps: 'ops keeper status',
  cmdOpsScan: 'scan the ecosystem radar and write a brief',
  cmdBench: 'quick bench (non-loop cases)',
  cmdEvolve: 'run one self-evolution cycle',
  cmdMcp: 'configured MCP servers',
  cmdStatus: 'refresh status',
  cmdClear: 'clear the transcript',
  cmdWeb: 'hint to launch the web UI',
  cmdExit: 'quit',
  helpAlias: '? alias',
  webStarted: (port, log) => `hmh web started in the background -> http://127.0.0.1:${port}\nlog ${log}\nstatus: hmh web status · stop: hmh web stop`,
  webStopped: 'hmh web stopped',
  webNotRunning: 'hmh web is not running',
  webRunning: (pid, port) => `hmh web running (pid ${pid}) -> http://127.0.0.1:${port}`,
  tuiWebLinked: (port) => `web UI ready -> http://127.0.0.1:${port} (this conversation continues in the browser; hmh web stop to stop)`,
};

export function strings(locale: Locale = 'zh'): Strings {
  return locale === 'en' ? en : zh;
}
