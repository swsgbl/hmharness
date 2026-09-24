/**
 * @hmharness/cli - tui (fullscreen, Claude-Code / dsh-TUI style)
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
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, homeDir, resolveProvider, listProviders, setChatRoute, setLocale, PROVIDER_PRESETS, addProviders, detectLocalProviders, latestSession, listSessions, loadTranscript, transcriptChars, compactMessages, adaptiveContextChars, getGoal, setGoal, clearGoal, type ChatMessage, type SessionSummary } from '@hmharness/kernel';
import { listDrafts, listSkills, runBench, runEvolution } from '@hmharness/evolution';
import { buildRegistry, runAgentTask, strings, type Locale } from '@hmharness/agent';
import { ensureWebDaemon, DEFAULT_WEB_PORT } from './web-daemon.ts';
import { formatRow, initialPickerState, pickerKey, reducePicker, toolbarLine, visibleRows, type PickerState } from './resume-picker.ts';

/** installed version, shown in the TUI header (v0.4.0) so users always
 *  know which build they are talking to - resolves in both src/ and dist/ */
const HMH_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version as string; } catch { return ''; }
})();

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
  { name: '/lang', key: 'cmdLang' },
  { name: '/yolo', key: 'cmdYolo' },
  { name: '/providers', key: 'cmdProviders' },
  { name: '/ops', key: 'cmdOps' },
  { name: '/ops scan', key: 'cmdOpsScan' },
  { name: '/ops brief', key: 'cmdOpsBrief' },
  { name: '/bench', key: 'cmdBench' },
  { name: '/evolve', key: 'cmdEvolve' },
  { name: '/mcp', key: 'cmdMcp' },
  { name: '/resume', key: 'cmdResume' },
  { name: '/status', key: 'cmdStatus' },
  { name: '/clear', key: 'cmdClear' },
  { name: '/compact', key: 'cmdCompact' },
  { name: '/diff', key: 'cmdDiff' },
  { name: '/new', key: 'cmdNew' },
  { name: '/fork', key: 'cmdFork' },
  { name: '/copy', key: 'cmdCopy' },
  { name: '/mouse', key: 'cmdMouse' },
  { name: '/plan', key: 'cmdPlan' },
  { name: '/goal', key: 'cmdGoal' },
  { name: '/usage', key: 'cmdUsage' },
  { name: '/statusline', key: 'cmdStatusline' },
  { name: '/keymap', key: 'cmdKeymap' },
  { name: '/review', key: 'cmdReview' },
  { name: '/web', key: 'cmdWeb' },
  { name: '/exit', key: 'cmdExit' },
];

/** Commands whose name starts with the input (input must start with '/'). */
export function matchCommands(input: string): Array<{ name: string; key: string }> {
  if (!input.startsWith('/')) return [];
  const q = input.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

/** `/lang` target resolver: explicit zh/en wins, a bare `/lang` toggles. */
export function nextLocale(current: string, arg: string): 'zh' | 'en' {
  const a = arg.trim().toLowerCase();
  if (a === 'zh' || a === 'en') return a;
  return current === 'en' ? 'zh' : 'en';
}

/* ---------------- M2 runtime-steering helpers (pure, testable) ---------------- */

/** The trailing `@<query>` token of a task line, or null. Drives the @-file
 *  palette (codex/dsh @ reference): typing '@' opens it, the following
 *  path-ish chars extend the query, Enter inserts the picked path. */
export function atToken(input: string): string | null {
  if (input.startsWith('/')) return null; // slash commands never @-reference
  const m = /@([\w./\\-]*)$/.exec(input);
  return m ? m[1] : null;
}

/** Substring history search (Ctrl+R): indices of entries containing the
 *  query (case-insensitive), NEWEST first, capped at 50. Empty query lists
 *  the most recent 50. */
export function histMatches(history: string[], query: string): number[] {
  const q = query.trim().toLowerCase();
  const out: number[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < 50; i--) {
    if (!q || history[i].toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/** `!` line prefix → the shell command to run (B3), or null. Empty `!` is
 *  not a command. */
export function shellBang(line: string): string | null {
  if (!line.startsWith('!')) return null;
  const cmd = line.slice(1).trim();
  return cmd || null;
}

/** Double-Esc fork-edit arming (B6): a bare Esc when idle+empty returns true
 *  only if the previous Esc was within `windowMs` and the arm is set. Pure
 *  timing decision; the runtime keeps escAt/armed state. */
export function forkArm(prevAt: number, now: number, armed: boolean, windowMs = 800): boolean {
  return armed && now - prevAt < windowMs;
}

/** Index of the LAST user-role message — the fork point (T13): a fork keeps
 *  everything BEFORE it as the new thread's resume and replaces it with the
 *  edited message. -1 when there is none. */
export function lastUserIdx(messages: Array<{ role: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/* ---------------- M5: statusline template + keymap (pure, testable) ---------------- */

/** /statusline (B11): render a configurable bottom-line template. Supported
 *  placeholders: {model} {cwd} {skills} {mode} {queue} {version} — unknown
 *  tokens stay literal so a typo is visible, never silently dropped. */
export function renderStatusline(template: string, ctx: { model: string; cwd: string; skills: number; mode: string; queue: number; version: string }): string {
  const map: Record<string, string> = {
    model: ctx.model, cwd: ctx.cwd, skills: String(ctx.skills),
    mode: ctx.mode, queue: String(ctx.queue), version: ctx.version,
  };
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

/** /keymap (B14): parse a human key spec into the raw-mode byte string the
 *  TUI dispatches on. Returns null for unknown specs. */
export function parseKeySpec(spec: string): string | null {
  const s = String(spec ?? '').trim().toLowerCase();
  const named: Record<string, string> = {
    'ctrl+j': '\x0a', 'ctrl-enter': '\x0a', 'ctrl+r': '\x12', 'ctrl+t': '\x14',
    'ctrl+g': '\x07', 'ctrl+p': '\x10', 'ctrl+n': '\x0e', esc: '\x1b', enter: '\r', tab: '\t',
  };
  if (named[s]) return named[s];
  if (/^[a-z0-9]$/.test(s)) return s;
  return null;
}

/** The remappable M2/M4 actions and their defaults (B14). */
export const KEYMAP_DEFAULTS: Record<string, string> = {
  interrupt: '\x1b',        // T9: stop the running turn
  inject: '\x0a',           // T10: Ctrl+Enter inject
  historySearch: '\x12',    // T14: Ctrl+R
  transcript: '\x14',       // T15: Ctrl+T
  externalEdit: '\x07',     // B12: Ctrl+G
};

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

/**
 * SGR reports can split across stdin chunks (fast wheel bursts fragment in
 * some terminals). If the buffer ends inside a report - a trailing
 * '\x1b[<...' with no terminating M/m yet - slice it off as `pending` for
 * the next chunk and hand back only the complete part.
 */
export function splitMouseReport(data: string): { data: string; pending: string } {
  const cut = data.lastIndexOf('\x1b[<');
  if (cut === -1) return { data, pending: '' };
  const tail = data.slice(cut);
  return /^\x1b\[<\d+(;\d+)*[Mm]$/.test(tail)
    ? { data, pending: '' }
    : { data: data.slice(0, cut), pending: tail };
}

/**
 * Bracketed-paste body cleanup: strip the 200~/201~ markers and any escape
 * sequences (pasted terminal controls must not leak into the input line),
 * and collapse newlines to single spaces - a multi-line paste becomes ONE
 * reviewable input instead of auto-submitting each line as its own command.
 * Capped so a runaway paste cannot balloon the input field.
 */
export function sanitizePaste(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[ \t]+$/, '')
    .slice(0, 262144);
}

/**
 * /copy clipboard candidates for the platform/session: Wayland first when
 * WAYLAND_DISPLAY is set (xclip does not exist on a pure wl session), then
 * X11's xclip with xsel as fallback. Empty when nothing plausible applies.
 * The caller tries them in order until one spawns; the final "output
 * follows" degrade stays for systems with no clipboard utility at all
 * (e.g. the KaihongOS guest terminal).
 */
export function clipboardCandidates(platform: string, env: { WAYLAND_DISPLAY?: string; DISPLAY?: string }): Array<{ bin: string; args: string[] }> {
  if (platform === 'win32') return [{ bin: 'clip', args: [] }];
  if (platform === 'darwin') return [{ bin: 'pbcopy', args: [] }];
  const out: Array<{ bin: string; args: string[] }> = [];
  if (env.WAYLAND_DISPLAY) out.push({ bin: 'wl-copy', args: [] });
  if (env.DISPLAY) {
    out.push({ bin: 'xclip', args: ['-selection', 'clipboard'] });
    out.push({ bin: 'xsel', args: ['--clipboard', '--input'] });
  }
  return out;
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
  /** queued task count: the busy hints line shows it live (queue at a glance,
   *  no /queue query needed) */
  private queued = 0;
  private renderTimer?: NodeJS.Timeout;
  private exitResolve: (() => void) | null = null;
  private driver: (() => void) | null = null;
  private model = '';
  private cwdName = '';
  private skillCount = 0;
  private t = strings();
  /** installed hmharness version, shown in the header (v0.4.0 style);
   *  defaults to the running build so even a bare runtime identifies itself */
  private version = HMH_VERSION;
  /** persistent header tag, e.g. the active approval mode (🔥 YOLO) */
  private modeTag = '';
  /** rows for the `/model ` picker (configured providers first, set by driver) */
  private modelChoices: Array<{ name: string; desc: string }> = [];
  /** Wheel/click handling (T23, settled design): capture (?1000h+?1006h)
   *  is OFF by default - click-drag must stay the terminal's NATIVE
   *  selection, always-on capture took that away on every system. The
   *  wheel is covered by ?1007 (alternate scroll, enabled at startup):
   *  the terminal itself translates wheel -> arrow keys without touching
   *  clicks, and the existing arrow path scrolls the transcript. Capture
   * turns on only while a palette is open (clicks choose rows, wheel
   * drives selection) or when the user forces it with /mouse for
   * terminals that honour neither wheel translation nor ?1007 (legacy
   * conhost); Shift+drag still selects on mainstream terminals then. */
  private mouseReported = false;
  /** /mouse force flag (persisted as config.json tui.mouse): full-time
   *  capture for terminals without any wheel translation */
  private forceMouse = false;
  /** tail of an SGR mouse report split across stdin chunks (fast wheel
   *  bursts); prepended to the next chunk so parseWheel sees the sequence */
  private mousePending = '';
  /** bracketed-paste accumulator: non-null while the 201~ end marker has
   *  not arrived yet; everything buffered is literal insert-on-completion */
  private pasteBuf: string | null = null;
  /** restores the console methods and process handlers captured by the
   *  TUI's terminal ownership (see installConsoleRedirection) */
  private restoreConsole: (() => void) | null = null;
  private fatalHandler: ((err: unknown) => void) | null = null;
  /** screen row of each visible palette item (SGR click hit-testing); the
   *  render loop records row = frame.length (1-based) as it pushes rows */
  private paletteClickRows: Array<{ row: number; idx: number }> = [];

  /* ---------------- M2: runtime steering modals (codex parity) ---------------- */
  /** Ctrl+R incremental history search: { query, matches (history indices), sel } */
  private histSearch: { query: string; matches: number[]; sel: number } | null = null;
  /** Ctrl+T full-transcript overlay (also the pager base for B9): title + lines + viewport top */
  private overlay: { title: string; lines: string[]; top: number } | null = null;
  /** @-file palette (codex @ fuzzy reference): trailing @token query + ranked hits */
  private atPal: { query: string; results: Array<{ rel: string; path: string }>; sel: number; token: number; timer: NodeJS.Timeout | null } | null = null;
  /** double-Esc fork-edit arming (T13): timestamp of the first bare Esc */
  private escAt = 0;
  private forkArmed = false;
  /** driver callbacks for the running-interaction trio (T9/T10) */
  private interruptFn: (() => void) | null = null;
  private injectFn: ((text: string) => void) | null = null;
  private forkEditFn: (() => void) | null = null;
  /** M5 B12: Ctrl+G hands the draft to an external editor ($EDITOR/notepad) */
  private externalEditFn: ((draft: string) => void) | null = null;
  /** M5 B14: remappable key bindings (config.json tui.keymap) */
  private keymap: Record<string, string> = { ...KEYMAP_DEFAULTS };
  /** last user-submitted line, for Esc-Esc edit-and-fork (T13) */
  private lastUserMsg = '';

  constructor() {
    // ?1l forces DECCKM OFF so arrow keys arrive as CSI (\x1b[A) even if a
    // previous program left the terminal in application cursor mode - in
    // that mode arrows arrive as SS3 (\x1bOA) and would be silently dropped.
    // ?1007 alternate scroll: the terminal translates the wheel to arrow
    // keys itself - no click capture, native selection stays native.
    // Bracketed paste (?2004h): multi-line pastes arrive delimited and
    // insert as one reviewable input instead of auto-submitting per line.
    stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1l\x1b[?1007h\x1b[?2004h');
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (d: string) => this.onKey(d));
    stdout.on('resize', () => { this.dirty = true; });
    this.renderTimer = setInterval(() => this.render(), 90);
    // The TUI owns the terminal while it runs (user-reported on host + every
    // VM): stray console output - MCP attach notices, library warnings,
    // provider retries - sprayed over the alternate screen and froze the
    // picture (nothing marked the frame dirty) until a keypress repainted.
    // Every console line now lands in the transcript instead, scrollable
    // like any other output; restored in destroy().
    this.installConsoleRedirection();
  }

  /** Route console.* and fatal-process dumps into the transcript. */
  private installConsoleRedirection(): void {
    const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 0) ?? String(x))).join(' ');
    const prev = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };
    this.restoreConsole = () => { console.log = prev.log; console.info = prev.info; console.warn = prev.warn; console.error = prev.error; console.debug = prev.debug; };
    console.log = (...a: unknown[]) => { this.addText(fmt(a).trim(), 'dim'); };
    console.info = (...a: unknown[]) => { this.addText(fmt(a).trim(), 'dim'); };
    console.debug = (...a: unknown[]) => { this.addText(fmt(a).trim(), 'dim'); };
    console.warn = (...a: unknown[]) => { this.addText(fmt(a), 'err'); };
    console.error = (...a: unknown[]) => { this.addText(fmt(a), 'err'); };
    // Node's default dump for these would tear up the alternate screen too
    this.fatalHandler = (err: unknown) => { this.addText('process: ' + String(err).slice(0, 500), 'err'); };
    process.on('unhandledRejection', this.fatalHandler);
    process.on('uncaughtException', this.fatalHandler);
    process.on('warning', this.fatalHandler);
  }

  setModelChoices(list: Array<{ name: string; desc: string }>): void {
    this.modelChoices = list;
    this.dirty = true;
  }

  /** Focus the /model picker (used by the bare `/model` command so the
   *  printed list is never a dead end - the live palette opens on it). */
  openModelPicker(): void {
    this.input = '/model ';
    this.caret = this.input.length;
    this.cmdIdx = 0;
    this.dirty = true;
  }

  /* ---------------- Codex-style resume picker modal ---------------- */

  /** While open the picker owns every key/wheel event and the whole frame -
   *  the codex alt-screen picker contract. resolve fires on Enter (resume)
   *  or Esc/Ctrl-C (close). */
  private resumeModal: {
    st: PickerState;
    resolve: (v: { kind: 'resume'; row: SessionSummary } | { kind: 'close' }) => void;
    /** monotonic token: stale page responses are dropped (codex request_token) */
    token: number;
  } | null = null;

  openResumePicker(): Promise<{ kind: 'resume'; row: SessionSummary } | { kind: 'close' } | null> {
    if (this.resumeModal) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.resumeModal = { st: initialPickerState('updated', true), resolve, token: 0 };
      this.dirty = true;
      void this.loadPickerPage(undefined, true);
    });
  }

  /** Fetch one listSessions page (reset=true restarts from page 1 after a
   *  toolbar change). Dedupes by id, drops stale responses by token. */
  private async loadPickerPage(cursor: string | undefined, reset: boolean): Promise<void> {
    const modal = this.resumeModal;
    if (!modal) return;
    const token = ++modal.token;
    const st0 = reset
      ? { ...modal.st, rows: [] as SessionSummary[], selected: 0, nextCursor: null, loading: true, initial: true }
      : { ...modal.st, loading: true };
    modal.st = st0;
    this.dirty = true;
    let page;
    try {
      page = await listSessions(homeDir(), {
        ...(reset ? {} : { cursor }),
        sort: st0.sort,
        cwd: st0.cwdOnly ? process.cwd() : null,
      });
    } catch {
      page = { items: [], nextCursor: null, numScanned: 0, reachedScanCap: false };
    }
    const live = this.resumeModal;
    if (!live || live.token !== token) return;
    const seen = new Set(reset ? [] : live.st.rows.map((r) => r.id));
    live.st = {
      ...live.st,
      rows: [...live.st.rows, ...page.items.filter((i) => !seen.has(i.id))],
      nextCursor: page.nextCursor,
      loading: false,
      initial: false,
    };
    this.dirty = true;
  }

  private pickerInput(key: string): void {
    const modal = this.resumeModal;
    if (!modal) return;
    const { state, effect } = reducePicker(modal.st, key);
    modal.st = state;
    this.dirty = true;
    if (effect.kind === 'accept') {
      this.resumeModal = null;
      modal.resolve({ kind: 'resume', row: effect.row });
    } else if (effect.kind === 'close') {
      this.resumeModal = null;
      modal.resolve({ kind: 'close' });
    } else if (effect.kind === 'reload') {
      void this.loadPickerPage(undefined, true);
    } else if ((effect.kind === 'load-more' || effect.kind === 'search-more') && !state.loading && state.nextCursor) {
      void this.loadPickerPage(state.nextCursor, false);
    }
  }

  /** Full-frame picker layout (codex draw_picker): title / search+toolbar /
   *  list window / two hint lines / position footer. */
  private renderResumePicker(frame: string[], W: number, H: number): void {
    const st = this.resumeModal!.st;
    const t = this.t;
    const count = ` ${st.rows.length}${st.loading ? '…' : ''} `;
    frame.push(truncateTo(BOLD(' ' + t.pickerTitle) + ' '.repeat(Math.max(1, W - strWidth(t.pickerTitle) - count.length - 1)) + DIM(count), W));
    frame.push(DIM('─'.repeat(W)));
    frame.push(' ' + toolbarLine(st, {
      filter: t.pickerLabelFilter, sort: t.pickerLabelSort, cwd: t.pickerValCwd, all: t.pickerValAll, updated: t.pickerValUpdated, created: t.pickerValCreated,
    }, W - 2, (s, on) => (on ? CYAN(BOLD(s)) : DIM(s))));
    frame.push(DIM('─'.repeat(W)));
    const vis = visibleRows(st);
    const listH = Math.max(3, H - 8);
    const from = vis.length > listH
      ? Math.min(Math.max(0, st.selected - Math.floor(listH / 2)), vis.length - listH)
      : 0;
    if (from > 0) frame.push(DIM('  ↑ more'));
    for (let i = 0; i < listH && from + i < vis.length; i++) {
      const sel = from + i === st.selected;
      const plain = truncateTo(formatRow(vis[from + i], sel, W - 1), W - 1);
      frame.push(sel ? '\x1b[7m' + plain + ' '.repeat(Math.max(0, W - 1 - strWidth(plain))) + '\x1b[27m' : ' ' + plain);
    }
    if (st.loading) frame.push(DIM('  ' + (vis.length === 0 ? t.pickerLoading : t.pickerMore)));
    else if (vis.length === 0) frame.push(DIM('  ' + (st.query ? t.pickerNoMatch : t.pickerEmpty)));
    else if (from + listH < vis.length) frame.push(DIM('  ↓ more'));
    frame.push(DIM('─'.repeat(W)));
    frame.push(DIM(truncateTo('  ' + t.pickerHint1, W - 1)));
    frame.push(DIM(truncateTo('  ' + t.pickerHint2, W - 1)));
    const pos = vis.length ? st.selected + 1 : 0;
    const posLine = t.pickerPos(pos, vis.length, vis.length ? String(Math.round((pos / vis.length) * 100)) : '0');
    frame.push(' '.repeat(Math.max(0, W - posLine.length - 1)) + DIM(posLine));
  }

  /** Ctrl+R history-search modal (B4): query line + matching entries,
   *  newest first; Enter adopts, Esc closes, ^P/^N or arrows move. */
  private renderHistSearch(frame: string[], W: number, H: number): void {
    const hs = this.histSearch!;
    const t = this.t;
    frame.push(truncateTo(BOLD(' ⌕ ' + t.histSearchTitle) + DIM(`  ${hs.matches.length}`), W));
    frame.push(DIM('─'.repeat(W)));
    frame.push(truncateTo(' ' + (hs.query || DIM(t.histSearchNone)), W - 1));
    frame.push(DIM('─'.repeat(W)));
    const listH = Math.max(3, H - 5);
    const vis = hs.matches;
    for (let i = 0; i < listH && i < vis.length; i++) {
      const sel = i === hs.sel;
      const line = this.history[vis[i]] ?? '';
      const plain = truncateTo((i + 1) + '. ' + line, W - 1);
      frame.push(sel ? '\x1b[7m' + plain + ' '.repeat(Math.max(0, W - 1 - strWidth(plain))) + '\x1b[27m' : ' ' + plain);
    }
    if (vis.length === 0) frame.push(DIM('  ' + t.histSearchNone));
    frame.push(DIM('─'.repeat(W)));
    frame.push(DIM(truncateTo('  ' + t.histSearchHint, W - 1)));
  }

  /** Ctrl+T full-transcript overlay (B5): title + scrollable lines; also the
   *  pager base for long outputs (B9). q/Esc closes, ↑↓/PgUp/PgDn/g/G scroll. */
  private renderOverlay(frame: string[], W: number, H: number): void {
    const ov = this.overlay!;
    const t = this.t;
    const listH = Math.max(5, H - 3);
    frame.push(truncateTo(BOLD(' ' + ov.title) + DIM(`  ${ov.lines.length}`), W));
    frame.push(DIM('─'.repeat(W)));
    if (ov.lines.length === 0) frame.push(DIM('  (empty)'));
    for (let i = 0; i < listH && ov.top + i < ov.lines.length; i++) {
      frame.push(truncateTo(ov.lines[ov.top + i] || ' ', W - 1));
    }
    frame.push(DIM('─'.repeat(W)));
    frame.push(DIM(truncateTo('  ' + t.overlayHint, W - 1)));
  }

  /** @-file palette (B2): ranked workspace hits for the trailing @token.
   *  Enter inserts the path; Esc closes; arrows move. */
  private renderAtPal(frame: string[], W: number, H: number): void {
    const pal = this.atPal!;
    const t = this.t;
    const title = BOLD(' @ ') + DIM('/' + pal.query + (pal.results.length ? ` · ${pal.results.length}` : ''));
    frame.push(truncateTo(title, W));
    frame.push(DIM('─'.repeat(W)));
    const listH = Math.min(8, Math.max(3, H - 6));
    if (pal.results.length === 0) {
      frame.push(DIM('  ' + t.histSearchNone));
    }
    for (let i = 0; i < listH && i < pal.results.length; i++) {
      const sel = i === pal.sel;
      const plain = truncateTo('  ' + pal.results[i].rel, W - 1);
      frame.push(sel ? '\x1b[7m' + plain + ' '.repeat(Math.max(0, W - 1 - strWidth(plain))) + '\x1b[27m' : plain);
    }
    frame.push(DIM('─'.repeat(W)));
    frame.push(DIM(truncateTo('  ' + t.atPalHint, W - 1)));
  }

  /** Run the highlighted palette row (shared by Enter and palette clicks);
   *  with no palette open it just submits the typed input. */
  private pickHighlighted(): void {
    const hits = this.panelItems(this.input);
    const pick = hits.length ? hits[Math.min(this.cmdIdx, hits.length - 1)].name : '';
    if (pick) {
      if (this.input.startsWith('/model')) this.input = `/model ${pick} `;
      else this.input = pick + ' ';
      this.caret = this.input.length;
      this.cmdIdx = 0;
    }
    this.driver?.();
  }

  /** Introspection probe for headless tests: input line, palette rows, the
   *  highlighted row index, mouse-reporting state, clickable rows, the
   *  transcript text, and the last rendered frame (ANSI-stripped). */
  paletteProbe(): {
    input: string;
    rows: string[];
    selected: number;
    mouse: boolean;
    clickRows: Array<{ row: number; idx: number }>;
    transcript: string;
    frameText: string;
  } {
    const rows = this.panelItems(this.input);
    const lines: string[] = [];
    for (const e of this.entries) lines.push(...e.lines);
    // replay one render into a capture so assertions see the real frame;
    // dirty was already cleared by a prior tick, so force it
    const f: string[] = [];
    const realWrite = stdout.write.bind(stdout);
    stdout.write = ((s: string) => { f.push(String(s)); return true; }) as typeof stdout.write;
    try { this.dirty = true; this.render(); } finally { stdout.write = realWrite; }
    return {
      input: this.input,
      rows: rows.map((r) => r.name),
      selected: rows.length ? Math.min(this.cmdIdx, rows.length - 1) : -1,
      mouse: this.mouseReported,
      clickRows: this.paletteClickRows.map((p) => ({ ...p })),
      transcript: lines.join('\n'),
      // frame rows: split on the CUP positioning pairs, take the content
      // halves by parity, strip ANSI. (A 'startsWith ESC' filter used to
      // discard every styled row - i.e. exactly the interesting ones.)
      frameText: (() => {
        const parts = f.join('').split(/(\x1b\[\d+;1H\x1b\[2K)/);
        const rows: string[] = [];
        for (let i = 0; i < parts.length; i += 2) {
          const row = stripAnsi(parts[i] ?? '').replace(/\x1b\[0J$/, '').trimEnd();
          if (row) rows.push(row);
        }
        return rows.join('\n');
      })(),
    };
  }

  setModeTag(tag: string): void {
    this.modeTag = tag;
    this.dirty = true;
  }

  /** Capture is on ONLY while a palette is open or /mouse forced it -
   *  native selection must stay native everywhere else; ?1007 covers
   *  the wheel without any capture (T23). */
  private syncMouseReporting(): void {
    const want = this.forceMouse || this.panelItems(this.input).length > 0;
    if (want === this.mouseReported) return;
    this.mouseReported = want;
    stdout.write(want ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
  }

  /** /mouse (T23): force full-time capture for terminals that honour
   *  neither wheel->arrow translation nor ?1007. While forced, Shift+drag
   *  is the mainstream-terminal escape hatch back to selection. */
  setMouseForced(on: boolean): void {
    this.forceMouse = on;
    this.syncMouseReporting();
    this.dirty = true;
  }

  isMouseForced(): boolean {
    return this.forceMouse;
  }

  /** The palette data source: `/model ` opens the model picker, otherwise
   *  slash commands. (/resume submits straight through to the driver, which
   *  opens the Codex-style full-frame picker - resume-picker.ts.) Rows are
   *  {name, desc} so both share one renderer, keyboard and click machinery. */
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

  configure(model: string, cwdName: string, skillCount: number, locale: Locale, version?: string): void {
    this.model = model;
    this.cwdName = cwdName;
    this.skillCount = skillCount;
    this.t = strings(locale);
    this.version = version ?? HMH_VERSION;
    this.dirty = true;
  }

  destroy(): void {
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    // ?1l restores default CSI cursor keys; reporting off whatever the
    // modal state was
    stdout.write((this.mouseReported ? '\x1b[?1000l\x1b[?1006l' : '') + '\x1b[?2004l\x1b[?1007l' + '\x1b[?1l\x1b[?25h\x1b[?1049l');
    this.restoreConsole?.();
    if (this.fatalHandler) {
      process.off('unhandledRejection', this.fatalHandler);
      process.off('uncaughtException', this.fatalHandler);
      process.off('warning', this.fatalHandler);
    }
    stdin.setRawMode?.(false);
    stdin.pause();
  }

  waitExit(): Promise<void> {
    return new Promise((resolve) => { this.exitResolve = resolve; });
  }

  private quit(): void {
    this.running = false;
    // an open picker never resolves on its own once the TUI exits
    if (this.resumeModal) {
      const resolve = this.resumeModal.resolve;
      this.resumeModal = null;
      resolve({ kind: 'close' });
    }
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

  /** The user's own input, chat-style: separated by a blank line above and
   *  below, right-aligned to the terminal width so it reads as "the human
   *  side" against left-aligned model output. */
  addUser(text: string): void {
    const width = Math.max(20, (stdout.columns || 100) - 2);
    const lines: string[] = [''];
    const wrapped = wrapTo(text.replace(/\n+/g, ' '), width);
    // long prompts fold to two lines + a count marker (UX requirement 2026-09-21:
    // a pasted prompt used to eat half the screen); the driver archives the
    // full text into the Ctrl+T replay so nothing is lost
    const shown = wrapped.length > 2 ? wrapped.slice(0, 2) : wrapped;
    for (const l of shown) {
      const pad = Math.max(1, width - strWidth(l));
      lines.push(' '.repeat(pad) + BOLD(l));
    }
    if (wrapped.length > 2) {
      const note = this.t.tuiUserFolded(wrapped.length - 2);
      const pad = Math.max(1, width - strWidth(note));
      lines.push(' '.repeat(pad) + DIM(note));
    }
    lines.push('');
    this.entries.push({ lines });
    this.scrollFromBottom = 0;
    this.dirty = true;
  }

  startStream(kind: 'think' | 'say'): ((chunk: string) => void) & { drop: () => void } {
    const width = Math.max(20, (stdout.columns || 100) - 2);
    const lines: string[] = [];
    let buf = kind === 'think' ? '∴ ' : '';
    const entry: Entry = { lines };
    const repaint = () => {
      if (kind === 'say') {
        const wrapped = wrapTo(buf, width);
        lines.length = 0;
        // B10: completed lines get markdown color ONCE; the in-progress tail
        // stays raw until it wraps — stable rows never reflow
        const lastIdx = wrapped.length - 1;
        for (let i = 0; i < lastIdx; i++) lines.push(TuiRuntime.mdColor(wrapped[i]));
        if (wrapped.length) {
          const last = wrapped[lastIdx];
          lines.push(buf.endsWith('\n') ? TuiRuntime.mdColor(last) : last);
        }
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
    const append = (chunk: string) => {
      buf += chunk;
      repaint();
    };
    // a provider retry restarts the response: remove THIS block so the
    // regenerated text does not appear as a second copy of a half answer
    append.drop = () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
      this.dirty = true;
    };
    return append;
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

  setQueued(n: number): void {
    this.queued = Math.max(0, n);
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

  setInput(text: string): void {
    this.input = text;
    this.caret = text.length;
    this.cmdIdx = 0;
    this.dirty = true;
  }

  setLastUserText(s: string): void {
    this.lastUserMsg = s;
  }

  /** Last user-submitted line (Esc-Esc edit-and-fork source, T13). */
  getLastUserText(): string {
    return this.lastUserMsg;
  }

  onSubmit(fn: () => void): void {
    this.driver = fn;
  }

  /* ---------------- M2 runtime steering API (driver wiring) ---------------- */

  onInterrupt(fn: () => void): void { this.interruptFn = fn; }
  onInject(fn: (text: string) => void): void { this.injectFn = fn; }
  onForkEdit(fn: () => void): void { this.forkEditFn = fn; }
  onExternalEdit(fn: (draft: string) => void): void { this.externalEditFn = fn; }

  /** M5 B14: apply remapped keys (config.json tui.keymap); unknown actions
   *  are ignored so a stale config degrades to defaults, never breaks keys */
  setKeymap(map: Record<string, string>): void {
    this.keymap = { ...KEYMAP_DEFAULTS, ...map };
  }

  /** Close any open modal (Esc priority: panels close before anything else,
   *  T7/T9 order). Returns true when something was open. */
  private closeModal(): boolean {
    if (this.histSearch) { this.histSearch = null; this.dirty = true; return true; }
    if (this.overlay) { this.overlay = null; this.dirty = true; return true; }
    if (this.atPal) { this.atPal = null; this.dirty = true; return true; }
    return false;
  }

  /** Ctrl+R: incremental history search modal (B4). Enter adopts the match
   *  into the input; Esc closes; ^P/^N or arrows move. */
  private openHistSearch(): void {
    if (!this.history.length) return;
    this.histSearch = { query: '', matches: histMatches(this.history, ''), sel: 0 };
    this.dirty = true;
  }
  private histKey(data: string): void {
    const hs = this.histSearch;
    if (!hs) return;
    if (data === '\x1b') { this.histSearch = null; this.dirty = true; return; }
    if (data === '\r') {
      const line = this.history[hs.matches[hs.sel]];
      if (line !== undefined) { this.histSearch = null; this.setInput(line); }
      return;
    }
    if (data === '\x1b[A' || data === '\x10') { hs.sel = Math.max(0, hs.sel - 1); this.dirty = true; return; }
    if (data === '\x1b[B' || data === '\x0e') { hs.sel = Math.min(hs.matches.length - 1, hs.sel + 1); this.dirty = true; return; }
    if (data === '\x7f' || data === '\b') { hs.query = hs.query.slice(0, -1); hs.matches = histMatches(this.history, hs.query); hs.sel = 0; this.dirty = true; return; }
    if (data.length === 1 && data >= ' ') { hs.query += data; hs.matches = histMatches(this.history, hs.query); hs.sel = 0; this.dirty = true; }
  }

  /** Ctrl+T: full-transcript overlay (B5), also the pager base for long
   *  outputs (B9). ↑↓/PgUp/PgDn/g/G scroll, Esc/q closes. */
  private overlaySource: () => string[] = () => [];
  setOverlaySource(fn: () => string[]): void { this.overlaySource = fn; }
  private openOverlay(title: string, lines: string[]): void {
    const H = Math.max(5, (stdout.rows || 30) - 2);
    this.overlay = { title, lines, top: Math.max(0, lines.length - H) };
    this.dirty = true;
  }

  /** Public pager/overlay entry (M4 /diff, B9 auto-pager). */
  showOverlay(title: string, lines: string[]): void {
    this.openOverlay(title, lines);
  }

  /* ---------------- M4: tool-result cells (B8) ---------------- */
  private toolCells: Array<{ entry: Entry; full: string; folded: string; expanded: boolean }> = [];

  /** Tool call + result as a collapsible cell: one folded summary line by
   *  default (W1/T5 spirit); the `z` key (idle + empty input) expands the
   *  LAST cell to its full output. */
  addToolCell(folded: string, full: string): void {
    const width = Math.max(20, (stdout.columns || 100) - 2);
    const entry: Entry = { lines: wrapTo(folded, width).map((l) => DIM(l)) };
    this.entries.push(entry);
    this.toolCells.push({ entry, full, folded, expanded: false });
    this.scrollFromBottom = 0;
    this.dirty = true;
  }
  toggleLastCell(): boolean {
    const cell = this.toolCells[this.toolCells.length - 1];
    if (!cell) return false;
    const width = Math.max(20, (stdout.columns || 100) - 2);
    cell.expanded = !cell.expanded;
    cell.entry.lines = cell.expanded
      ? [...wrapTo(cell.folded, width).map((l) => DIM(l)), ...wrapTo(cell.full, width)]
      : wrapTo(cell.folded, width).map((l) => DIM(l));
    this.dirty = true;
    return true;
  }

  /* ---------------- M4: streaming markdown colorizer (B10) ---------------- */
  /** Light zero-dep markdown line color for STREAMED text: headings cyan,
   *  list markers dim, fences dim, blockquotes dim; everything else plain.
   *  Applied per completed line so already-stable rows never reflow. */
  static mdColor(line: string): string {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t)) return CYAN(BOLD(line));
    if (/^```/.test(t)) return DIM(line);
    if (/^>\s?/.test(t)) return DIM(line);
    if (/^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t)) return DIM(line.replace(/^(\s*[-*+]\s|\s*\d+[.)]\s)/, '$1'));
    return line;
  }
  private overlayKey(data: string): void {
    const ov = this.overlay;
    if (!ov) return;
    const H = Math.max(5, (stdout.rows || 30) - 2);
    const maxTop = Math.max(0, ov.lines.length - H);
    if (data === '\x1b' || data === '\x03' || data === 'q' || data === 'Q') { this.overlay = null; this.dirty = true; return; }
    if (data === '\x1b[A' || data === '\x1b[5~' || data === 'k') { ov.top = Math.max(0, ov.top - 1); this.dirty = true; return; }
    if (data === '\x1b[B' || data === '\x1b[6~' || data === 'j') { ov.top = Math.min(maxTop, ov.top + 1); this.dirty = true; return; }
    if (data === '\x1b[H' || data === 'g') { ov.top = 0; this.dirty = true; return; }
    if (data === '\x1b[F' || data === 'G') { ov.top = maxTop; this.dirty = true; return; }
  }

  /** @-file palette (B2): opens/refreshes from the input's trailing @token. */
  private refreshAtPal(): void {
    const token = atToken(this.input);
    if (token === null) { if (this.atPal) { this.atPal = null; this.dirty = true; } return; }
    if (!this.atPal) this.atPal = { query: token, results: [], sel: 0, token: 0, timer: null };
    this.atPal.query = token;
    if (this.atPal.timer) clearTimeout(this.atPal.timer);
    const tk = ++this.atPal.token;
    this.atPal.timer = setTimeout(() => void this.runAtSearch(tk), 120);
  }
  private async runAtSearch(tk: number): Promise<void> {
    const pal = this.atPal;
    if (!pal || pal.token !== tk) return;
    try {
      const { fuzzyScore, SKIP_DIRS, MAX_SEARCH_DEPTH, MAX_SEARCH_ENTRIES, MAX_SEARCH_RESULTS } = await import('@hmharness/web');
      const { readdir } = await import('node:fs/promises');
      const { join: j } = await import('node:path');
      const q = pal.query;
      const root = process.cwd();
      const hits: Array<{ rel: string; path: string; score: number }> = [];
      let visited = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_ENTRIES) return;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (visited >= MAX_SEARCH_ENTRIES) return;
          visited++;
          if (e.isSymbolicLink()) continue;
          const abs = j(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            await walk(abs, depth + 1);
            continue;
          }
          if (!e.isFile()) continue;
          const rel = abs.slice(root.length + 1).replace(/\\/g, '/');
          const score = fuzzyScore(q, rel);
          if (score >= 0) hits.push({ rel, path: abs, score });
        }
      };
      await walk(root, 0);
      hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
      if (!this.atPal || this.atPal.token !== tk) return;
      this.atPal.results = hits.slice(0, MAX_SEARCH_RESULTS).map(({ rel, path }) => ({ rel, path }));
      this.atPal.sel = 0;
      this.dirty = true;
    } catch { /* search is best-effort; the palette just shows nothing */ }
  }
  private atPalKey(data: string): void {
    const pal = this.atPal;
    if (!pal) return;
    if (data === '\x1b') { this.atPal = null; this.dirty = true; return; }
    if (data === '\r') {
      const pick = pal.results[pal.sel];
      if (pick) {
        this.input = this.input.replace(/@[\w./\\-]*$/, '@' + pick.rel);
        this.caret = this.input.length;
      }
      this.atPal = null;
      this.dirty = true;
      return;
    }
    if (data === '\x1b[A') { pal.sel = Math.max(0, pal.sel - 1); this.dirty = true; return; }
    if (data === '\x1b[B') { pal.sel = Math.min(pal.results.length - 1, pal.sel + 1); this.dirty = true; return; }
    // printable/backspace edits the input line itself; the palette re-filters
    if (data === '\x7f' || data === '\b') {
      if (this.caret > 0) { this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret); this.caret--; }
      this.refreshAtPal();
      return;
    }
    if (data.length === 1 && data >= ' ') {
      this.input = this.input.slice(0, this.caret) + data + this.input.slice(this.caret);
      this.caret += data.length;
      this.refreshAtPal();
      return;
    }
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
    // reassemble an SGR mouse report that arrived split across stdin chunks
    // (fast wheel bursts fragment in some terminals) before anything parses
    if (this.mousePending) {
      data = this.mousePending + data;
      this.mousePending = '';
    }
    const split = splitMouseReport(data);
    if (split.pending) this.mousePending = split.pending;
    if (!split.data) return;
    data = split.data;
    // bracketed paste (T22): buffer until the 201~ end marker, then insert
    // the sanitized body at the caret; keys/bytes outside the markers keep
    // flowing through the normal path (recursion depth stays 1: indexOf
    // anchors on the FIRST 200~ so the outer chunk cannot contain another)
    if (this.pasteBuf !== null) {
      this.pasteBuf += data;
      const end = this.pasteBuf.indexOf('\x1b[201~');
      if (end !== -1) {
        const done = this.pasteBuf;
        this.pasteBuf = null;
        this.insertText(sanitizePaste(done));
        const after = done.slice(end + 6);
        if (after) this.onKey(after);
      } else if (this.pasteBuf.length > 1048576) {
        this.pasteBuf = null; // runaway paste: drop, never balloon the input
      }
      return;
    }
    const ps = data.indexOf('\x1b[200~');
    if (ps !== -1) {
      const before = data.slice(0, ps);
      if (before) this.onKey(before);
      this.pasteBuf = data.slice(ps + 6);
      const end = this.pasteBuf.indexOf('\x1b[201~');
      if (end !== -1) {
        const done = this.pasteBuf;
        this.pasteBuf = null;
        this.insertText(sanitizePaste(done));
        const after = done.slice(end + 6);
        if (after) this.onKey(after);
      }
      return;
    }
    // SS3 application-mode arrows (\x1bOA…H): terminals left in DECCKM by a
    // previous program send these; normalize to the CSI forms this UI
    // matches so navigation never silently dies
    if (/^\x1bO[A-H]$/.test(data)) data = '\x1b[' + data[2];
    // resume picker modal owns every event while open - keyboard AND wheel
    // (codex: the picker runs its own event loop until it resolves)
    if (this.resumeModal) {
      const wheel = parseWheel(data);
      const key = wheel !== 0 ? (wheel < 0 ? 'up' : 'down') : pickerKey(data);
      if (key !== null) this.pickerInput(key);
      return;
    }
    // M2 modals own the keys while open (history search, transcript overlay,
    // @-file palette) — each closes on its own Esc
    if (this.histSearch) { this.histKey(data); return; }
    if (this.overlay) { this.overlayKey(data); return; }
    if (this.atPal) { this.atPalKey(data); return; }
    // wheel-only mouse routing: 64 = wheel-up, 65 = wheel-down. Reporting
    // is always on, so every other report - click, drag, release - is just
    // swallowed below; the terminal's Shift+click native selection bypasses
    // the app entirely and keeps working.
    const wheel = parseWheel(data);
    if (wheel !== 0) {
      // an open palette takes the wheel: it moves the selection (the list
      // is what the user is driving), the transcript only scrolls when the
      // palette is closed
      const hits = this.panelItems(this.input);
      if (hits.length) {
        this.cmdIdx = Math.max(0, Math.min(hits.length - 1, this.cmdIdx + wheel));
        this.dirty = true;
        return;
      }
      // wheel-up (-1) moves the viewport UP, i.e. further from the bottom
      this.scrollFromBottom = Math.max(0, Math.min(this.totalLines(), this.scrollFromBottom - wheel * 3));
      this.dirty = true;
      return;
    }
    // click-to-choose on the open palette (SGR button-0 press): the
    // terminal-reported row maps 1:1 to the screen row render() recorded
    // for that item, so a click is a row selection + confirm
    if (this.paletteClickRows.length) {
      const click = data.match(/^\x1b\[<0;\d+;(\d+)M$/);
      if (click) {
        const row = Number(click[1]);
        const hitRow = this.paletteClickRows.find((p) => p.row === row);
        if (hitRow) {
          this.cmdIdx = hitRow.idx;
          this.pickHighlighted();
          return;
        }
      }
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
    // Ctrl+Enter = inject into the RUNNING task (T10; terminals send it as
    // '\n' in raw mode; consistent with web W7 Ctrl+Enter). Idle it behaves
    // exactly like Enter (submit). Key is remappable (B14).
    if (data === this.keymap.inject) {
      if (this.busy && this.input.trim()) {
        const text = this.input;
        this.input = ''; this.caret = 0; this.cmdIdx = 0;
        this.dirty = true;
        this.injectFn?.(text);
      } else {
        this.pickHighlighted();
      }
      return;
    }
    // Ctrl+G = external editor for the draft (B12); key remappable (B14)
    if (data === this.keymap.externalEdit && !this.busy) {
      this.externalEditFn?.(this.input);
      return;
    }
    // Ctrl+R = incremental history search (B4); key remappable (B14)
    if (data === this.keymap.historySearch) { this.openHistSearch(); return; }
    // Ctrl+T = full-transcript overlay (B5): every transcript line PLUS the
    // full (folded-away) tool outputs, via the driver-registered source;
    // key remappable (B14)
    if (data === this.keymap.transcript) {
      const lines: string[] = [];
      for (const e of this.entries) lines.push(...e.lines.map(stripAnsi));
      const extra = this.overlaySource();
      this.openOverlay(this.t.tuiTranscript, [...lines, ...extra]);
      return;
    }
    // remapped interrupt key (B14): a non-Esc binding still stops the turn
    if (data === this.keymap.interrupt && this.keymap.interrupt !== '\x1b' && this.busy) {
      this.interruptFn?.();
      return;
    }
    if (data === '\x1b') {
      // Exact Esc only (arrow sequences arrive as '\x1b[A' and never match).
      // T9 order: an open modal closes FIRST; else running -> interrupt the
      // current task; else a non-empty draft is cleared (T7); else (idle +
      // empty) a second Esc within 800ms arms edit-and-fork (T13).
      if (this.closeModal()) return;
      if (this.busy && this.keymap.interrupt === '\x1b') { this.interruptFn?.(); return; }
      if (this.input) { this.input = ''; this.caret = 0; this.cmdIdx = 0; this.dirty = true; return; }
      const now = Date.now();
      if (forkArm(this.escAt, now, this.forkArmed)) {
        this.forkArmed = false; this.escAt = 0;
        if (this.lastUserMsg) this.forkEditFn?.();
      } else {
        this.forkArmed = true; this.escAt = now;
        this.status = this.t.forkArmed;
        this.dirty = true;
      }
      return;
    }
    if (data === '\r') {
      // bare '/model' + Enter OPENS the picker instead of running row 0 -
      // Claude Code's two-stage flow: Enter shows the dialog, arrows/wheel
      // move, a second Enter confirms the highlighted row. The old behavior
      // silently switched to the first model on the very first Enter.
      // (/resume needs no interception: submitting it opens the Codex-style
      // modal via the driver, and '/resume <prefix>' loads directly.)
      if (this.input === '/model') {
        this.openModelPicker();
        return;
      }
      // palette open: Enter runs the highlighted row (a command, or a
      // /model target), not the raw input; without a palette it submits
      this.pickHighlighted();
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
    if (data === '\x0c') { this.dirty = true; return; }
    // M4 B8: `z` with an empty input expands/collapses the LAST tool cell
    // (folded summary <-> full output); with a draft it is just typing
    if (data === 'z' && !this.busy && !this.input) {
      if (this.toggleLastCell()) return;
    }
    if (data.startsWith('\x1b') || data < ' ') return;

    // printable text (CJK / IME preedit arrives as normal chunks)
    this.input = this.input.slice(0, this.caret) + data + this.input.slice(this.caret);
    this.caret += data.length;
    this.cmdIdx = 0;
    this.dirty = true;
    // '@' opens the file palette (B2); refreshAtPal() is a no-op otherwise
    this.refreshAtPal();
  }

  /** insert literal (sanitized paste) text at the caret - the same path
   *  printable typing takes, so caret/history/palette side-effects match */
  private insertText(text: string): void {
    if (!text) return;
    this.input = this.input.slice(0, this.caret) + text + this.input.slice(this.caret);
    this.caret += text.length;
    this.cmdIdx = 0;
    this.dirty = true;
    this.refreshAtPal();
  }

  /* ---------------- rendering ---------------- */

  render(): void {
    if (!this.running || !this.dirty) return;
    this.dirty = false;
    const W = stdout.columns || 100;
    const H = stdout.rows || 30;
    const frame: string[] = [];
    if (this.resumeModal) {
      this.renderResumePicker(frame, W, H);
      this.flushFrame(frame, H);
      return;
    }
    if (this.histSearch) {
      this.renderHistSearch(frame, W, H);
      this.flushFrame(frame, H);
      return;
    }
    if (this.overlay) {
      this.renderOverlay(frame, W, H);
      this.flushFrame(frame, H);
      return;
    }
    if (this.atPal) {
      this.renderAtPal(frame, W, H);
      this.flushFrame(frame, H);
      return;
    }
    // capture follows palette/force state (see syncMouseReporting, T23);
    // click rows are re-recorded every frame because screen positions move
    this.syncMouseReporting();
    this.paletteClickRows.length = 0;

    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.spinnerFrame] ?? ' ';
    // Header = pure identity strip: logo · model · cwd · skills (+ mode tag
    // when set). NO status word up here at all (T1-v2, design-revised: the
    // run indicator moved to the input-box status line in 0df4ba7 but the
    // old right slot kept showing a stale "idle" - an orphan status.
    // Moving a thing means deleting it from where it was).
    // The ONLY live run indicator is the status line above the input box.
    const headLeft = ` ${BOLD('⚙ hmh')}${this.version ? ` ${DIM('v' + this.version)}` : ''} ${DIM('·')} ${CYAN(this.model)} ${DIM('·')} ${this.cwdName} ${DIM('·')} ${this.skillCount} ${this.t.tuiSkills}` + (this.modeTag ? ` ${this.modeTag}` : '');
    frame.push(truncateTo(headLeft, W));
    frame.push(DIM('─'.repeat(W)));

    const allLines: string[] = [];
    for (const e of this.entries) allLines.push(...e.lines);
    const cmdHits = this.panelItems(this.input);
    // +1: the palette's dim key-hint footer row shares the layout budget
    const cmdRows = cmdHits.length ? Math.min(cmdHits.length, 6) + 1 : 0;
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
    const statusRows = this.busy ? 1 : 0;
    const viewH = Math.max(3, H - 4 - inputRows - approvalRows - cmdRows - statusRows);
    const start = Math.max(0, allLines.length - viewH - this.scrollFromBottom);
    const view = allLines.slice(start, start + viewH);
    for (let i = 0; i < viewH; i++) frame.push(i < view.length ? truncateTo(view[i], W) : '');

    if (this.approval) {
      const argsTxt = JSON.stringify(this.approval.args);
      frame.push(YELLOW(this.t.tuiApproval) + ' ' + YELLOW(BOLD(this.approval.name)) + ' ' + DIM(truncateTo(argsTxt, Math.max(0, W - 24))));
      frame.push(`  [y] ${GREEN(this.t.tuiApprove)}   [n] ${RED(this.t.tuiDeny)}   ${DIM(this.t.tuiApprovalHint)}`);
      frame.push(DIM('─'.repeat(W)));
    }

    // busy status line right above the input box (same position as the web
    // UI): spinning glyph + running text, hidden when idle. Claude Code logic.
    if (this.busy) {
      frame.push(YELLOW(`${spin} ${this.t.tuiRunning}${this.status && this.status !== this.t.tuiRunning ? ' · ' + DIM(this.status) : ''}`));
    }

    // palette (slash commands or the /model picker): shows while the input
    // starts with '/'; arrows move the selection (scrolling 6-row window),
    // Enter/Tab run/complete the highlighted row; the last palette line is
    // a dim key hint so the picker is discoverable without reading docs
    if (cmdRows) {
      const dataRows = Math.min(cmdHits.length, 6);
      const from = Math.max(0, Math.min(this.cmdIdx - 5, cmdHits.length - dataRows));
      for (let i = 0; i < dataRows; i++) {
        const gi = from + i;
        const c = cmdHits[gi];
        const sel = gi === this.cmdIdx;
        frame.push(truncateTo((sel ? '› ' : '  ') + (sel ? CYAN(c.name) : DIM(c.name)) + '  ' + DIM(truncateTo(c.desc, 46)), W - 1));
        // row lands at screen line frame.length (render addresses rows
        // 1-based); only rows that survive the H clip are clickable
        if (frame.length <= H) this.paletteClickRows.push({ row: frame.length, idx: gi });
      }
      frame.push(DIM(truncateTo('  ' + this.t.panelHint, W - 1)));
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

    const hints = this.busy
      ? `${DIM(this.t.tuiBusyHints(this.queued))}`
      : this.scrollFromBottom > 0
        ? `${DIM(this.t.tuiScrolled)}`
        : `${DIM(this.t.tuiHints)}`;
    const stat = this.status && !this.busy ? DIM(this.status) : '';
    frame.push(truncateTo(hints + ' '.repeat(Math.max(1, W - strWidth(stripAnsi(hints)) - strWidth(stat))) + stat, W - 1));

    // Absolute per-row addressing: CUP resets the column and cancels the
    // pending wrap a full-width line leaves behind — "\x1b[B" joins would skip
    // a row on immediate-wrap terminals (conhost) and push the frame past the
    // last line, scrolling the header away and clipping the input box.
    this.flushFrame(frame, H);
  }

  private flushFrame(frame: string[], H: number): void {
    const visible = frame.slice(0, H);
    let out = '';
    for (let i = 0; i < visible.length; i++) out += `\x1b[${i + 1};1H\x1b[2K${visible[i]}`;
    stdout.write(out + '\x1b[0J');
  }
}

/* ---------------- driver ---------------- */

export async function tui(yes: boolean, noWeb = false, opts: { resumeAtStart?: boolean } = {}): Promise<void> {
  let cfg = await loadConfig();
  let autoApprove = yes || cfg.approval === 'auto';
  if (!stdin.isTTY) {
    stdout.write(strings((cfg.locale ?? 'zh') as Locale).tuiNeedsTty + '\n');
    process.exitCode = 1;
    return;
  }
  const home = homeDir();
  let t = strings((cfg.locale ?? 'zh') as Locale);
  const { reg, clients } = await buildRegistry({ announce: false });
  // auto-link: bring the web UI up in the background (hmh tui --no-web skips)
  const webUp = noWeb ? false : await ensureWebDaemon(DEFAULT_WEB_PORT);
  const rt = new TuiRuntime();
  const skills = await listSkills(home);
  const chatModel = resolveProvider(cfg, 'chat').model;
  rt.configure(chatModel, basename(process.cwd()), skills.length, (cfg.locale ?? 'zh') as Locale, HMH_VERSION);
  rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
  if (autoApprove) rt.setModeTag('🔥');
  rt.addText(t.tuiWelcome(chatModel), 'dim');
  if (webUp) rt.addText(t.tuiWebLinked(DEFAULT_WEB_PORT), 'dim');
  // update reminder: cached (1/day) registry check, resolved async into the
  // transcript via addText (frame-safe); offline stays silent
  {
    // 2026-09-21 product direction: updates are ZERO-ACTION - a newer version
    // installs itself in the background (detached npm, next launch picks it
    // up; never swaps files under the running process) and we only SAY so.
    // Opt out with config.json tui.autoUpdate=false (falls back to the hint).
    const { notifyUpdate, autoUpdate } = await import('./update-check.ts');
    const { createRequire } = await import('node:module');
    const current = createRequire(import.meta.url)('../package.json').version as string;
    if ((cfg as { tui?: { autoUpdate?: boolean } }).tui?.autoUpdate === false) {
      void notifyUpdate(home, current, (latest) => rt.addText(`↑ ${t.updateHint(latest)}`, 'dim'));
    } else {
      void autoUpdate({
        home,
        current,
        say: (latest) => rt.addText(t.tuiAutoUpdating(latest), 'dim'),
        sayFail: (why) => rt.addText(t.tuiAutoUpdateFailed(why), 'dim'),
      });
    }
  }

  let history: ChatMessage[] = [];
  // Codex thread semantics: one rollout file per conversation. The first task
  // creates it; every later turn (and everything after /resume) appends to it.
  let currentSessionId: string | undefined;
  // `hmh resume` startup: the picker comes up before the first prompt (codex
  // `codex resume` behavior); Esc leaves a fresh conversation
  if (opts.resumeAtStart) {
    const pick = await rt.openResumePicker();
    if (pick?.kind === 'resume') await resumeInto(pick.row.file);
  }
  // Task queue: new submissions during a running task are queued (not
  // rejected, not run concurrently — sequential execution preserves history
  // integrity). Slash commands still run immediately (they're quick).
  // M2 running-interaction trio (T9/T10, codex parity):
  //   Enter (text)   = queue for the NEXT turn
  //   Ctrl+Enter     = INJECT into the running turn (web W7-consistent)
  //   Esc (running)  = interrupt the current turn (was: empty Enter = stop —
  //                     reversed by 复案 2026-09-17, see DESIGNS.md)
  const taskQueue: string[] = [];
  let taskRunning = false;
  let currentAbort: AbortController | null = null;
  /** live steering channel: Ctrl+Enter pushes here; runAgentTask drains it
   *  into the running loop (InjectChannel shape) */
  let currentInject: { queue: string[]; active: boolean } | null = null;
  /** full tool outputs retained for the Ctrl+T transcript overlay (B5) —
   *  the transcript itself folds them to one line (W1/T5 spirit) */
  const fullToolLog: Array<{ name: string; output: string }> = [];
  /** set by Esc-Esc edit-and-fork (T13): the next submission forks a new
   *  session from the edited message (kernel forkFrom provenance) */
  let pendingFork = false;
  /** /fork (M4 B7): fork with the FULL history as resume (no edit point) */
  let forkAll = false;
  /** /plan (M4 B7): the next task gets a plan-first system directive */
  let planMode = false;
  /** /copy source: the last completed assistant text */
  let lastAiText = '';

  async function runShellBang(cmd: string): Promise<void> {
    // B3: `! command` runs the local shell through the SAME gate as the
    // agent's run_command tool — DENY_PATTERNS hard-refuse destructive
    // one-liners inside the tool; the TUI approval dialog stands in for the
    // loop's ask() (never a bypass; hard constraint #5).
    rt.addUser('!' + cmd);
    const tool = reg.get('run_command');
    if (!tool) { rt.addText('run_command tool missing', 'err'); return; }
    const args = { command: cmd };
    // the tool's own gate decides (DENY_PATTERNS + shellgate live INSIDE
    // run_command.execute); the TUI dialog stands in for the loop's ask(),
    // except in YOLO/auto mode where approval is pre-granted
    if (tool.needsApproval?.(args, { cwd: process.cwd(), home }) && !autoApprove) {
      const ok = await rt.requestApproval('run_command', args);
      if (!ok) { rt.addText(DIM('denied')); return; }
    }
    const r = await tool.execute(args, { cwd: process.cwd(), home });
    const first = String(r.output).split('\n').find((l) => l.trim()) ?? '';
    rt.addText(`  ${r.isError ? RED('✗') : GREEN('•')} ${DIM('⎿ ' + first.trim().slice(0, 120))}`, r.isError ? 'err' : 'dim');
    const rest = String(r.output).split('\n').slice(1).join('\n').trim();
    if (rest) rt.addText(rest.slice(0, 2000), 'dim');
    fullToolLog.push({ name: 'shell', output: String(r.output).slice(0, 4000) });
  }

  rt.onSubmit(() => {
    const line = rt.consumeInput().trim();
    if (!line) {
      // 复案 (T10): empty Enter no longer stops the running task. Stopping
      // is now an explicit Esc (T9). An empty Enter while running is a nudge.
      if (taskRunning) rt.addText(DIM('(empty — Esc stops · type + Enter queues · Ctrl+Enter injects)'));
      return;
    }
    if (line.startsWith('/')) {
      void handleLine(line);
      return;
    }
    if (shellBang(line) !== null) {
      void runShellBang(shellBang(line)!);
      return;
    }
    rt.setLastUserText(line);
    if (taskRunning) {
      taskQueue.push(line);
      rt.setQueued(taskQueue.length);
      rt.addText(`📋 queued: "${line.slice(0, 60)}${line.length > 60 ? '…' : ''}" (${taskQueue.length} waiting)`, 'dim');
      return;
    }
    // Esc-Esc fork (T13): the new thread inherits everything BEFORE the last
    // user message (the edited line replaces it) and records the parent
    // session id in its rollout meta (kernel forkFrom). /fork (M4 B7): the
    // FULL history is the resume (no edit point).
    const forkFrom = pendingFork ? currentSessionId : undefined;
    const forkResume = pendingFork
      ? (forkAll ? history : history.slice(0, lastUserIdx(history)))
      : undefined;
    pendingFork = false;
    forkAll = false;
    void executeTaskQueue(line, forkFrom, forkResume);
  });
  rt.onInterrupt(() => {
    // T9: Esc while running interrupts the current turn. In-flight tool calls
    // finish first; queued tasks still run (clear with /queue clear).
    if (taskRunning && currentAbort) {
      currentAbort.abort();
      rt.addText('⏹ interrupting current task (in-flight tool calls finish first; queued tasks still run)', 'dim');
    }
  });
  rt.onInject((text) => {
    // T10: Ctrl+Enter injects into the RUNNING task (no-op when idle — the
    // key submits normally in that case)
    if (currentInject?.active) {
      currentInject.queue.push(text);
      rt.addText(`⤷ injected into running task: "${text.slice(0, 80)}"`, 'dim');
    }
  });
  rt.onForkEdit(() => {
    // T13: Esc Esc (idle + empty) loads the last user message for editing;
    // the next submit forks a new session from it
    const last = rt.getLastUserText();
    if (last) {
      pendingFork = true;
      rt.setInput(last);
      rt.addText(DIM('✂ edit and fork — Enter sends as a NEW session from this message'), 'dim');
    }
  });
  // B12: Ctrl+G hands the draft to an external editor ($EDITOR, notepad on
  // Windows); the edited text comes back into the input box
  rt.onExternalEdit(async (draft) => {
    try {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { join: j } = await import('node:path');
      const dir = j(home, 'tmp');
      await mkdir(dir, { recursive: true });
      const file = j(dir, `draft-${Date.now()}.txt`);
      await writeFile(file, draft, 'utf8');
      const { spawn } = await import('node:child_process');
      const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      await new Promise<void>((resolve) => {
        const child = spawn(editor, process.platform === 'win32' ? [file] : [file], { windowsHide: false, stdio: 'inherit' });
        child.on('close', () => resolve());
      });
      const edited = await readFile(file, 'utf8');
      rt.setInput(edited);
      rt.addText(DIM(`✎ external editor (${editor}) → draft loaded (${edited.length} chars)`), 'dim');
    } catch (err) {
      rt.addText(String(err), 'err');
    }
  });
  // B14: remapped keys from config.json tui.keymap (applied at startup)
  {
    const km = (cfg as { tui?: { keymap?: Record<string, string> } }).tui?.keymap;
    if (km && typeof km === 'object') rt.setKeymap(km);
  }
  // B11: customizable idle statusline from config.json tui.statusline
  const applyStatusline = () => {
    const tpl = (cfg as { tui?: { statusline?: string } }).tui?.statusline ?? '';
    if (tpl) {
      rt.setStatus(renderStatusline(tpl, {
        model: chatModel,
        cwd: basename(process.cwd()),
        skills: skills.length,
        mode: autoApprove ? 'yolo' : cfg.approval === 'auto' ? 'auto' : 'ask',
        queue: taskQueue.length,
        version: HMH_VERSION,
      }));
    }
  };
  applyStatusline();
  // T23: persisted /mouse force (config.json tui.mouse) - for terminals
  // that honour neither wheel->arrow translation nor ?1007
  if ((cfg as { tui?: { mouse?: boolean } }).tui?.mouse) rt.setMouseForced(true);
  // Ctrl+T overlay source: transcript + FULL (folded-away) tool outputs (B5)
  rt.setOverlaySource(() => {
    const out: string[] = [];
    for (const t of fullToolLog) {
      out.push('', `── ${t.name} ──`, t.output);
    }
    return out;
  });

  async function executeTaskQueue(firstTask: string, forkFrom?: string, forkResume?: ChatMessage[]): Promise<void> {
    taskRunning = true;
    let task: string | undefined = firstTask;
    let first = true;
    while (task) {
      await runSingleTask(task, first ? forkFrom : undefined, first ? forkResume : undefined);
      first = false;
      task = taskQueue.shift();
      rt.setQueued(taskQueue.length);
      if (task) rt.addText(`▶ next queued: "${task.slice(0, 60)}${task.length > 60 ? '…' : ''}"`, 'dim');
    }
    taskRunning = false;
  }

  async function runSingleTask(line: string, forkFrom?: string, forkResume?: ChatMessage[]): Promise<void> {
    rt.addUser(line);
    // the folded echo hides everything past line 2 - keep the full prompt
    // retrievable in the Ctrl+T replay
    fullToolLog.push({ name: 'user', output: line.slice(0, 4000) });
    rt.setBusy(true, t.running);
    currentAbort = new AbortController();
    const injectCh: { queue: string[]; active: boolean } = { queue: [], active: false };
    currentInject = injectCh;
    // /plan (M4 B7): a plan-first system directive rides ahead of the resume
    const planDirective: ChatMessage[] = planMode
      ? [{ role: 'system', content: '[plan mode] Before ANY tool use, present a concrete plan (2-5 numbered steps). Then STOP and wait for the user to confirm before executing. Only execute after explicit confirmation.' }]
      : [];
    const resumeBase = [...planDirective, ...(forkResume ?? history)];
    let appender: (((c: string) => void) & { drop: () => void }) | null = null;
      let reasoningBuf = '';
      const foldThinking = () => { if (reasoningBuf.trim()) { fullToolLog.push({ name: 'thinking', output: reasoningBuf.slice(0, 8000) }); } reasoningBuf = ''; rt.foldThinking(); };
    let kind: import('@hmharness/kernel').DeltaKind | null = null;
    try {
      const result = await runAgentTask({
        task: line,
        registry: reg,
        cfg,
        yes: autoApprove,
        resumeMessages: resumeBase,
        sessionId: forkResume !== undefined ? undefined : currentSessionId,
        signal: currentAbort.signal,
        // M2 runtime steering: Ctrl+Enter pushes here; the runner drains it
        // between tool batches and the injected text lands as a user message
        inject: injectCh,
        // Esc-Esc fork (T13): the new rollout records the parent session id
        ...(forkFrom ? { forkFrom } : {}),
        approvalAsk: (name, args) => rt.requestApproval(name, args),
        events: {
          onLine: (l) => { if (kind === 'reasoning') foldThinking(); appender = null; kind = null; rt.addText(l, 'dim'); },
          onDelta: (k, chunk) => {
            if (k === 'reasoning') reasoningBuf += chunk;
            if (k === 'reset') {
              // provider retry after a mid-stream cut: drop the half answer
              appender?.drop?.();
              appender = null; kind = null;
              return;
            }
            if (k !== kind) {
              if (kind === 'reasoning') foldThinking();
              appender = rt.startStream(k === 'reasoning' ? 'think' : 'say'); kind = k;
            }
            appender?.(chunk);
          },
          onToolCall: (name, args) => {
            if (kind === 'reasoning') foldThinking();
            appender = null; kind = null;
            const brief = name === 'run_command' && typeof args.command === 'string'
              ? args.command
              : JSON.stringify(args);
            rt.addText(`${YELLOW('●')} ${CYAN(name)} ${DIM(brief.replace(/\s+/g, ' ').slice(0, 90))}`);
          },
          onToolResult: (name, output, isError) => {
            const dot = isError ? RED('✗') : GREEN('•');
            const first = output.split('\n').find((l) => l.trim()) ?? '';
            // M4 B8: tool call + result = one collapsible cell (folded summary
            // by default; `z` with an empty input expands the last one)
            rt.addToolCell(`  ${dot} ${CYAN(name)} ${DIM('⎿ ' + first.trim().slice(0, 100))}`, output);
            // M4 B9 (T18 复案 2026-09-21): outputs beyond a screen NO LONGER
            // auto-open the full-screen pager - on every system it read as a
            // break-in (a wall of raw output hijacking the screen while the
            // task ran on underneath, 'frozen' until Esc). The folded cell
            // plus this hint line keep the escape hatches visible instead.
            const outLines = output.split('\n').length;
            if (outLines > 2 * Math.max(20, (stdout.rows || 30))) {
              rt.addText('  ' + DIM(t.tuiLongOutputHint(name, outLines)), 'plain');
            }
            // retain the FULL output for the Ctrl+T transcript overlay (B5);
            // the transcript itself keeps only the folded first line
            fullToolLog.push({ name, output: output.slice(0, 4000) });
            if (fullToolLog.length > 100) fullToolLog.splice(0, fullToolLog.length - 100);
          },
          onInjected: (message) => {
            rt.addText(`⤷ injected: "${message.slice(0, 80)}"`, 'dim');
          },
        },
      });
      rt.setBusy(false);
      currentSessionId = result.sessionId;
      currentInject = null;
      lastAiText = result.text || lastAiText;
      rt.setStatus(`↑${result.usage.promptTokens} ↓${result.usage.completionTokens} tok · ${result.turns} turns · ${result.toolUses} tools`);
      // the plan directive rides in resumeBase but is NOT part of the thread:
      // history keeps only real messages (the next task re-applies it)
      history = [...(forkResume ?? history), { role: 'user', content: line }, ...result.messages.slice(resumeBase.length + 2)];
    } catch (err) {
      rt.setBusy(false);
      currentInject = null;
      rt.addText(String(err), 'err');
    } finally {
      currentAbort = null;
    }
  }

  /** Load a rollout into the conversation: `history` for the model, a tail
   *  window for the eye, and currentSessionId so the next turn APPENDS to
   *  the same rollout (codex Resume semantics - one thread, one file). */
  async function resumeInto(file: string): Promise<void> {
    const tr = await loadTranscript(file);
    if (!tr || tr.messages.length === 0) { rt.addText(t.cmdResumeNotFound(tr?.id ?? file), 'err'); return; }
    history = tr.messages;
    currentSessionId = tr.id;
    rt.clearScreen();
    // long sessions render from the tail so the visible window stays usable
    // while the complete transcript lives in `history` for the model
    const MAX_RENDER = 80;
    const msgs = tr.messages;
    const skipped = Math.max(0, msgs.length - MAX_RENDER);
    rt.addText(t.cmdResuming(tr.id, msgs.length, skipped), 'dim');
    for (const m of (skipped > 0 ? msgs.slice(skipped) : msgs)) {
      const text = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') {
        rt.addUser(text.replace(/\n+/g, ' ').slice(0, 400));
      } else if (m.role === 'assistant') {
        const calls = (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? [];
        if (text.trim()) rt.addText(text.slice(0, 2000));
        for (const c of calls) rt.addText('● ' + CYAN(String(c.function?.name ?? 'tool')) + DIM(' …'), 'dim');
      } else if (m.role === 'tool') {
        const first = text.split('\n').find((l) => l.trim()) ?? '';
        if (first) rt.addText('  ' + DIM('⎿ ' + first.trim().slice(0, 100)), 'dim');
      } else if (m.role === 'system' && text && !text.startsWith('[context pruned')) {
        rt.addText(DIM(text.slice(0, 300)), 'dim');
      }
    }
    rt.addText(t.cmdResumeLoaded(tr.messages.length), 'dim');
  }

  async function handleLine(line: string): Promise<void> {
    if (line === '/exit' || line === '/quit') {
      rt.destroy();
      for (const c of clients) c.close();
      process.exit(0);
    }
    if (line === '/queue' || line.startsWith('/queue ')) {
      const sub = line.slice(7).trim();
      if (sub === 'clear') {
        const n = taskQueue.length;
        taskQueue.length = 0;
        rt.setQueued(0);
        rt.addText(n > 0 ? 'cleared ' + n + ' queued task(s)' : 'queue was already empty', 'dim');
        return;
      }
      // bare /queue: show status. Operations are key-based, not command-based:
      // empty Enter stops the current task, typed input queues, this only inspects.
      const status = taskRunning ? 'running' : 'idle';
      const queueList = taskQueue.length > 0
        ? taskQueue.map((task, i) => '  ' + (i + 1) + '. ' + task.slice(0, 70)).join('\n')
        : '  (empty)';
      rt.addText('queue: ' + status + ' | ' + taskQueue.length + ' waiting\n' + queueList + '\n\nEsc = stop current · type+Enter = queue · Ctrl+Enter = inject · /queue clear = drop all', 'dim');
      return;
    }
    if (line === '?' || line === '/help') {
      rt.addText(COMMANDS.map((c) => '  ' + c.name.padEnd(11) + ' ' + String(t[c.key as keyof typeof t])).join('\n'), 'dim');
      return;
    }
    // /clear = new thread (codex /new): blank screen, drop the in-memory
    // transcript AND start a fresh rollout on the next task
    if (line === '/clear') { rt.clearScreen(); history = []; currentSessionId = undefined; return; }
    if (line === '/new') { rt.clearScreen(); history = []; currentSessionId = undefined; pendingFork = false; forkAll = false; rt.addText(DIM(t.cmdNewDone)); return; }
    if (line === '/compact') {
      // M4 B7: compact the in-memory resume with the adaptive budget and
      // report the delta (honest: it affects the NEXT turn's context)
      const before = transcriptChars(history);
      const budget = adaptiveContextChars(cfg.provider);
      history = compactMessages(history, budget);
      const after = transcriptChars(history);
      rt.addText(`context: ${before.toLocaleString()} → ${after.toLocaleString()} chars (freed ${(before - after).toLocaleString()}; budget ${budget.toLocaleString()})`, 'dim');
      return;
    }
    if (line === '/diff') {
      // M4 B7: pager-view the worktree git diff (incl. untracked) via the
      // B5 overlay base
      rt.setBusy(true, '/diff');
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const g = (a: string[], mb: number) => run('git', a, { cwd: process.cwd(), windowsHide: true, maxBuffer: mb }).then((r) => String(r.stdout)).catch(() => '');
        const [st, df, un] = await Promise.all([
          g(['status', '--porcelain'], 4 * 1024 * 1024),
          g(['diff'], 8 * 1024 * 1024),
          g(['ls-files', '--others', '--exclude-standard'], 4 * 1024 * 1024),
        ]);
        const lines = [
          '── git status ──',
          ...(st.split('\n').filter(Boolean) || ['(clean)']),
          '',
          '── git diff ──',
          ...(df.split('\n') || ['(no tracked changes)']),
          '',
          '── untracked ──',
          ...(un.split('\n').filter(Boolean).slice(0, 60) || ['(none)']),
        ];
        rt.showOverlay(t.cmdDiff, lines);
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/fork') {
      // M4 B7: fork the CURRENT thread to a new session — the next task
      // resumes the FULL history and records forkFrom provenance
      if (!currentSessionId && history.length === 0) { rt.addText('nothing to fork yet', 'dim'); return; }
      pendingFork = true;
      forkAll = true;
      rt.addText(DIM('✂ next task runs as a NEW session (forked' + (currentSessionId ? ' from ' + currentSessionId : '') + ' — full context inherited)'));
      return;
    }
    if (line === '/copy') {
      // M4 B7: last AI output -> clipboard (Windows clip / mac pbcopy /
      // linux xclip fallback chain; zero deps, stdin-fed)
      if (!lastAiText) { rt.addText('(no AI output yet to copy)', 'dim'); return; }
      const { spawn } = await import('node:child_process');
      const tryBin = (bin: string, args: string[]) => new Promise<boolean>((res) => {
        const child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => res(false));
        child.stdin.on('error', () => { /* EPIPE when the bin vanished mid-run */ });
        child.stdin.write(lastAiText);
        child.stdin.end();
        child.on('close', (code) => res(code === 0));
      });
      // candidate chain (T16 复案): Wayland wl-copy before X11 xclip/xsel -
      // a single hard-coded xclip is dead on a pure wl session (Omarchy)
      let copied = false;
      for (const c of clipboardCandidates(process.platform, process.env)) {
        if (await tryBin(c.bin, c.args)) { copied = true; break; }
      }
      if (copied) rt.addText(GREEN('✓') + ' ' + t.cmdCopied, 'plain');
      else rt.addText('(clipboard tool unavailable — output follows)\n' + lastAiText.slice(0, 2000), 'dim');
      return;
    }
    if (line === '/mouse') {
      // T23: full-time capture toggle for terminals without wheel
      // translation (?1007 already covers the wheel on mainstream ones);
      // while forced, Shift+drag is the selection escape hatch
      const next = !rt.isMouseForced();
      rt.setMouseForced(next);
      try {
        const { patchConfig } = await import('@hmharness/kernel');
        const merged = { ...((cfg as { tui?: object }).tui ?? {}), mouse: next };
        cfg = await patchConfig({ tui: merged } as never) as typeof cfg;
      } catch { /* runtime toggle applied even when persisting fails */ }
      rt.addText(next ? t.cmdMouseOn : t.cmdMouseOff, 'plain');
      return;
    }
    if (line === '/plan' || line.startsWith('/plan ')) {
      // M4 B7: plan mode toggle (the directive is injected per-task, so the
      // agent always presents a plan and waits for confirmation first)
      planMode = !planMode;
      rt.addText(planMode ? GREEN('🔥') + ' ' + t.cmdPlanOn : t.cmdPlanOff, 'plain');
      return;
    }
    if (line === '/goal' || line.startsWith('/goal ')) {
      // M4 B7: session goal (shared storage with web A6 — kernel/goal.ts)
      const arg = line.slice(6).trim();
      const key = currentSessionId ?? 'web';
      try {
        if (!arg) {
          const g = await getGoal(home, key);
          rt.addText(g ? `goal: ${g}` : '(no goal set — /goal <text> to set)', 'dim');
        } else if (arg === 'clear') {
          await clearGoal(home, key);
          rt.addText(t.cmdGoalCleared, 'dim');
        } else {
          await setGoal(home, key, arg);
          rt.addText(GREEN('✓') + ` goal set (session ${key.slice(0, 8)}…)`, 'plain');
        }
      } catch (err) {
        rt.addText(String(err), 'err');
      }
      return;
    }
    if (line === '/usage') {
      // M4 B7: session context occupancy (the resume the model will see)
      const chars = transcriptChars(history);
      const budget = adaptiveContextChars(cfg.provider);
      rt.addText(`context: ${chars.toLocaleString()} chars (~${Math.ceil(chars / 4).toLocaleString()} tok) of ${budget.toLocaleString()} budget (${Math.round((chars / budget) * 100)}%)`, 'dim');
      return;
    }
    if (line === '/statusline' || line.startsWith('/statusline ')) {
      // M5 B11: customize the idle statusline ({model} {cwd} {skills} {mode}
      // {queue} {version}); persisted under config.json tui.statusline
      const arg = line.slice(12).trim();
      const cur = (cfg as { tui?: { statusline?: string } }).tui?.statusline ?? '';
      if (!arg) {
        rt.addText(cur ? `statusline: "${cur}"` : '(no custom statusline — /statusline "{model} · {cwd}" to set; placeholders: model cwd skills mode queue version)', 'dim');
        return;
      }
      try {
        const { patchConfig } = await import('@hmharness/kernel');
        const merged = { ...((cfg as { tui?: object }).tui ?? {}), statusline: arg };
        const fresh = await patchConfig({ tui: merged } as never);
        cfg = fresh as typeof cfg;
        applyStatusline();
        rt.addText(GREEN('✓') + ` statusline: "${arg}"`, 'plain');
      } catch (err) {
        rt.addText(String(err), 'err');
      }
      return;
    }
    if (line === '/keymap' || line.startsWith('/keymap ')) {
      // M5 B14: show / remap the M2/M4 action keys (config.json tui.keymap)
      const arg = line.slice(8).trim();
      if (!arg) {
        const km = (cfg as { tui?: { keymap?: Record<string, string> } }).tui?.keymap ?? {};
        const rows = Object.entries(KEYMAP_DEFAULTS).map(([a, d]) => {
          const v = km[a] ?? d;
          const pretty = v === '\x1b' ? 'esc' : v === '\x0a' ? 'ctrl+enter' : v === '\x12' ? 'ctrl+r' : v === '\x14' ? 'ctrl+t' : v === '\x07' ? 'ctrl+g' : JSON.stringify(v);
          return `  ${a.padEnd(14)} ${pretty}`;
        });
        rt.addText('keymap (defaults in parens):\n' + rows.join('\n') + '\n\n/keymap <action>=<key> — e.g. /keymap inject=ctrl+j', 'dim');
        return;
      }
      const eq = arg.indexOf('=');
      if (eq <= 0) { rt.addText('usage: /keymap <action>=<key> (actions: ' + Object.keys(KEYMAP_DEFAULTS).join(' ') + ')', 'err'); return; }
      const action = arg.slice(0, eq).trim();
      const spec = arg.slice(eq + 1).trim();
      if (!(action in KEYMAP_DEFAULTS)) { rt.addText(`unknown action "${action}" (actions: ${Object.keys(KEYMAP_DEFAULTS).join(' ')})`, 'err'); return; }
      const byte = parseKeySpec(spec);
      if (byte === null) { rt.addText(`unknown key "${spec}" (try: esc, ctrl+r, ctrl+t, ctrl+j, ctrl+g, ctrl+p, ctrl+n, tab, enter, or a single char)`, 'err'); return; }
      try {
        const { patchConfig } = await import('@hmharness/kernel');
        const prev = (cfg as { tui?: { keymap?: Record<string, string> } }).tui?.keymap ?? {};
        const merged = { ...((cfg as { tui?: object }).tui ?? {}), keymap: { ...prev, [action]: byte } };
        const fresh = await patchConfig({ tui: merged } as never);
        cfg = fresh as typeof cfg;
        rt.setKeymap({ ...prev, [action]: byte });
        rt.addText(GREEN('✓') + ` ${action} → ${spec}`, 'plain');
      } catch (err) {
        rt.addText(String(err), 'err');
      }
      return;
    }
    if (line === '/review') {
      // M4 B7: one-click "review the current worktree" task template
      const reviewTask = 'Review the current worktree: run git status and inspect the diffs, then identify bugs, risks, regressions, and missing tests. Report findings ordered by severity with file:line references. Do NOT modify any files.';
      if (taskRunning) {
        taskQueue.push(reviewTask);
        rt.setQueued(taskQueue.length);
        rt.addText(`📋 queued: "review the worktree" (${taskQueue.length} waiting)`, 'dim');
      } else {
        void executeTaskQueue(reviewTask);
      }
      return;
    }
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
    if (line === '/resume' || line.startsWith('/resume ')) {
      const arg = line.slice(8).trim();
      // bare /resume opens the Codex-style full-frame picker (typeahead,
      // cwd filter, sort toolbar, lazy pages). It is a modal: it cannot share
      // the screen with a running task's streaming output.
      if (!arg) {
        if (taskRunning) { rt.addText('task running - Esc to stop, then /resume', 'dim'); return; }
        const pick = await rt.openResumePicker();
        if (!pick || pick.kind !== 'resume') return;
        await resumeInto(pick.row.file);
        return;
      }
      const file = await latestSession(home, arg);
      if (!file) { rt.addText(t.cmdResumeNotFound(arg), 'err'); return; }
      await resumeInto(file);
      return;
    }
    if (line === '/yolo' || line === '/yolo on' || line === '/yolo off') {
      const turnOn = line === '/yolo' ? !autoApprove : line === '/yolo on';
      autoApprove = turnOn;
      rt.setModeTag(turnOn ? '🔥' : '');
      rt.addText(turnOn ? t.yoloOn : t.yoloOff, turnOn ? 'plain' : 'dim');
      return;
    }
    if (line === '/lang' || line.startsWith('/lang ')) {
      const target = nextLocale(cfg.locale ?? 'zh', line.slice(5));
      cfg = await setLocale(target);
      t = strings(target);
      rt.configure(chatModel, basename(process.cwd()), skills.length, target, HMH_VERSION);
      rt.addText(GREEN('✓') + ' ' + t.langSwitched(target));
      return;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const arg = line.slice(7).trim();
      if (!arg) {
        // bare /model: the LIVE picker is the single menu. Printing a
        // static provider list here too showed TWO model menus at once
        // (one selectable, one not) - transcript stays minimal
        rt.openModelPicker();
        return;
      }
      rt.setBusy(true, '/model');
      try {
        cfg = await setChatRoute(arg);
        rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
        rt.addText(GREEN('✓') + ` chat → ${arg} · ${resolveProvider(cfg, 'chat').model}`);
      } catch (err) {
        const preset = PROVIDER_PRESETS.find((p) => p.name === arg);
        rt.addText(preset ? t.cmdModelPreset(arg, preset.envVar || '(local)') : String(err), 'err');
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
            ? found.map((p) => `${YELLOW('+')} ${p.name} — ${p.model} (${p.envVar})`).join('\n') + '\n' + DIM(t.cmdProvidersScanHint)
            : DIM(t.cmdProvidersListed), 'plain');
        } else {
          if (!found.length) {
            rt.addText(DIM(t.cmdProvidersNone) + Object.keys(cfg.providers ?? {}).join(', '), 'plain');
          } else {
            const r = await addProviders(found.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })));
            cfg = r.cfg;
            rt.setModelChoices(listProviders(cfg).map((v) => ({ name: v.name, desc: `${v.model}${v.purposes.length ? ' (' + v.purposes.join('/') + ')' : ''}` })));
            rt.addText(GREEN('✓') + ' ' + t.cmdProvidersAdded(r.added.length, r.added.join(', ')));
          }
        }
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/ops') {
      rt.setBusy(true, '/ops');
      try {
        const { opsStatus, describeSources } = await import('@hmharness/domain-ops');
        const s = await opsStatus(home);
        rt.addText(s.lastScan
          ? t.opsRadarLine(s.scans, s.lastScan.replace('T', ' ').slice(0, 19))
          : t.opsRadarNone);
        rt.addText(t.opsWatchingLabel + ' ' + describeSources(s.sources));
        rt.addText(DIM(t.opsHint));
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
        const { harmonyOpsRadarScan } = await import('@hmharness/domain-ops');
        const r = await harmonyOpsRadarScan.execute({}, { cwd: process.cwd(), home });
        rt.addText(r.output);
      } catch (err) {
        rt.addText(String(err), 'err');
      } finally {
        rt.setBusy(false);
      }
      return;
    }
    if (line === '/ops brief') {
      rt.setBusy(true, '/ops brief');
      try {
        const { latestBrief } = await import('@hmharness/domain-ops');
        const b = await latestBrief(home);
        if (b) rt.addText(`(${b.date})\n${b.text}`.slice(0, 20_000));
        else rt.addText(t.opsNoBrief, 'dim');
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
        const { chat } = await import('@hmharness/kernel');
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
        const { chat } = await import('@hmharness/kernel');
        const report = await runEvolution({
          home,
          provider: cfg.provider,
          runCase: async (c) => {
            if (c.tools) return t.cmdEvolveHint;
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
  }

  await rt.waitExit();
  rt.destroy();
  for (const c of clients) c.close();
  stdout.write('\n');
}
