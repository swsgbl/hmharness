/**
 * @hmharness/cli - terminal markdown renderer (zero dependencies)
 *
 * Renders model markdown into clean terminal lines - styled headings with
 * rules, CJK-aware aligned box tables, nested/task lists, fenced code,
 * blockquotes, inline bold/code/links - closing the gap to the Codex CLI /
 * Claude Code terminals (2026-10-29 user feedback: the old mdColor was a
 * line-start tint, not a renderer; the model emits standard markdown, the
 * CLI owns the rendering). SGR escapes only: no cursor moves, no alt-screen,
 * so conhost/Windows Terminal both cope. Pure + deterministic: the TUI's
 * streaming repaint feeds completed lines here and appends the raw in-flight
 * tail (codex markdown_stream.rs re-renders open blocks the same way).
 */
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const UNDERLINE = '\x1b[4m';
const INVERSE = '\x1b[7m';

/* ---------------- width (CJK-aware; same table as tui.ts) ---------------- */
/* Not imported from tui.ts: tui.ts imports this module, and duplicating the
 * 8-line table beats a dependency cycle. Keep the ranges in sync. */
function cw(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
  ) return 2;
  return 1;
}
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cw(ch);
  return w;
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/* ---------------- inline: single-pass state machine, no nesting ----------
 * `**b**`/`*em*`/`_em_` -> bold (italic renders poorly in terminals);
 * `code` -> SGR 7 inverse; [text](url) -> underlined text, url dropped;
 * backslash escapes kept literal; HTML tags stripped. Bold bodies are NOT
 * re-parsed (no recursive nesting), matching the task spec. */
export interface InlineTok { text: string; sgr: string }
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '<', '>', '#', '+', '-', '~', '!']);
const wbBefore = (s: string, i: number): boolean => i === 0 || /[\s("']/.test(s[i - 1]!);
const wbAfter = (s: string, i: number): boolean => i + 1 >= s.length || /[\s,.;:!?"')]/.test(s[i + 1]!);

export function parseInline(text: string): InlineTok[] {
  const toks: InlineTok[] = [];
  let plain = '';
  const flush = (): void => { if (plain) { toks.push({ text: plain, sgr: '' }); plain = ''; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && ESCAPABLE.has(text[i + 1] ?? '')) { plain += text[i + 1]!; i += 2; continue; }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flush(); toks.push({ text: text.slice(i + 1, close), sgr: INVERSE });
        i = close + 1; continue;
      }
    }
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close > i + 2) {
        flush(); toks.push({ text: text.slice(i + 2, close), sgr: BOLD });
        i = close + 2; continue;
      }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] !== '*' && text[i + 1] !== ' ' && wbBefore(text, i)) {
      let close = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === ch && text[j + 1] !== ch) { close = j; break; }
      }
      // body must not end with a space either, so `a * b * c` stays literal
      if (close > i + 1 && text[close - 1] !== ' ' && wbAfter(text, close)) {
        flush(); toks.push({ text: text.slice(i + 1, close), sgr: BOLD });
        i = close + 1; continue;
      }
    }
    if (ch === '[') {
      const cb = text.indexOf('](', i + 1);
      if (cb > i) {
        const cp = text.indexOf(')', cb + 2);
        if (cp > cb) {
          flush(); toks.push({ text: text.slice(i + 1, cb), sgr: UNDERLINE });
          i = cp + 1; continue;
        }
      }
    }
    if (ch === '<') {
      const m = /^<\/?[a-zA-Z][^>]*>/.exec(text.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    plain += ch; i++;
  }
  flush();
  return toks;
}

function renderToks(toks: InlineTok[], override = ''): string {
  let out = '';
  for (const t of toks) {
    const s = override || t.sgr;
    out += s ? s + t.text + RESET : t.text;
  }
  return out;
}
const toksWidth = (toks: InlineTok[]): number => toks.reduce((a, t) => a + strWidth(t.text), 0);

/* ---------------- wrap: SGR-aware greedy wrap over the token stream ------- */
interface Cell { ch: string; sgr: string; w: number }

function renderCells(cells: Cell[]): string {
  let out = '';
  let run = '';
  let cur: string | null = null;
  for (const c of cells) {
    if (c.sgr !== cur) {
      if (run) out += cur ? cur + run + RESET : run;
      cur = c.sgr; run = '';
    }
    run += c.ch;
  }
  if (run) out += cur ? cur + run + RESET : run;
  return out;
}

/** Break at the last in-line space when possible; CJK runs (no spaces) break
 *  hard at the width limit. Every emitted line fits its budget. */
function wrapToks(toks: InlineTok[], firstW: number, restW: number): string[] {
  const cells: Cell[] = [];
  for (const t of toks) for (const ch of t.text) cells.push({ ch, sgr: t.sgr, w: cw(ch) });
  const out: string[] = [];
  let line: Cell[] = [];
  let lw = 0;
  let first = true;
  const flush = (): void => {
    while (line.length > 0 && line[line.length - 1]!.ch === ' ') line.pop();
    out.push(renderCells(line));
    line = []; lw = 0; first = false;
  };
  for (const c of cells) {
    if (c.ch === ' ' && lw === 0 && !first) continue;
    if (c.ch !== ' ' && line.length > 0 && lw + c.w > (first ? firstW : restW)) {
      let sp = -1;
      for (let j = line.length - 1; j > 0; j--) if (line[j]!.ch === ' ') { sp = j; break; }
      if (sp > 0) {
        const carry = line.slice(sp + 1);
        line.length = sp;
        flush();
        line = carry;
        lw = carry.reduce((a, b) => a + b.w, 0);
        while (line.length > 0 && line[0]!.ch === ' ') { lw -= line[0]!.w; line.shift(); }
      } else {
        flush();
      }
    }
    line.push(c); lw += c.w;
  }
  flush();
  return out;
}

/** SGR-aware truncation with an ellipsis (code lines, table cells, headings). */
function truncateVis(s: string, max: number): string {
  if (strWidth(stripAnsi(s)) <= max) return s;
  let w = 0;
  let out = '';
  for (let i = 0; i < s.length; ) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.substring(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (w + cw(ch) > max - 1) return out + '…';
    out += ch; w += cw(ch); i += ch.length;
  }
  return out;
}

/* ---------------- block renderers ---------------- */

function renderHeading(level: number, content: string, width: number): string[] {
  const sgr = level <= 2 ? BOLD + CYAN : level <= 4 ? BOLD : DIM + BOLD;
  let line = renderToks(parseInline(content), sgr);
  if (strWidth(stripAnsi(line)) > width) line = truncateVis(line, width);
  const out = [line];
  if (level <= 2) {
    out.push(DIM + '─'.repeat(Math.min(width, strWidth(stripAnsi(line)) + 2)) + RESET);
  }
  return out;
}

function renderCode(lines: string[], lang: string, width: number): string[] {
  // no inline parsing inside fences; 2-space `│ ` dim prefix, lang at tail of line 1
  const max = Math.max(4, width - 2);
  const out = lines.length === 0 ? [''] : lines.map((cl) => (strWidth(cl) > max ? truncateVis(cl, max) : cl));
  return out.map((cl, idx) => DIM + '│ ' + RESET + cl + (idx === 0 && lang ? '  ' + DIM + lang + RESET : ''));
}

function renderQuote(contents: string[], width: number): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const emitPara = (): void => {
    if (para.length === 0) return;
    for (const l of wrapToks(parseInline(para.join(' ')), width - 2, width - 2)) {
      out.push(DIM + '│ ' + RESET + l);
    }
    para = [];
  };
  for (const c of contents) {
    if (c === '') { emitPara(); out.push(DIM + '│ ' + RESET); } else para.push(c);
  }
  emitPara();
  return out.length === 0 ? [DIM + '│ ' + RESET] : out;
}

type Align = 'l' | 'c' | 'r';
function tableSepAlign(cell: string): Align | null {
  const t = cell.trim();
  const core = t.replace(/^:/, '').replace(/:$/, '');
  if (!/^-+$/.test(core)) return null;
  return t.startsWith(':') && t.endsWith(':') ? 'c' : t.endsWith(':') ? 'r' : 'l';
}
function isTableSepLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  let body = t;
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells = body.split('|');
  return cells.length > 0 && cells.every((c) => tableSepAlign(c) !== null);
}
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  // `\|` inside a cell is a literal pipe, not a separator (GFM tables)
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
    if (t[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[k]!;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(header: string[], aligns: Align[], rows: string[][], width: number): string[] {
  const n = header.length;
  const headToks = header.map(parseInline);
  const rowToks = rows.map((r) => r.map(parseInline));
  const natural = new Array<number>(n).fill(0);
  for (const set of [headToks, ...rowToks]) {
    set.forEach((toks, i) => { if (i < n) natural[i] = Math.max(natural[i]!, toksWidth(toks)); });
  }
  // Columns keep their natural width while the box fits `width`; only when
  // it overflows does the widest column shrink first (floor 3), so an
  // in-budget table is never truncated (task spec: only what does not fit
  // gets the ellipsis). chrome = borders + one space of padding per side.
  const chrome = n + 1 + 2 * n;
  const colW = natural.map((w) => Math.max(1, w));
  const boxW = (): number => colW.reduce((a, b) => a + b, 0) + chrome;
  while (boxW() > width) {
    let widest = 0;
    for (let i = 0; i < n; i++) if (colW[i]! > colW[widest]!) widest = i;
    if (colW[widest]! <= 3) break;
    colW[widest]! -= 1;
  }
  const bar = (l: string, m: string, r: string): string => DIM + l + colW.map((w) => '─'.repeat(w + 2)).join(m) + r + RESET;
  const rowLine = (cells: InlineTok[][], isHead: boolean): string => {
    const parts = cells.map((toks, i) => {
      let s = renderToks(toks);
      if (toksWidth(toks) > colW[i]!) s = truncateVis(s, colW[i]!);
      if (isHead) s = BOLD + s + RESET;
      const pad = colW[i]! - Math.min(toksWidth(toks), colW[i]!);
      const a = aligns[i] ?? 'l';
      if (a === 'r') return ' ' + ' '.repeat(pad) + s + ' ';
      if (a === 'c') { const l = Math.floor(pad / 2); return ' ' + ' '.repeat(l) + s + ' '.repeat(pad - l) + ' '; }
      return ' ' + s + ' '.repeat(pad) + ' ';
    });
    return DIM + '│' + RESET + parts.join(DIM + '│' + RESET) + DIM + '│' + RESET;
  };
  const out = [bar('┌', '┬', '┐'), rowLine(headToks, true), bar('├', '┼', '┤')];
  for (const r of rowToks) out.push(rowLine(r, false));
  out.push(bar('└', '┴', '┘'));
  return out;
}

interface LiItem { level: number; ordered: boolean; num: string; text: string }
const TASK_RE = /^\[( |x|X)\]\s+/;

function renderList(items: LiItem[], width: number): string[] {
  const out: string[] = [];
  for (const it of items) {
    const indent = ' '.repeat(it.level * 2);
    const task = TASK_RE.exec(it.text);
    const body = task ? it.text.slice(task[0].length) : it.text;
    let marker: string;
    let markerW: number;
    if (task) {
      const sym = task[1] === ' ' ? DIM + '☐' + RESET : GREEN + '☑' + RESET;
      marker = sym + ' '; markerW = 2;
    } else if (it.ordered) {
      marker = it.num + '. '; markerW = strWidth(it.num) + 2;
    } else {
      marker = '• '; markerW = 2;
    }
    const avail = Math.max(8, width - indent.length - markerW);
    const wrapped = wrapToks(parseInline(body), avail, avail);
    out.push(indent + marker + wrapped[0]!);
    for (let k = 1; k < wrapped.length; k++) out.push(indent + ' '.repeat(markerW) + wrapped[k]!);
  }
  return out;
}

/* ---------------- block scanner + main entry ---------------- */

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Render markdown text into styled terminal lines. One linear pass splits
 *  blocks; every block renderer is O(lines). Deterministic: same input and
 *  width always produce the same array (streaming repaint relies on it). */
export function renderMarkdown(text: string, width: number): string[] {
  const W = Math.max(8, width);
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let pendingGap = false;
  let prevType = '';
  const emit = (type: string, block: string[]): void => {
    // blank line between blocks: forced before headings (except the very
    // first line), on source blank lines, and across block-type changes
    if (out.length > 0 && out[out.length - 1] !== '' && (type === 'heading' || pendingGap || prevType !== type)) {
      out.push('');
    }
    out.push(...block);
    prevType = type;
    pendingGap = false;
  };

  let i = 0;
  while (i < src.length) {
    const raw = src[i]!;
    const t = raw.trim();
    if (t === '') { i++; pendingGap = true; continue; }

    const fence = /^(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      const lang = fence[2]!.trim();
      i++;
      const code: string[] = [];
      while (i < src.length && !/^(`{3,}|~{3,})\s*$/.test(src[i]!.trim())) { code.push(src[i]!); i++; }
      if (i < src.length) i++; // closing fence (absent while streaming: fine)
      emit('code', renderCode(code, lang, W));
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(t);
    if (h) { emit('heading', renderHeading(h[1]!.length, h[2]!, W)); i++; continue; }

    if (t.includes('|') && i + 1 < src.length && isTableSepLine(src[i + 1]!)) {
      const header = splitRow(raw);
      const aligns = splitRow(src[i + 1]!).map((c) => tableSepAlign(c) ?? 'l');
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && src[i]!.trim() !== '' && src[i]!.includes('|')) { rows.push(splitRow(src[i]!)); i++; }
      emit('table', renderTable(header, aligns, rows, W));
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(t)) { emit('hr', [DIM + '─'.repeat(W) + RESET]); i++; continue; }

    if (t.startsWith('>')) {
      const contents: string[] = [];
      while (i < src.length && src[i]!.trim().startsWith('>')) {
        contents.push(src[i]!.trim().replace(/^>\s?/, '').trim()); i++;
      }
      emit('quote', renderQuote(contents, W));
      continue;
    }

    if (LIST_RE.test(raw)) {
      const items: LiItem[] = [];
      while (i < src.length && src[i]!.trim() !== '' && LIST_RE.test(src[i]!)) {
        const m = LIST_RE.exec(src[i]!)!;
        items.push({
          level: Math.floor(m[1]!.length / 2),
          ordered: /^\d/.test(m[2]!),
          num: m[2]!.replace(/[.)]$/, ''),
          text: m[3]!,
        });
        i++;
      }
      emit('list', renderList(items, W));
      continue;
    }

    // paragraph: consecutive plain lines merge into one block (GFM soft
    // breaks); the block reflows internally until a blank line closes it,
    // and closed blocks above never change (streaming stability)
    const paraLines: string[] = [t];
    i++;
    while (i < src.length && !paraBreak(src, i)) { paraLines.push(src[i]!.trim()); i++; }
    emit('para', wrapToks(parseInline(paraLines.join(' ')), W, W));
  }
  return out;
}

/** true when lines[k] opens a new block (or is blank), ending the paragraph.
 *  Any pipe-bearing line breaks too: while streaming it may be the header of
 *  a table whose separator row has not arrived yet, so merging it into the
 *  surrounding prose would reflow that prose once the table closes. */
function paraBreak(lines: string[], k: number): boolean {
  const s = lines[k]!;
  const tt = s.trim();
  if (tt === '') return true;
  if (/^(`{3,}|~{3,})/.test(tt) || /^#{1,6}\s/.test(tt) || tt.startsWith('>') || /^([-*_])\1{2,}$/.test(tt) || LIST_RE.test(s)) return true;
  return tt.includes('|');
}
