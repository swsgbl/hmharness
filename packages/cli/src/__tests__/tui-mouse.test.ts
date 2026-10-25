/**
 * tui-mouse tests (2026-10-22, dsh-TUI style): SGR mouse report parsing,
 * click region registration/dispatch, and the mouse-prefix detector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMouse, isMousePrefix, clearRegions, addClickRegion, dispatchClick, regionCount } from '../tui-mouse.ts';

test('parseMouse: SGR left-click release parses to a click event', () => {
  const [ev, rest] = parseMouse('\x1b[<0;33;12m')!;
  assert.equal(ev.kind, 'click');
  assert.equal(ev.col, 32, '0-indexed col (SGR is 1-indexed)');
  assert.equal(ev.row, 11, '0-indexed row');
  assert.equal(rest, '');
});

test('parseMouse: wheel up/down parse to wheel events', () => {
  const [up] = parseMouse('\x1b[<64;10;5M')!;
  assert.equal(up.kind, 'wheel');
  assert.equal(up.wheelUp, true, 'button 64 = wheel up');
  const [down] = parseMouse('\x1b[<65;10;5M')!;
  assert.equal(down.kind, 'wheel');
  assert.equal(down.wheelUp, false, 'button 65 = wheel down');
});

test('parseMouse: press events and non-left buttons consumed as ignore (NOT null — the v0.23.39 fix)', () => {
  // v0.23.38 BUG: returning null for press let the leading ESC leak into
  // key handling and close the palette. The fix: complete reports return
  // kind:'ignore' so the caller consumes them silently.
  const press = parseMouse('\x1b[<0;10;5M');
  assert.ok(press, 'press returns a result (not null)');
  assert.equal(press![0].kind, 'ignore', 'left press = consumed, not a click');
  const right = parseMouse('\x1b[<2;10;5m');
  assert.ok(right, 'right release returns a result');
  assert.equal(right![0].kind, 'ignore', 'right release = consumed, not a click');
  const drag = parseMouse('\x1b[<32;10;5M');
  assert.ok(drag, 'drag returns a result');
  assert.equal(drag![0].kind, 'ignore', 'drag motion = consumed, not a click');
});

test('parseMouse: returns the rest of the chunk after the report', () => {
  const [ev, rest] = parseMouse('\x1b[<0;5;5mabc')!;
  assert.equal(rest, 'abc');
});

test('isMousePrefix: detects complete and partial SGR reports', () => {
  assert.ok(isMousePrefix('\x1b[<0;33;12m'), 'complete report');
  assert.ok(isMousePrefix('\x1b[<0'), 'partial (ConPTY fragmentation)');
  assert.ok(!isMousePrefix('\x1b[A'), 'arrow key is not mouse');
  assert.ok(!isMousePrefix('hello'), 'text is not mouse');
});

test('click regions: register, dispatch, z-order (later wins)', () => {
  clearRegions();
  let clicked = 0;
  let topClicked = 0;
  addClickRegion(5, 0, 10, () => { clicked++; });
  addClickRegion(5, 0, 10, () => { topClicked++; }); // same area, later = on top
  assert.ok(dispatchClick(5, 5), 'click in region dispatches');
  assert.equal(topClicked, 1, 'the later (top) region fired');
  assert.equal(clicked, 0, 'the earlier region did not fire (z-order)');
  assert.ok(!dispatchClick(5, 7), 'click at a different row = no dispatch');
  assert.equal(regionCount(), 2);
});

test('click regions: cleared between frames', () => {
  clearRegions();
  assert.equal(regionCount(), 0);
  addClickRegion(1, 0, 5, () => {});
  assert.equal(regionCount(), 1);
  clearRegions();
  assert.equal(regionCount(), 0);
});
