/**
 * Codex-style resume picker (transplant of codex-rs/tui/src/resume_picker.rs,
 * trimmed to hmharness's surface). This module is the pure state machine +
 * formatting; TuiRuntime owns rendering and key plumbing. Codex behaviors kept:
 *  - typeahead: case-insensitive substring across title/id/cwd/branch
 *    (codex Row::matches_query)
 *  - toolbar Filter[Cwd|All] x Sort[Updated|Created], Tab cycles focus,
 *    arrows change the focused value, changes trigger a reload
 *    (codex toggle_sort_key / SessionFilterMode)
 *  - Enter accepts, Esc clears the query first then closes, Backspace pops
 *    (codex handle_key)
 *  - paging: rows arrive page by page; moving within LOAD_NEAR_THRESHOLD of
 *    the end asks for the next page (codex maybe_load_more_for_scroll);
 *    a query that matches nothing loaded yet keeps searching forward
 *    (codex SearchState::Active)
 */
import type { SessionSummary } from '@hmharness/kernel';

export type PickerSort = 'updated' | 'created';
/** 0 = filter control, 1 = sort control (codex toolbar Tab cycle) */
export type PickerFocus = 0 | 1;

const LOAD_NEAR = 5; // codex LOAD_NEAR_THRESHOLD

export interface PickerState {
  query: string;
  rows: SessionSummary[];
  selected: number;
  sort: PickerSort;
  cwdOnly: boolean;
  focus: PickerFocus;
  /** next listSessions cursor; null = scan complete */
  nextCursor: string | null;
  /** a (re)load is in flight - renders the loading markers */
  loading: boolean;
  /** true before the first page lands (initial vs empty-result states) */
  initial: boolean;
}

export function initialPickerState(sort: PickerSort = 'updated', cwdOnly = true): PickerState {
  return { query: '', rows: [], selected: 0, sort, cwdOnly, focus: 0, nextCursor: null, loading: true, initial: true };
}

/** codex Row::matches_query: lowercase substring across every display field. */
export function matchesQuery(row: SessionSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.title, row.id, row.cwd, row.branch ?? ''].some((f) => f.toLowerCase().includes(needle));
}

export function visibleRows(state: PickerState): SessionSummary[] {
  return state.query ? state.rows.filter((r) => matchesQuery(r, state.query)) : state.rows;
}

export type PickerEffect =
  | { kind: 'none' }
  | { kind: 'reload' }      // toolbar changed - restart the listing from page 1
  | { kind: 'load-more' }   // selection near the end - fetch the next page
  | { kind: 'search-more' } // no local match - keep scanning pages for the query
  | { kind: 'accept'; row: SessionSummary }
  | { kind: 'close' };

/** Normalize a raw stdin chunk to the picker's key vocabulary; anything the
 *  picker does not own returns null so the caller leaves it to the runtime. */
export function pickerKey(data: string): string | null {
  if (/^\x1bO[A-H]$/.test(data)) data = '\x1b[' + data[2]; // SS3 arrows, same as TuiRuntime
  if (data === '\x1b[A' || data === '\x1b[B') return data === '\x1b[A' ? 'up' : 'down';
  if (data === '\r') return 'enter';
  if (data === '\x1b') return 'esc';
  if (data === '\t') return 'tab';
  if (data === '\x1b[C') return 'right';
  if (data === '\x1b[D') return 'left';
  if (data === '\x7f' || data === '\b') return 'backspace';
  if (data === '\x03') return 'ctrl-c';
  // single printable char (no modifiers) feeds the typeahead
  if (data.length === 1 && data >= ' ') return 'char:' + data;
  return null;
}

export function reducePicker(state: PickerState, key: string): { state: PickerState; effect: PickerEffect } {
  const next: PickerState = { ...state, rows: state.rows };
  if (key.startsWith('char:')) {
    next.query += key.slice(5);
    next.selected = 0;
    const vis = visibleRows(next);
    return {
      state: next,
      effect: vis.length === 0 && next.nextCursor ? { kind: 'search-more' } : { kind: 'none' },
    };
  }
  switch (key) {
    case 'backspace':
      if (next.query) next.query = next.query.slice(0, -1);
      next.selected = 0;
      return { state: next, effect: { kind: 'none' } };
    case 'up': {
      const vis = visibleRows(next);
      if (vis.length === 0) return { state: next, effect: { kind: 'none' } };
      next.selected = Math.max(0, next.selected - 1);
      return { state: next, effect: nearEnd(next) };
    }
    case 'down': {
      const vis = visibleRows(next);
      if (vis.length === 0) return { state: next, effect: next.nextCursor ? { kind: 'search-more' } : { kind: 'none' } };
      next.selected = Math.min(vis.length - 1, next.selected + 1);
      return { state: next, effect: nearEnd(next) };
    }
    case 'tab':
      next.focus = next.focus === 0 ? 1 : 0;
      return { state: next, effect: { kind: 'none' } };
    case 'left':
    case 'right': {
      if (next.focus === 0) next.cwdOnly = key === 'left'; // left -> Cwd, right -> All
      else next.sort = next.sort === 'updated' ? 'created' : 'updated';
      next.selected = 0;
      next.rows = [];
      next.nextCursor = null;
      next.loading = true;
      next.initial = true;
      return { state: next, effect: { kind: 'reload' } };
    }
    case 'enter': {
      const vis = visibleRows(next);
      if (vis.length === 0) return { state: next, effect: { kind: 'none' } };
      return { state: next, effect: { kind: 'accept', row: vis[Math.min(next.selected, vis.length - 1)] } };
    }
    case 'esc':
      // codex: query non-empty -> clear it; empty -> exit
      if (next.query) {
        next.query = '';
        next.selected = 0;
        return { state: next, effect: { kind: 'none' } };
      }
      return { state: next, effect: { kind: 'close' } };
    case 'ctrl-c':
      return { state: next, effect: { kind: 'close' } };
    default:
      return { state: next, effect: { kind: 'none' } };
  }
}

function nearEnd(state: PickerState): PickerEffect {
  const vis = visibleRows(state);
  if (state.nextCursor && !state.loading && state.selected >= vis.length - LOAD_NEAR) return { kind: 'load-more' };
  return { kind: 'none' };
}

/** "2m" / "3h" / "4d" relative time for the row tail. */
export function relTime(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

/** One list row: `❯ 2026-09-12T17-30  run a harmless command      2h`.
 *  The id prefix (filename timestamp - codex shows the same) is the anchor
 *  the eye scans by; the title truncates into the remaining width. */
export function formatRow(row: SessionSummary, selected: boolean, width: number): string {
  const marker = selected ? '❯ ' : '  ';
  const id = row.id.slice(0, 16);
  const title = (row.title || '').replace(/\s+/g, ' ').trim();
  const ago = relTime(row.updatedAt);
  const titleWidth = Math.max(8, width - marker.length - id.length - 2 - ago.length - 1);
  const shown = title.length > titleWidth ? title.slice(0, titleWidth - 1) + '…' : title.padEnd(titleWidth);
  return `${marker}${id}  ${shown} ${ago}`;
}

/** The search line: `query_` plus the toolbar on the right
 *  (codex: `Filter:[Cwd]  Sort:[Updated]`, focused control highlighted). */
export function toolbarLine(
  state: PickerState,
  labels: { filter: string; sort: string; cwd: string; all: string; updated: string; created: string },
  width: number,
  paint: (s: string, on: boolean) => string,
): string {
  const f = `${labels.filter}:[${state.cwdOnly ? labels.cwd : labels.all}]`;
  const s = `${labels.sort}:[${state.sort === 'updated' ? labels.updated : labels.created}]`;
  const bar = `${f}  ${s}`;
  const room = Math.max(0, width - bar.length - 2);
  const q = (state.query + '_').slice(0, room);
  const pad = ' '.repeat(Math.max(1, room - q.length));
  return q + pad + (state.focus === 0 ? paint(f, true) + '  ' + paint(s, false) : paint(f, false) + '  ' + paint(s, true));
}
