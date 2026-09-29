/**
 * @hmharness/environments - ARC-AGI-3 frame renderer (blueprint §14)
 *
 * The live frame is [gridA, gridB] — typically before/after grids — each a
 * jagged array of rows whose cells are palette indices. We composite them
 * side by side into ONE truecolor PNG with a zero-dependency encoder
 * (zlib deflate + hand-built chunks), cells upscaled so the vision model
 * can actually SEE the game. The 16-color palette is a stable approximation
 * chosen for visual separability (exact official RGBs are not published in
 * the API docs); consistency across runs is what reasoning needs.
 */
import { deflateSync } from 'node:zlib';

/** 16 high-contrast colors indexed 0..15 (approximation, stable) */
export const ARC3_PALETTE: Array<[number, number, number]> = [
  [0, 0, 0],        // 0 black
  [0, 116, 255],    // 1 blue
  [255, 121, 0],    // 2 orange
  [156, 183, 41],   // 3 green
  [255, 0, 200],    // 4 magenta
  [0, 200, 255],    // 5 sky
  [128, 128, 128],  // 6 gray
  [230, 230, 230],  // 7 silver
  [165, 42, 42],    // 8 brown
  [255, 215, 0],    // 9 gold
  [0, 255, 140],    // 10 mint
  [255, 80, 80],    // 11 coral
  [80, 80, 255],    // 12 indigo
  [200, 255, 100],  // 13 lime
  [255, 160, 255],  // 14 pink
  [60, 60, 90],     // 15 slate
];

function cellColor(grid: number[][], x: number, y: number): [number, number, number] {
  const row = grid[y];
  if (!Array.isArray(row)) return ARC3_PALETTE[0];
  const v = Number(row[x]);
  return ARC3_PALETTE[Number.isInteger(v) && v >= 0 && v <= 15 ? v : 0];
}

/** Composite the frame's grids side-by-side (white gutter) into a PNG. */
export function renderFramePng(frame: unknown, scale = 8): Buffer | null {
  const grids = Array.isArray(frame) ? (frame as unknown[]).filter((g): g is number[][] => Array.isArray(g)) : [];
  if (grids.length === 0) return null;
  const heights = grids.map((g) => g.length);
  const widths = grids.map((g) => Math.max(1, ...g.map((r) => (Array.isArray(r) ? r.length : 0))));
  const cellH = Math.max(...heights, 1);
  const gutter = 4; // gutter cells between grids
  const totalCellsW = widths.reduce((s, w) => s + w, 0) + gutter * (grids.length - 1);
  const W = totalCellsW * scale;
  const H = cellH * scale;
  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let py = 0; py < H; py++) {
    raw[o++] = 0; // filter none
    const gy = Math.floor(py / scale);
    for (let px = 0; px < W; px++) {
      const gx = Math.floor(px / scale);
      // which grid and local x?
      let rem = gx;
      let gi = 0;
      while (gi < grids.length - 1 && rem >= widths[gi]) {
        rem -= widths[gi] + gutter;
        gi++;
      }
      const inGutter = rem >= widths[gi] || gi >= grids.length;
      let c: [number, number, number];
      if (inGutter || gy >= heights[gi]) c = [255, 255, 255];
      else c = cellColor(grids[gi], rem, gy);
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
    }
  }
  return encodePng(W, H, raw);
}

/** minimal zero-dependency truecolor PNG encoder */
function encodePng(width: number, height: number, rawData: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const chunks = [sig, chunk(0x49484452, ihdr), chunk(0x49444154, deflateSync(rawData)), chunk(0x49454e44, Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

function chunk(type: number, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.alloc(4);
  t.writeUInt32BE(type, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Describe the grid compactly for text-only models (color-run encoding). */
export function gridSummary(grid: number[][]): string {
  const palette = new Map<number, number>();
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const v of row) palette.set(Number(v), (palette.get(Number(v)) ?? 0) + 1);
  }
  const rows = grid.length;
  const cols = Math.max(1, ...grid.map((r) => (Array.isArray(r) ? r.length : 0)));
  const colors = [...palette.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`);
  return `${rows}×${cols} cells; colors: ${colors.join(' ')}`;
}
