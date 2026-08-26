/**
 * @hmh/agent - i18n
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
};

export function strings(locale: Locale = 'zh'): Strings {
  return locale === 'en' ? en : zh;
}
