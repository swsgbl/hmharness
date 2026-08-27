/**
 * @hmh/cli - tui (fullscreen, Claude-Code / dsh-TUI style)
 *
 *   ┌ header: logo · model · cwd · skills · spinner/status
 *   ├ transcript viewport (scrollable, auto-follow)
 *   ├ approval card (when a gated tool awaits a decision)
 *   ├ input box: bordered, single line + block caret, ↑/↓ history
 *   └ status bar: key hints · tokens · scroll position
 *
 * Zero dependencies: raw-mode stdin + ANSI. CJK-aware widths (wcwidth-lite).
 * Not a TTY? Prints a pointer to the plain REPL instead.
 */
import { stdin, stdout } from 'node:process';
import { basename } from 'node:path';
import { loadConfig, homeDir, resolveProvider, type ChatMessage } from '@hmh/kernel';
import { listDrafts, listSkills } from '@hmh/evolution';
import { buildRegistry, runAgentTask, strings, type Locale } from '@hmh/agent';

const RESET = '\x1b[0m';
const DIM = (s: string) => `\x1b[2m${s}${RESET}`;
const BOLD = (s: string) => `\x1b[1m${s}${RESET}`;
const CYAN = (s: string) => `\x1b[36m${s}${RESET}`;
const GREEN = (s: string) => `\x1b[32m${s}${RESET}`;
const YELLOW = (s: string) => `\x1b[33m${s}${RESET}`;
const RED = (s: string) => `\x1b[31m${s}${RESET}`;

/* ---------------- text-width + wrapping (CJK aware) ---------------- */

function cw(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
  ) return 2;
  return 1;
}
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cw(ch);
  return w;
}
/** strip ANSI so width math is done on visible text */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
function wrapTo(s: string, width: number, indent = 0): string[] {
  const out: string[] = [];
  let line = '';
  let w = 0;
  const pad = ' '.repeat(indent);
  for (const ch of s) {
    if (ch === '\n' || w + cw(ch) > width) {
      out.push(line);
      line = pad;
      w = indent;
      if (ch === '\n') continue;
    }
    line += ch;
    w += cw(ch);
  }
  out.push(line);
  return out;
}
function truncateTo(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (strWidth(plain) <= width) return s;
  // truncate on the plain text, keep it simple (drop styling precision)
  let w = 0;
  let out = '';
  for (const ch of plain) {
    if (w + cw(ch) > width - 1) return out + '…';
    out += ch;
    w += cw(ch);
  }
  return out;
}

/* ---------------- transcript model ---------------- */

interface Entry {
  lines: string[];
}

export class TuiRuntime {
  private entries: Entry[] = [];
  private dirty = true;
  private scrollFromBottom = 0;
  private input = '';
  private caret = 0;
  private history: string[] = [];
  private histIdx = -1;
  private busy = false;
  private spinnerFrame = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private status = '';
  private approval: { name: string; args: unknown } | null = null;
  private approvalResolve: ((v: boolean) => void) | null = null;
  private running = true;
  private renderTimer?: NodeJS.Timeout;
  private exitResolve: (() => void) | null = null;
  private driver: (() => void) | null = null;
  private model = '';
  private cwdName = '';
  private skillCount = 0;
  private t = strings();

  constructor() {
    stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (d: string) => this.onKey(d));
    stdout.on('resize', () => { this.dirty = true; });
    this.renderTimer = setInterval(() => this.render(), 90);
  }

  configure(model: string, cwdName: string, skillCount: number, locale: Locale): void {
    this.model = model;
    this.cwdName = cwdName;
    this.skillCount = skillCount;
    this.t = strings(locale);
    this.dirty = true;
  }

  destroy(): void {
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    stdout.write('\x1b[?25h\x1b[?1049l');
    stdin.setRawMode?.(false);
    stdin.pause();
  }

  waitExit(): Promise<void> {
    return new Promise((resolve) => { this.exitResolve = resolve; });
  }

  private quit(): void {
    this.running = false;
    this.exitResolve?.();
  }

  /* ---------------- content API ---------------- */

  addText(text: string, style: 'dim' | 'plain' | 'err' = 'plain'): void {
    const paint = style === 'dim' ? DIM : style === 'err' ? RED : (s: string) => s;
    const width = Math.max(20, (stdout.columns || 100) - 2);
    this.entries.push({ lines: wrapTo(text, width).map((l) => paint(l)) });
    this.scrollFromBottom = 0;
    this.dirty = true;
  }

  startStream(kind: 'think' | 'say'): (chunk: string) => void {
    const width = Math.max(20, (stdout.columns || 100) - 2);
    const lines: string[] = [];
    let buf = kind === 'think' ? '∴ ' : '';
    const entry: Entry = { lines };
    const repaint = () => {
      const wrapped = wrapTo(buf, width);
      lines.length = 0;
      wrapped.forEach((l, i) => lines.push(kind === 'think' ? DIM(l) : l));
      this.dirty = true;
    };
    repaint();
    this.entries.push(entry);
    this.scrollFromBottom = 0;
    return (chunk: string) => {
      buf += chunk;
      repaint();
    };
  }

  setBusy(busy: boolean, label = ''): void {
    this.busy = busy;
    if (label) this.status = label;
    if (busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => { this.spinnerFrame = (this.spinnerFrame + 1) % 10; this.dirty = true; }, 120);
    } else if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.dirty = true;
  }

  setStatus(s: string): void {
    this.status = s;
    this.dirty = true;
  }

  requestApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
    this.approval = { name, args };
    this.dirty = true;
    return new Promise<boolean>((resolve) => { this.approvalResolve = resolve; });
  }

  consumeInput(): string {
    const line = this.input;
    if (line.trim()) this.history.unshift(line);
    this.histIdx = -1;
    this.input = '';
    this.caret = 0;
    this.dirty = true;
    return line;
  }

  onSubmit(fn: () => void): void {
    this.driver = fn;
  }

  /* ---------------- keyboard ---------------- */

  private onKey(data: string): void {
    if (this.approval) {
      const grant = data === 'y' || data === 'Y' || data === '\r';
      const deny = data === 'n' || data === 'N' || data === '\x1b' || data === '\x03';
      const resolve = this.approvalResolve;
      this.approval = null;
      this.approvalResolve = null;
      if (resolve) resolve(grant && !deny ? true : deny ? false : true);
      this.dirty = true;
      return;
    }

    if (data === '\x03') {
      if (!this.input) this.quit();
      else { this.input = ''; this.caret = 0; }
      this.dirty = true;
      return;
    }
    if (data === '\r') { this.driver?.(); return; }
    if (data === '\x7f' || data === '\b') {
      if (this.caret > 0) {
        this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
        this.caret--;
      }
      this.dirty = true;
      return;
    }
    if (data === '\x1b[A') {
      if (this.histIdx < this.history.length - 1) {
        this.histIdx++;
        this.input = this.history[this.histIdx] ?? '';
        this.caret = this.input.length;
        this.dirty = true;
      }
      return;
    }
    if (data === '\x1b[B') {
      if (this.histIdx > 0) {
        this.histIdx--;
        this.input = this.history[this.histIdx] ?? '';
      } else {
        this.histIdx = -1;
        this.input = '';
      }
      this.caret = this.input.length;
      this.dirty = true;
      return;
    }
    if (data === '\x1b[C') { if (this.caret < this.input.length) { this.caret++; this.dirty = true; } return; }
    if (data === '\x1b[D') { if (this.caret > 0) { this.caret--; this.dirty = true; } return; }
    if (data === '\x1b[5~') { this.scrollFromBottom += 10; this.dirty = true; return; }
    if (data === '\x1b[6~') { this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 10); this.dirty = true; return; }
    if (data === '\x1b[H') { this.scrollFromBottom = 100000; this.dirty = true; return; }
    if (data === '\x1b[F') { this.scrollFromBottom = 0; this.dirty = true; return; }
    if (data === '\x1b') { this.input = ''; this.caret = 0; this.dirty = true; return; }
    if (data === '\x0c') { this.dirty = true; return; }
    if (data.startsWith('\x1b') || data < ' ') return;

    // printable text (CJK / IME preedit arrives as normal chunks)
    this.input = this.input.slice(0, this.caret) + data + this.input.slice(this.caret);
    this.caret += data.length;
    this.dirty = true;
  }

  /* ---------------- rendering ---------------- */

  render(): void {
    if (!this.running || !this.dirty) return;
    this.dirty = false;
    const W = stdout.columns || 100;
    const H = stdout.rows || 30;
    const frame: string[] = [];

    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.spinnerFrame] ?? ' ';
    const headLeft = ` ${BOLD('⚙ hmh')} ${DIM('·')} ${CYAN(this.model)} ${DIM('·')} ${this.cwdName} ${DIM('·')} ${this.skillCount} skills`;
    const headRight = this.busy ? YELLOW(`${spin} ${this.status || '…'}`) : GREEN('○ idle');
    frame.push(truncateTo(headLeft + ' '.repeat(Math.max(1, W - strWidth(stripAnsi(headLeft)) - strWidth(stripAnsi(headRight)))) + headRight, W));
    frame.push(DIM('─'.repeat(W)));

    const allLines: string[] = [];
    for (const e of this.entries) allLines.push(...e.lines);
    const approvalRows = this.approval ? 3 : 0;
    const viewH = Math.max(3, H - 6 - approvalRows);
    const start = Math.max(0, allLines.length - viewH - this.scrollFromBottom);
    const view = allLines.slice(start, start + viewH);
    for (let i = 0; i < viewH; i++) frame.push(i < view.length ? truncateTo(view[i], W) : '');

    if (this.approval) {
      const argsTxt = JSON.stringify(this.approval.args);
      frame.push(YELLOW('⚠ 审批') + ' ' + YELLOW(BOLD(this.approval.name)) + ' ' + DIM(truncateTo(argsTxt, Math.max(0, W - 24))));
      frame.push(`  [y] ${GREEN('批准')}   [n] ${RED('拒绝')}   ${DIM('enter/y 批准 · esc/n 拒绝')}`);
      frame.push(DIM('─'.repeat(W)));
    }

    const iw = Math.max(10, W - 4);
    frame.push(DIM('┌' + '─'.repeat(iw + 2) + '┐'));
    const shown = this.input.length > iw - 3 ? this.input.slice(this.input.length - iw + 3) : this.input;
    const cIdx = Math.min(this.caret, shown.length);
    const before = shown.slice(0, cIdx);
    const after = shown.slice(cIdx + 1);
    const atCaret = shown[cIdx] ?? ' ';
    frame.push(DIM('│ ') + '❯ ' + before + (this.busy ? DIM(atCaret) : `\x1b[7m${atCaret}\x1b[27m`) + after + DIM(' │'));
    frame.push(DIM('└' + '─'.repeat(iw + 2) + '┘'));

    const hints = this.scrollFromBottom > 0
      ? `${DIM('↑ 已上滚 · PgDn/End 回底')}`
      : `${DIM('enter 发送 · ↑↓ 历史 · esc 清空 · pgup 翻页 · ^C 退出 · /help 命令')}`;
    const stat = this.status && !this.busy ? DIM(this.status) : '';
    frame.push(truncateTo(hints + ' '.repeat(Math.max(1, W - strWidth(stripAnsi(hints)) - strWidth(stat))) + stat, W - 1));

    // Absolute per-row addressing: CUP resets the column and cancels the
    // pending wrap a full-width line leaves behind — "\x1b[B" joins would skip
    // a row on immediate-wrap terminals (conhost) and push the frame past the
    // last line, scrolling the header away and clipping the input box.
    const visible = frame.slice(0, H);
    let out = '';
    for (let i = 0; i < visible.length; i++) out += `\x1b[${i + 1};1H\x1b[2K${visible[i]}`;
    stdout.write(out + '\x1b[0J');
  }
}

/* ---------------- driver ---------------- */

export async function tui(yes: boolean): Promise<void> {
  if (!stdin.isTTY) {
    stdout.write('hmh tui 需要交互终端(raw mode)。非交互环境请用:hmh "任务"(一次性)或 hmh web(浏览器)。\n');
    process.exitCode = 1;
    return;
  }
  const home = homeDir();
  const cfg = await loadConfig();
  const t = strings((cfg.locale ?? 'zh') as Locale);
  const { reg, clients } = await buildRegistry({ announce: false });
  const rt = new TuiRuntime();
  const skills = await listSkills(home);
  const chatModel = resolveProvider(cfg, 'chat').model;
  rt.configure(chatModel, basename(process.cwd()), skills.length, (cfg.locale ?? 'zh') as Locale);
  rt.addText(`hmh tui · ${chatModel} · ? 或 /help 查看命令 · 直接输入任务回车运行`, 'dim');

  let history: ChatMessage[] = [];
  rt.onSubmit(() => {
    const line = rt.consumeInput().trim();
    if (!line) return;
    void handleLine(line);
  });

  async function handleLine(line: string): Promise<void> {
    if (line === '/exit' || line === '/quit') {
      rt.destroy();
      for (const c of clients) c.close();
      process.exit(0);
    }
    if (line === '?' || line === '/help') {
      rt.addText('/tools 工具 · /skills 技能 · /ops /ops scan 雷达 · /mcp 服务器 · /status 状态 · /clear 清屏 · /exit 退出 · ↑↓ 历史 · PgUp/PgDn 翻页 · Esc 清输入', 'dim');
      return;
    }
    if (line === '/clear') { rt.setStatus(''); return; }
    if (line === '/status') { rt.setStatus(`${(cfg.locale ?? 'zh')} · ${skills.length} skills · ${chatModel}`); return; }
    if (line === '/tools') {
      for (const tool of reg.list()) rt.addText(`${tool.name}${tool.needsApproval ? YELLOW(' [gated]') : ''} — ${tool.description.split('\n')[0].slice(0, 80)}`);
      return;
    }
    if (line === '/skills') {
      const active = await listSkills(home);
      const drafts = await listDrafts(home);
      for (const s of active) rt.addText(`${GREEN('+')} ${s.name} — ${s.description}`);
      for (const s of drafts) rt.addText(`${YELLOW('~')} ${s.name} — ${s.description}`);
      return;
    }
    if (line === '/mcp') {
      for (const [name, c] of Object.entries(cfg.mcpServers ?? {})) rt.addText(`${name} — ${c.type}${c.trusted ? ' · trusted' : ' · gated'}`);
      return;
    }

    rt.addText(`❯ ${line}`);
    rt.setBusy(true, t.running);
    let appender: ((c: string) => void) | null = null;
    let kind: import('@hmh/kernel').DeltaKind | null = null;
    try {
      const result = await runAgentTask({
        task: line,
        registry: reg,
        cfg,
        yes,
        resumeMessages: history,
        approvalAsk: (name, args) => rt.requestApproval(name, args),
        events: {
          onLine: (l) => { appender = null; kind = null; rt.addText(l, 'dim'); },
          onDelta: (k, chunk) => {
            if (k !== kind) { appender = rt.startStream(k === 'reasoning' ? 'think' : 'say'); kind = k; }
            appender?.(chunk);
          },
          onToolCall: (name, args) => {
            appender = null; kind = null;
            rt.addText(`${YELLOW('●')} ${CYAN(name)} ${DIM(JSON.stringify(args).slice(0, 100))}`);
          },
          onToolResult: (name, output, isError) => {
            const dot = isError ? RED('✗') : GREEN('•');
            rt.addText(`  ${dot} ${DIM('⎿ ' + output.split('\n').slice(0, 2).join(' ').slice(0, 110))}`);
          },
        },
      });
      rt.setBusy(false);
      rt.setStatus(`↑${result.usage.promptTokens} ↓${result.usage.completionTokens} tok · ${result.turns} turns · ${result.toolUses} tools`);
      history = [...history, { role: 'user', content: line }, ...result.messages.slice(history.length + 2)];
    } catch (err) {
      rt.setBusy(false);
      rt.addText(String(err), 'err');
    }
  }

  await rt.waitExit();
  rt.destroy();
  for (const c of clients) c.close();
  stdout.write('\n');
}
