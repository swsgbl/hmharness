import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRow, initialPickerState, matchesQuery, pickerKey, reducePicker, relTime, toolbarLine, visibleRows,
  type PickerState,
} from '../resume-picker.ts';
import type { SessionSummary } from '@hmharness/kernel';

const row = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: '2026-09-12T17-30-05-a1b2c3',
  file: '/x/rollout.jsonl',
  title: 'run a harmless command',
  cwd: 'G:/proj/hmharness',
  model: 'm',
  branch: 'main',
  createdAt: '2026-09-12T09:30:05.000Z',
  updatedAt: '2026-09-12T17:30:05.000Z',
  ...over,
});

test('matchesQuery: lowercase substring across title/id/cwd/branch', () => {
  const r = row();
  assert.ok(matchesQuery(r, 'harmless'));
  assert.ok(matchesQuery(r, 'HARM'));
  assert.ok(matchesQuery(r, '2026-09-12'));   // id prefix
  assert.ok(matchesQuery(r, 'hmharness'));    // cwd
  assert.ok(matchesQuery(r, 'main'));         // branch
  assert.ok(matchesQuery(r, ''));
  assert.ok(!matchesQuery(r, 'zebra'));
  // missing branch must not crash
  assert.ok(matchesQuery(row({ branch: undefined }), 'harmless'));
});

test('pickerKey normalizes arrows, SS3 and printable chars', () => {
  assert.equal(pickerKey('\x1b[A'), 'up');
  assert.equal(pickerKey('\x1bOB'), 'down'); // SS3 application-mode arrow
  assert.equal(pickerKey('\r'), 'enter');
  assert.equal(pickerKey('\x1b'), 'esc');
  assert.equal(pickerKey('\t'), 'tab');
  assert.equal(pickerKey('\x1b[C'), 'right');
  assert.equal(pickerKey('\x1b[D'), 'left');
  assert.equal(pickerKey('\x7f'), 'backspace');
  assert.equal(pickerKey('\x03'), 'ctrl-c');
  assert.equal(pickerKey('a'), 'char:a');
  assert.equal(pickerKey('中'), 'char:中');
  assert.equal(pickerKey('\x1b[200~'), null); // paste bracket - runtime's business
});

test('reducePicker: typing filters and resets selection, Esc clears then closes', () => {
  let st: PickerState = { ...initialPickerState(), rows: [row(), row({ id: '2026-09-12T15-00-00-zz', title: 'check toolchain' })], nextCursor: null, loading: false, initial: false };
  st = reducePicker(st, 'down').state;
  assert.equal(st.selected, 1);
  // type a query matching only row 2: selection resets to the first hit
  st = reducePicker(st, 'char:c').state;
  st = reducePicker(st, 'char:h').state;
  assert.equal(visibleRows(st).length, 1);
  assert.equal(visibleRows(st)[0].title, 'check toolchain');
  assert.equal(st.selected, 0);
  // Esc with a query clears it (codex), second Esc closes
  const cleared = reducePicker(st, 'esc');
  assert.equal(cleared.state.query, '');
  assert.equal(cleared.effect.kind, 'none');
  assert.equal(reducePicker(cleared.state, 'esc').effect.kind, 'close');
});

test('reducePicker: Tab cycles toolbar focus, arrows change the value and reload', () => {
  let st = initialPickerState('updated', true);
  st = { ...st, rows: [row()], nextCursor: null, loading: false, initial: false };
  st = reducePicker(st, 'tab').state;            // focus -> sort
  assert.equal(st.focus, 1);
  const changed = reducePicker(st, 'right');      // updated -> created
  assert.equal(changed.state.sort, 'created');
  assert.deepEqual(changed.effect, { kind: 'reload' });
  assert.equal(changed.state.rows.length, 0);     // reload starts from page 1
  st = reducePicker(changed.state, 'tab').state;  // focus -> filter
  const all = reducePicker(st, 'right');          // Cwd -> All
  assert.equal(all.state.cwdOnly, false);
  assert.deepEqual(all.effect, { kind: 'reload' });
});

test('reducePicker: Enter accepts the highlighted row, near-end moves page', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ id: `2026-09-12T17-30-${String(i).padStart(2, '0')}-x`, title: 'task ' + i }));
  let st: PickerState = { ...initialPickerState(), rows, nextCursor: 'tok', loading: false, initial: false };
  // jump near the end -> load-more fires (codex LOAD_NEAR_THRESHOLD = 5)
  for (let i = 0; i < 25; i++) st = reducePicker(st, 'down').state;
  const nearEnd = reducePicker(st, 'down');
  assert.equal(nearEnd.effect.kind, 'load-more');
  // Enter on the selected row accepts it
  const acc = reducePicker(nearEnd.state, 'enter');
  assert.equal(acc.effect.kind, 'accept');
  assert.equal(acc.effect.kind === 'accept' && acc.effect.row.title.startsWith('task '), true);
  // Enter with no visible rows is a no-op
  const empty = reducePicker({ ...initialPickerState(), rows: [], nextCursor: null, loading: false, initial: false }, 'enter');
  assert.equal(empty.effect.kind, 'none');
});

test('reducePicker: query with no local match keeps searching while pages remain', () => {
  let st: PickerState = { ...initialPickerState(), rows: [row()], nextCursor: 'tok', loading: false, initial: false };
  const r = reducePicker(st, 'char:z');
  assert.equal(r.state.query, 'z');
  assert.equal(r.effect.kind, 'search-more');
  // no cursor left -> nothing more to search
  const done = reducePicker({ ...st, nextCursor: null }, 'char:z');
  assert.equal(done.effect.kind, 'none');
});

test('formatRow: marker, id prefix, title ellipsis, relative time', () => {
  const r = row({ updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
  const sel = formatRow(r, true, 60);
  const un = formatRow(r, false, 60);
  assert.ok(sel.startsWith('❯ '));
  assert.ok(un.startsWith('  '));
  assert.ok(sel.includes('2026-09-12T17-30'));
  assert.ok(sel.includes('run a harmless'));
  assert.ok(sel.trimEnd().endsWith('3h'));
  // narrow width truncates the title with an ellipsis, never crashes
  const narrow = formatRow(r, true, 24);
  assert.ok(narrow.includes('…'));
});

test('relTime buckets', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  assert.equal(relTime('2026-09-13T11:59:30Z', now), 'now');
  assert.equal(relTime('2026-09-13T11:30:00Z', now), '30m');
  assert.equal(relTime('2026-09-13T08:00:00Z', now), '4h');
  assert.equal(relTime('2026-09-09T12:00:00Z', now), '4d');
  assert.equal(relTime('garbage', now), '');
});

test('toolbarLine: query left, controls right, focused control painted', () => {
  const st = initialPickerState('updated', true);
  let focused = '';
  let unfocused = '';
  const line = toolbarLine(st, { filter: 'Filter', sort: 'Sort', cwd: 'Cwd', all: 'All', updated: 'Updated', created: 'Created' }, 60, (s, on) => {
    if (on) focused = s; else unfocused = s;
    return s;
  });
  assert.ok(line.startsWith('_'));
  assert.equal(focused, 'Filter:[Cwd]');
  assert.equal(unfocused, 'Sort:[Updated]');
  assert.ok(line.includes('Filter:[Cwd]'));
});
