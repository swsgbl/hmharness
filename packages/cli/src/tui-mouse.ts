/**
 * @hmharness/cli - tui-mouse (2026-10-22, dsh-TUI style mouse support)
 *
 * SGR mouse tracking (DECSET 1000+1002+1006): the terminal reports
 * ESC[<button;col;row M (press) / m (release) sequences. This module
 * parses them, maintains a clickable-region registry populated during
 * render, and dispatches clicks on left-button release (dsh-TUI's click
 * contract: release without drag = click).
 *
 * Region registration: the renderer registers (row, colStart, colEnd, fn)
 * for each interactive element while drawing. Regions are cleared at the
 * start of every frame, so the registry is always one frame fresh.
 */

/** Enable SGR mouse tracking (click + drag + wheel). */
export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** Disable all mouse tracking modes. */
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export interface ParsedMouse {
  kind: 'click' | 'wheel';
  col: number; // 0-indexed terminal column
  row: number; // 0-indexed terminal row
  wheelUp: boolean; // wheel kind only
}

/** SGR mouse report: ESC[<btn;col;rowM (press) / m (release). */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Try to parse an SGR mouse sequence from the head of the input chunk.
 * Returns [event, rest-of-chunk] or null if the chunk doesn't start with one.
 * ConPTY can split reports across stdin reads; a partial prefix
 * (ESC[<digits;) is held by the caller until more data arrives.
 */
export function parseMouse(chunk: string): [ParsedMouse, string] | null {
  const m = SGR_MOUSE_RE.exec(chunk);
  if (!m) return null;
  const button = parseInt(m[1], 10);
  const col = parseInt(m[2], 10) - 1; // SGR is 1-indexed, we 0-index
  const row = parseInt(m[3], 10) - 1;
  const isRelease = m[4] === 'm';
  const rest = chunk.slice(m[0].length);

  // wheel: button bit 6 set (0x40), low bits 0=up 1=down
  if ((button & 0x40) !== 0) {
    return [{ kind: 'wheel', col, row, wheelUp: (button & 0x01) === 0 }, rest];
  }
  // left-button (button bits 0-1 = 0) release = click
  if ((button & 0x03) === 0 && isRelease) {
    return [{ kind: 'click', col, row, wheelUp: false }, rest];
  }
  // press events, right/middle button, drag-motion: consumed silently
  return null;
}

/** True if the chunk LOOKS like the start of a mouse report (may be partial). */
export function isMousePrefix(chunk: string): boolean {
  // complete report or a partial prefix (ConPTY fragmentation)
  return /^\x1b\[<\d+(?:;\d*){0,2}[Mm]?/.test(chunk) || /^\x1b\[<\d*$/.test(chunk);
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
