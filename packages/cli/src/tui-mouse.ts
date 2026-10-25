/**
 * @hmharness/cli - tui-mouse (2026-10-22; press-consumption fix 2026-10-24)
 *
 * SGR mouse tracking (DECSET 1000+1002+1006): the terminal reports
 * ESC[<button;col;rowM (press) / m (release). A LEFT-BUTTON RELEASE without
 * drag is a click (dsh-TUI's contract). CRITICAL LESSON (v0.23.38 shipped a
 * dead click path): a click is reported as TWO sequences - press then
 * release. The press sequence MUST be consumed too; letting it fall through
 * to key handling made the leading ESC close the palette, so every click
 * behaved like Esc and clicks "didn't work". parseMouse therefore returns
 * kind:'ignore' for consumed-but-not-click reports (press, drag, non-left
 * buttons) - NEVER null for a complete mouse report.
 *
 * X10 fallback (mode 1000 terminals without SGR): ESC[M + 3 raw bytes.
 * X10 has no per-button release; a left PRESS is treated as the click.
 */

/** Enable mouse tracking: 1000 (press/release/wheel) + 1002 (drag) + 1006 (SGR). */
export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** Disable all mouse tracking modes. */
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export interface ParsedMouse {
  kind: 'click' | 'wheel' | 'ignore';
  col: number; // 0-indexed terminal column
  row: number; // 0-indexed terminal row
  wheelUp: boolean; // wheel kind only
}

/** SGR mouse report: ESC[<btn;col;rowM (press) / m (release). */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Try to parse ONE mouse sequence from the head of the chunk.
 * Returns [event, rest-of-chunk] or null when the chunk does not START with
 * a complete mouse report. Complete-but-uninteresting reports (press, drag,
 * non-left buttons) return kind:'ignore' so the caller consumes them -
 * returning null for those is how v0.23.38 broke clicks.
 */
export function parseMouse(chunk: string): [ParsedMouse, string] | null {
  const m = SGR_MOUSE_RE.exec(chunk);
  if (m) {
    const button = parseInt(m[1], 10);
    const col = parseInt(m[2], 10) - 1; // SGR is 1-indexed, we 0-index
    const row = parseInt(m[3], 10) - 1;
    const isRelease = m[4] === 'm';
    const rest = chunk.slice(m[0].length);
    // wheel: button bit 6 set; low bits 0=up 1=down
    if ((button & 0x40) !== 0) {
      return [{ kind: 'wheel', col, row, wheelUp: (button & 0x01) === 0 }, rest];
    }
    // left button (low bits 0) RELEASE = click
    if ((button & 0x03) === 0 && isRelease) {
      return [{ kind: 'click', col, row, wheelUp: false }, rest];
    }
    // press / drag-motion / right / middle: consumed, no event
    return [{ kind: 'ignore', col, row, wheelUp: false }, rest];
  }
  // X10 legacy report: ESC[M + Cb/Cx/Cy raw bytes (each +32)
  if (chunk.startsWith('\x1b[M') && chunk.length >= 6) {
    const button = chunk.charCodeAt(3) - 32;
    const col = chunk.charCodeAt(4) - 32 - 1; // X10 coords are 1-indexed like SGR
    const row = chunk.charCodeAt(5) - 32 - 1;
    const rest = chunk.slice(6);
    if ((button & 0x40) !== 0) {
      return [{ kind: 'wheel', col, row, wheelUp: (button & 0x01) === 0 }, rest];
    }
    // X10 cannot say WHICH button released; a left PRESS is the best click
    // signal available (drag pairs would double-fire, motion bit excludes)
    if ((button & 0x20) === 0 && (button & 0x03) === 0) {
      return [{ kind: 'click', col, row, wheelUp: false }, rest];
    }
    return [{ kind: 'ignore', col, row, wheelUp: false }, rest];
  }
  return null;
}

/** True if the chunk LOOKS like the start of a mouse report (may be partial). */
export function isMousePrefix(chunk: string): boolean {
  return /^\x1b\[<\d+(?:;\d*){0,2}[Mm]?/.test(chunk)
    || /^\x1b\[<\d*$/.test(chunk)
    || chunk === '\x1b[M'.slice(0, chunk.length) && chunk.length >= 2; // partial X10 head
}

// ---- clickable-region registry ----

export interface ClickRegion {
  row: number;
  colStart: number;
  colEnd: number;
  fn: () => void;
  /** higher z wins when regions overlap (later registrations = drawn on top) */
  z: number;
}

let regions: ClickRegion[] = [];
let zCounter = 0;

/** Clear the registry — call at the START of each render frame. */
export function clearRegions(): void {
  regions = [];
  zCounter = 0;
}

/**
 * Register a clickable region. The renderer calls this while drawing each
 * interactive element; z-order follows registration order (later = on top).
 */
export function addClickRegion(row: number, colStart: number, colEnd: number, fn: () => void): void {
  regions.push({ row, colStart, colEnd, fn, z: zCounter++ });
}

/**
 * Dispatch a click at terminal (col, row). The highest-z region containing
 * the point wins; returns true if any region consumed the click.
 */
export function dispatchClick(col: number, row: number): boolean {
  const hits = regions.filter((r) => r.row === row && col >= r.colStart && col <= r.colEnd);
  if (hits.length === 0) return false;
  hits.sort((a, b) => b.z - a.z)[0].fn();
  return true;
}

/** Test helper: current region count. */
export function regionCount(): number {
  return regions.length;
}
