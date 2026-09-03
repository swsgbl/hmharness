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
import { loadConfig, homeDir, resolveProvider, listProviders, setChatRoute, PROVIDER_PRESETS, addProviders, detectLocalProviders, type ChatMessage } from '@hmh/kernel';
import { listDrafts, listSkills, runBench, runEvolution } from '@hmh/evolution';
import { buildRegistry, runAgentTask, strings, type Locale } from '@hmh/agent';
import { ensureWebDaemon, DEFAULT_WEB_PORT } from './web-daemon.ts';

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

/* ---------------- slash commands + mouse wheel (pure, testable) ---------------- */

/** desc keys index into Strings (agent i18n); matched by name at runtime. */
export const COMMANDS: Array<{ name: string; key: string }> = [
  { name: '/help', key: 'cmdHelp' },
  { name: '/tools', key: 'cmdTools' },
  { name: '/skills', key: 'cmdSkills' },
  { name: '/model', key: 'cmdModel' },
  { name: '/yolo', key: 'cmdYolo' },
  { name: '/providers', key: 'cmdProviders' },
  { name: '/mouse', key: 'cmdMouse' },
  { name: '/ops', key: 'cmdOps' },
  { name: '/ops scan', key: 'cmdOpsScan' },
  { name: '/bench', key: 'cmdBench' },
  { name: '/evolve', key: 'cmdEvolve' },
  { name: '/mcp', key: 'cmdMcp' },
  { name: '/status', key: 'cmdStatus' },
  { name: '/clear', key: 'cmdClear' },
  { name: '/web', key: 'cmdWeb' },
  { name: '/exit', key: 'cmdExit' },
];

/** Commands whose name starts with the input (input must start with '/'). */
export function matchCommands(input: string): Array<{ name: string; key: string }> {
  if (!input.startsWith('/')) return [];
  const q = input.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

/**
 * SGR mouse wheel decoding: '\x1b[<64;COL;ROWM' is wheel-up (-1), 65 is
 * wheel-down (+1), anything else (clicks, drags, plain keys) is 0.
 */
export function parseWheel(data: string): number {
  const m = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
  if (!m) return 0;
  const btn = Number(m[1]);
  if (btn === 64) return -1;
  if (btn === 65) return 1;
  return 0;
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
  private cmdIdx = 0;   // selected row in the slash palette (arrow keys)
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
  /** persistent header tag, e.g. the active approval mode (🔥 YOLO) */
  private modeTag = '';
  /** rows for the `/model ` picker (configured providers first, set by driver) */
  private modelChoices: Array<{ name: string; desc: string }> = [];
  /** Wheel handling without ever capturing the mouse: NO mouse-reporting
   *  mode is enabled by default, so select/copy always works. Terminals
   *  translate the wheel to arrow keys on the alternate screen themselves
   *  (conhost/WT), and the transcript treats ↑/↓ as scroll when not
   *  scrolled to the bottom. `/mouse` opts into SGR wheel reporting
   *  (1000+1006) for terminals without that fallback - at the cost of
   *  native selection while enabled. */
  private mouse = false;

  constructor() {
    stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (d: string) => this.onKey(d));
    stdout.on('resize', () => { this.dirty = true; });
    this.renderTimer = setInterval(() => this.render(), 90);
  }

  setModelChoices(list: Array<{ name: string; desc: string }>): void {
    this.modelChoices = list;
    this.dirty = true;
  }

  setModeTag(tag: string): void {
    this.modeTag = tag;
    this.dirty = true;
  }

  toggleMouse(): boolean {
    this.mouse = !this.mouse;
    // full mouse capture is the fallback for terminals that do not map the
    // wheel to arrows on the alt screen; it costs native selection
    stdout.write(this.mouse
      ? '\x1b[?1006h\x1b[?1000h'
      : '\x1b[?1000l\x1b[?1006l');
    this.dirty = true;
    return this.mouse;
  }

  /** The palette data source: `/model ` opens the model picker, otherwise
   *  slash commands. Rows are {name, desc} so both share one renderer. */
  private panelItems(input: string): Array<{ name: string; desc: string }> {
    if (input === '/model' || input.startsWith('/model ')) {
      const q = input.slice(6).trim().toLowerCase();
      const configured = this.modelChoices;
      const rest = PROVIDER_PRESETS
        .filter((p) => !configured.some((c) => c.name === p.name))
        .map((p) => ({ name: p.name, desc: `${p.model}${p.envVar ? ' · set ' + p.envVar : ' · local'}` }));
      const all = [...configured, ...rest];
      return q ? all.filter((i) => i.name.toLowerCase().startsWith(q)) : all;
    }
    return matchCommands(input).map((c) => ({ name: c.name, desc: String(this.t[c.key as keyof typeof this.t]) }));
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
    stdout.write((this.mouse ? '\x1b[?1000l\x1b[?1006l' : '') + '\x1b[?25h\x1b[?1049l');
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
      if (kind === 'say') {
        const wrapped = wrapTo(buf, width);
        lines.length = 0;
        wrapped.forEach((l) => lines.push(l));
      } else {
        // thinking stays FOLDED while streaming: one live line (what Claude
        // Code shows), never the raw chain-of-thought - it is model-internal
        // planning, not user-facing output, and it swamped the transcript
        lines.length = 0;
        const tail = buf.replace(/\s+/g, ' ').trim();
        lines.push(DIM('∴ ' + this.t.thinking + (tail ? ' · ' + tail.slice(-width + 18) : '…')));
      }
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

  /** Collapse a streamed thinking block to its final folded summary line. */
  foldThinking(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const isThinking = e.lines.length === 1 && /^\x1b\[2m∴ /.test(e.lines[0]);
      if (isThinking) {
        e.lines.length = 0;
        e.lines.push(DIM('∴ ' + this.t.thought));
        this.dirty = true;
        return;
      }
    }
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

  clearScreen(): void {
    this.entries = [];
    this.scrollFromBottom = 0;
    this.status = '';
    this.dirty = true;
  }

  private totalLines(): number {
    let n = 0;
    for (const e of this.entries) n += e.lines.length;
    return n;
  }

  private onKey(data: string): void {
    // wheel-only mouse routing: 64 = wheel-up, 65 = wheel-down. With
    // button-event mode (1002) everything else - click, drag, release,
    // motion - still belongs to the terminal's native selection.
    const wheel = parseWheel(data);
    if (wheel !== 0) {
      // wheel-up (-1) moves the viewport UP, i.e. further from the bottom
      this.scrollFromBottom = Math.max(0, Math.min(this.totalLines(), this.scrollFromBottom - wheel * 3));
      this.dirty = true;
      return;
    }
    // swallow any other SGR mouse report that slips through so it never
    // leaks into the input line as garbage
    if (/^\x1b\[<\d+;\d+;\d+[Mm]/.test(data)) return;

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
    if (data === '\r') {
      // palette is open: Enter runs the highlighted row (a command, or a
      // /model target), not the raw input
      const hits = this.panelItems(this.input);
      if (hits.length) {
        const pick = hits[Math.min(this.cmdIdx, hits.length - 1)].name;
        this.input = this.input.startsWith('/model')
          ? `/model ${pick} `
          : pick + ' ';
        this.caret = this.input.length;
        this.cmdIdx = 0;
      }
      this.driver?.();
      return;
    }
    if (data === '\t') {
      const hits = this.panelItems(this.input);
      if (hits.length) {
        this.input = this.input.startsWith('/model')
          ? `/model ${hits[Math.min(this.cmdIdx, hits.length - 1)].name} `
          : hits[Math.min(this.cmdIdx, hits.length - 1)].name + ' ';
        this.caret = this.input.length;
        this.cmdIdx = 0;
        this.dirty = true;
      }
      return;
    }
    if (data === '\x7f' || data === '\b') {
      if (this.caret > 0) {
        this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
        this.caret--;
      }
      this.cmdIdx = 0;
      this.dirty = true;
      return;
    }
    // ↑/↓: the terminal's wheel→arrow fallback (alt screen, no mouse
    // capture) arrives here, so the arrows ARE the wheel in this mode:
    // they scroll the transcript (clamped), never touching history. Input
    // history stays on PgUp/PgDn-adjacent keys and re-typing; the command
    // palette (when open) takes priority for selection.
    if (data === '\x1b[A') {
      const hits = this.panelItems(this.input);
      if (hits.length) {
        this.cmdIdx = Math.max(0, this.cmdIdx - 1);
        this.dirty = true;
        return;
      }
      if (this.scrollFromBottom < this.totalLines()) {
        this.scrollFromBottom = Math.min(this.totalLines(), this.scrollFromBottom + 3);
        this.dirty = true;
      }
      return;
    }
    if (data === '\x1b[B') {
      const hits = this.panelItems(this.input);
      if (hits.length) {
        this.cmdIdx = Math.min(hits.length - 1, this.cmdIdx + 1);
        this.dirty = true;
        return;
      }
      if (this.scrollFromBottom > 0) {
        this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 3);
        this.dirty = true;
      }
      return;
    }
    // history walk: Ctrl+P / Ctrl+N (readline-standard; arrows are the
    // terminal's wheel in this mode)
    if (data === '\x10') {
      if (this.histIdx < this.history.length - 1) {
        this.histIdx++;
        this.input = this.history[this.histIdx] ?? '';
        this.caret = this.input.length;
        this.cmdIdx = 0;
        this.dirty = true;
      }
      return;
    }
    if (data === '\x0e') {
      if (this.histIdx > 0) {
        this.histIdx--;
        this.input = this.history[this.histIdx] ?? '';
      } else {
        this.histIdx = -1;
        this.input = '';
      }
      this.caret = this.input.length;
      this.cmdIdx = 0;
      this.dirty = true;
      return;
    }
    if (data === '\x1b[C') { if (this.caret < this.input.length) { this.caret++; this.dirty = true; } return; }
    if (data === '\x1b[D') { if (this.caret > 0) { this.caret--; this.dirty = true; } return; }
    if (data === '\x1b[5~') { this.scrollFromBottom += 10; this.dirty = true; return; }
    if (data === '\x1b[6~') { this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 10); this.dirty = true; return; }
    if (data === '\x1b[H') { this.scrollFromBottom = 100000; this.dirty = true; return; }
    if (data === '\x1b[F') { this.scrollFromBottom = 0; this.dirty = true; return; }
    if (data === '\x1b') { this.input = ''; this.caret = 0; this.cmdIdx = 0; this.dirty = true; return; }
    if (data === '\x0c') { this.dirty = true; return; }
    if (data.startsWith('\x1b') || data < ' ') return;

    // printable text (CJK / IME preedit arrives as normal chunks)
    this.input = this.input.slice(0, this.caret) + data + this.input.slice(this.caret);
    this.caret += data.length;
    this.cmdIdx = 0;
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
    const headLeft = ` ${BOLD('⚙ hmh')} ${DIM('·')} ${CYAN(this.model)} ${DIM('·')} ${this.cwdName} ${DIM('·')} ${this.skillCount} ${this.t.tuiSkills}`;
    const headRight = this.busy
      ? YELLOW(`${spin} ${this.status || '…'}`)
      : GREEN(this.t.tuiIdle + (this.modeTag ? ' ' + this.modeTag : ''));
    frame.push(truncateTo(headLeft + ' '.repeat(Math.max(1, W - strWidth(stripAnsi(headLeft)) - strWidth(stripAnsi(headRight)))) + headRight, W));
    frame.push(DIM('─'.repeat(W)));

    const allLines: string[] = [];
    for (const e of this.entries) allLines.push(...e.lines);
    const cmdHits = this.panelItems(this.input);
    const cmdRows = cmdHits.length ? Math.min(cmdHits.length, 6) : 0;
    const approvalRows = this.approval ? 3 : 0;
    // the input box grows with wrapped content: rows + 2 border lines + 1
    // status line. Cap it at half the screen so the transcript keeps room;
    // beyond that the inner text clips (rare - one line holds ~100+ cols).
    const inputRows = (() => {
      const iw = Math.max(10, W - 6);
      let n = 1;
      let w = 0;
      for (const ch of this.input) {
        const cwv = cw(ch);
        if (w + cwv > iw) { n++; w = 0; }
        w += cwv;
      }
      return Math.min(n, Math.max(1, Math.floor(H / 2) - 3));
    })();
    const viewH = Math.max(3, H - 4 - inputRows - approvalRows - cmdRows);
    const start = Math.max(0, allLines.length - viewH - this.scrollFromBottom);
    const view = allLines.slice(start, start + viewH);
    for (let i = 0; i < viewH; i++) frame.push(i < view.length ? truncateTo(view[i], W) : '');

    if (this.approval) {
      const argsTxt = JSON.stringify(this.approval.args);
      frame.push(YELLOW(this.t.tuiApproval) + ' ' + YELLOW(BOLD(this.approval.name)) + ' ' + DIM(truncateTo(argsTxt, Math.max(0, W - 24))));
      frame.push(`  [y] ${GREEN(this.t.tuiApprove)}   [n] ${RED(this.t.tuiDeny)}   ${DIM(this.t.tuiApprovalHint)}`);
      frame.push(DIM('─'.repeat(W)));
    }

    // palette (slash commands or the /model picker): shows while the input
    // starts with '/'; arrows move the selection (scrolling 6-row window),
    // Enter/Tab run/complete the highlighted row
    if (cmdRows) {
      const from = Math.max(0, Math.min(this.cmdIdx - 5, cmdHits.length - 6));
      for (let i = 0; i < cmdRows; i++) {
        const gi = from + i;
        const c = cmdHits[gi];
        const sel = gi === this.cmdIdx;
        frame.push(truncateTo((sel ? '› ' : '  ') + (sel ? CYAN(c.name) : DIM(c.name)) + '  ' + DIM(truncateTo(c.desc, 46)), W - 1));
      }
    }

    // input box: width-aware auto-wrap. The old render sliced the input by
    // character count (CJK chars are 2 columns -> the line overflowed the
    // frame and got hard-wrapped by the terminal, tearing the layout) and
    // only ever showed the tail of long input. Now the content wraps inside
    // a growing box, '❯' marks the first row, and the caret tracks the
    // visible position across wraps.
    const iw = Math.max(10, W - 6);                       // inner text width
    const inputCap = Math.max(1, Math.floor(H / 2) - 3);  // keep transcript room
    const sliceToCols = (text: string, maxCols: number): [string, number] => {
      let w = 0;
      let n = 0;
      for (const ch of text) {
        const chw = cw(ch);
        if (w + chw > maxCols) break;
        w += chw;
        n += ch.length;
      }
      return [text.slice(0, n), w];
    };
    // caret placement in display columns (code-point aware)
    let caretCols = 0;
    {
      let idx = 0;
      for (const ch of this.input) {
        if (idx >= this.caret) break;
        caretCols += cw(ch);
        idx += ch.length;
      }
    }
    // wrap the input into rows of iw columns, remembering each row's first
    // code-point index and the row/col of the caret; beyond the cap, show
    // the tail rows around the caret (the head clips away)
    const rows: Array<{ text: string; start: number }> = [];
    {
      let rowStart = 0;
      let w = 0;
      let idx = 0;
      let cur = '';
      for (const ch of this.input) {
        const chw = cw(ch);
        if (w + chw > iw) {
          rows.push({ text: cur, start: rowStart });
          rowStart = idx;
          w = 0;
          cur = '';
        }
        cur += ch;
        w += chw;
        idx += ch.length;
      }
      rows.push({ text: cur, start: rowStart });
    }
    if (rows.length > inputCap) {
      let caretRow0 = 0;
      for (let i = 0; i < rows.length; i++) {
        const end = rows[i].start + rows[i].text.length;
        if (this.caret >= rows[i].start && this.caret <= end) { caretRow0 = i; break; }
      }
      const from = Math.max(0, Math.min(caretRow0 - (inputCap - 1), rows.length - inputCap));
      const cut = rows[from].start;
      const clippedRows = rows.slice(from, from + inputCap).map((r) => ({ text: r.text, start: r.start - cut }));
      clippedRows[0].text = (from > 0 ? '…' : '') + clippedRows[0].text;
      clippedRows[0].start += from > 0 ? 1 : 0;
      rows.length = 0;
      rows.push(...clippedRows);
    }
    let caretRow = 0;
    let caretCol = 0;
    for (let i = 0; i < rows.length; i++) {
      const end = rows[i].start + rows[i].text.length;
      if (this.caret >= rows[i].start && this.caret <= end) { caretRow = i; break; }
    }
    caretCol = Math.max(0, strWidth(rows[caretRow].text.slice(0, this.caret - rows[caretRow].start)));
    const boxRows = Math.max(1, rows.length);
    frame.push(DIM('┌' + '─'.repeat(iw + 2) + '┐'));
    for (let i = 0; i < boxRows; i++) {
      const rowText = rows[i].text;
      if (i === caretRow) {
        const inRow = this.caret - rows[i].start;
        const before = rowText.slice(0, inRow);
        const atChar = rowText.slice(inRow, inRow + 1) || ' ';
        const after = rowText.slice(inRow + atChar.length);
        const atW = cw(atChar === ' ' ? ' ' : atChar);
        const pad = ' '.repeat(Math.max(0, iw - strWidth(before) - atW - strWidth(after)));
        const caretSpan = this.busy ? DIM(atChar === ' ' ? ' ' : atChar) : `\x1b[7m${atChar === ' ' ? ' ' : atChar}\x1b[27m`;
        frame.push(DIM('│ ') + (i === 0 ? '❯ ' : '  ') + before + caretSpan + after + pad + DIM(' │'));
      } else {
        const [clipped] = sliceToCols(rowText, iw);
        const pad = ' '.repeat(Math.max(0, iw - strWidth(clipped)));
        frame.push(DIM('│ ') + (i === 0 ? '❯ ' : '  ') + clipped + pad + DIM(' │'));
      }
    }
    frame.push(DIM('└' + '─'.repeat(iw + 2) + '┘'));

    const hints = this.scrollFromBottom > 0
      ? `${DIM(this.t.tuiScrolled)}`
      : `${DIM(this.t.tuiHints + (this.mouse ? '' : '  · /mouse ' + this.t.mouseOff))}`;
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

export async function tui(yes: boolean, noWeb = false): Promise<void> {
  let cfg = await loadConfig();
  let autoApprove = yes || cfg.approval === 'auto';
  if (!stdin.isTTY) {
    stdout.write(strings((cfg.locale ?? 'zh') as Locale).tuiNeedsTty + '\n');
    process.exitCode = 1;
    return;
  }
  const home = homeDir();
  const t = strings((cfg.locale ?? 'zh') as Locale);
  const { reg, clients } = await buildRegistry({ announce: false });
  // auto-link: bring the web UI up in the background (hmh tui --no-web skips)
  const webUp = noWeb ? false : await ensureWebDaemon(DEFAULT_WEB_PORT);
  const rt = new TuiRuntime();
  const skills = await listSkills(home);
  const chatModel = resolveProvider(cfg, 'chat').model;
  rt.configure(chatModel, basename(process.cwd()), skills.length, (cfg.locale ?? 'zh') as Locale);
  rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
  if (autoApprove) rt.setModeTag('🔥');
  rt.addText(t.tuiWelcome(chatModel), 'dim');
  if (webUp) rt.addText(t.tuiWebLinked(DEFAULT_WEB_PORT), 'dim');

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
      rt.addText(COMMANDS.map((c) => '  ' + c.name.padEnd(11) + ' ' + String(t[c.key as keyof typeof t])).join('\n'), 'dim');
      return;
    }
    if (line === '/clear') { rt.clearScreen(); return; }
    if (line === '/status') { rt.setStatus(t.tuiStatus(cfg.locale ?? 'zh', skills.length, chatModel)); return; }
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
    if (line === '/web') {
      rt.setBusy(true, '/web');
      const up = await ensureWebDaemon(DEFAULT_WEB_PORT);
      rt.setBusy(false);
      rt.addText(up ? t.tuiWebLinked(DEFAULT_WEB_PORT) : t.tuiWebHint, 'dim');
      return;
    }
    if (line === '/yolo' || line === '/yolo on' || line === '/yolo off') {
      const turnOn = line === '/yolo' ? !autoApprove : line === '/yolo on';
      autoApprove = turnOn;
      rt.setModeTag(turnOn ? '🔥' : '');
      rt.addText(turnOn ? t.yoloOn : t.yoloOff, turnOn ? 'plain' : 'dim');
      return;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const arg = line.slice(7).trim();
      if (!arg) {
        // bare /model: the palette opens as soon as you type the space -
        // listing here too for the transcript record
        rt.addText(listProviders(cfg).map((v) => `${v.purposes.includes('chat') ? GREEN('●') : DIM('○')} ${v.name} — ${v.model}${v.purposes.length ? DIM(` (${v.purposes.join('/')})`) : ''}`).join('\n') + '\n' + DIM('/model <name> 切换 chat 路由'), 'plain');
        return;
      }
      rt.setBusy(true, '/model');
      try {
        cfg = await setChatRoute(arg);
        rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
        rt.addText(GREEN('✓') + ` chat → ${arg} · ${resolveProvider(cfg, 'chat').model}`);
      } catch (err) {
        const preset = PROVIDER_PRESETS.find((p) => p.name === arg);
        rt.addText(preset
          ? `${arg} 尚未配置 — 设置环境变量 ${preset.envVar || '(local)'} 后运行 /providers scan 添加`
          : String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/providers' || line === '/providers scan') {
      rt.setBusy(true, '/providers scan');
      try {
        const { readFile } = await import('node:fs/promises');
        const found = await detectLocalProviders(cfg, readFile);
        if (line === '/providers') {
          rt.addText(found.length
            ? found.map((p) => `${YELLOW('+')} ${p.name} — ${p.model} (${p.envVar})`).join('\n') + '\n' + DIM('/providers scan 将它们写入配置')
            : DIM('未探测到新的本地厂商(环境变量/opencode 配置)'), 'plain');
        } else {
          if (!found.length) {
            rt.addText(DIM('未探测到新的厂商;已配置: ') + Object.keys(cfg.providers ?? {}).join(', '), 'plain');
          } else {
            const r = await addProviders(found.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })));
            cfg = r.cfg;
            rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
            rt.addText(GREEN('✓') + ` 已添加 ${r.added.length} 个厂商: ${r.added.join(', ')} — /model <name> 启用`);
          }
        }
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/mouse') {
      const on = rt.toggleMouse();
      rt.addText(on
        ? '鼠标上报兜底: 已开启(滚轮直接控制翻页;此模式下拖选暂不可用,再按 /mouse 关闭恢复)'
        : '鼠标上报兜底: 已关闭(终端原生拖选复制;滚轮由终端转为 ↑↓ 翻页)', 'dim');
      return;
    }
    if (line === '/ops') {
      rt.setBusy(true, '/ops');
      try {
        const { harmonyOpsStatus } = await import('@hmh/domain-ops');
        const r = await harmonyOpsStatus.execute({}, { cwd: process.cwd(), home });
        rt.addText(r.output);
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/ops scan') {
      rt.setBusy(true, t.tuiRadarScanning);
      try {
        const { harmonyOpsRadarScan } = await import('@hmh/domain-ops');
        const r = await harmonyOpsRadarScan.execute({}, { cwd: process.cwd(), home });
        rt.addText(r.output);
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/bench') {
      rt.setBusy(true, '/bench');
      try {
        const { chat } = await import('@hmh/kernel');
        const { results, passRate } = await runBench(home, async (c) => {
          // plain model call keeps the TUI bench fast; loop cases fall back
          // to the dedicated `hmh bench` command
          if (c.tools) return "(skipped in tui; run 'hmh bench')";
          const r = await chat(cfg.provider, [{ role: 'user', content: c.prompt }]);
          return r.message.content ?? '';
        });
        for (const r of results) rt.addText(`${r.pass ? GREEN('PASS') : YELLOW('FAIL')} ${r.name} — ${r.detail}`);
        rt.addText(t.tuiPassRate(`${(passRate * 100).toFixed(0)}%`));
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/evolve') {
      rt.setBusy(true, '/evolve');
      try {
        const { chat } = await import('@hmh/kernel');
        const report = await runEvolution({
          home,
          provider: cfg.provider,
          runCase: async (c) => {
            if (c.tools) return '(skipped in tui; run hmh evolve)';
            const r = await chat(cfg.provider, [{ role: 'user', content: c.prompt }]);
            return r.message.content ?? '';
          },
          log: (l) => rt.addText(l, 'dim'),
        });
        rt.addText(t.tuiEvolveDone(report.proposals.length, report.insightCount, report.noteCount));
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
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
        yes: autoApprove,
        resumeMessages: history,
        approvalAsk: (name, args) => rt.requestApproval(name, args),
        events: {
          onLine: (l) => { if (kind === 'reasoning') rt.foldThinking(); appender = null; kind = null; rt.addText(l, 'dim'); },
          onDelta: (k, chunk) => {
            if (k !== kind) {
              if (kind === 'reasoning') rt.foldThinking(); // collapse before the next phase
              appender = rt.startStream(k === 'reasoning' ? 'think' : 'say'); kind = k;
            }
            appender?.(chunk);
          },
          onToolCall: (name, args) => {
            if (kind === 'reasoning') rt.foldThinking();
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
