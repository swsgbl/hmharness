import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFramePng, gridSummary, ARC3_PALETTE } from '../arc3-render.ts';

test('renderer: valid PNG (signature + IHDR dims + IEND)', () => {
  const grid = [[0, 0, 1], [1, 2, 3]];
  const png = renderFramePng([grid, grid], 2);
  assert.ok(png, 'renders a pair');
  // PNG signature
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR width/height: 2 grids of 3 cells wide + 4-cell gutter = 10 cells * scale2 = 20px; 2 rows * 2 = 4px
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  assert.equal(w, 20);
  assert.equal(h, 4);
  // ends with IEND
  assert.equal(png.readUInt32BE(png.length - 8), 0x49454e44);
});

test('renderer: jagged rows and empty input handled honestly', () => {
  const jagged = [[1, 2, 3, 4, 5], [9], [], [14, 14]];
  const png = renderFramePng([jagged], 1);
  assert.ok(png);
  assert.equal(png.readUInt32BE(16), 5); // widest row wins
  assert.equal(png.readUInt32BE(20), 4);
  assert.equal(renderFramePng('not a frame'), null);
  assert.equal(renderFramePng([]), null);
});

test('renderer: palette is 16 distinct colors', () => {
  assert.equal(ARC3_PALETTE.length, 16);
  assert.equal(new Set(ARC3_PALETTE.map((c) => c.join(','))).size, 16);
});

test('gridSummary: compact run-length stats', () => {
  const grid = [[1, 1, 2], [2, 0]];
  const s = gridSummary(grid);
  assert.match(s, /2×3 cells/);
  assert.match(s, /2×2/); // color 2 appears twice
  assert.match(s, /1×2/); // color 1 twice
});
