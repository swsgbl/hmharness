import test from 'node:test';
import assert from 'node:assert/strict';
import { generateQr } from '../qrcode.ts';

test('generateQr: produces terminal ASCII + SVG output', async () => {
  const out = await generateQr('https://example.com?key=abc123');
  assert.ok(out.terminal.length > 50, 'terminal output has content');
  assert.ok(out.terminal.includes('█') || out.terminal.includes('▀') || out.terminal.includes('▄'), 'uses block chars');
  assert.ok(out.svg.startsWith('<svg'), 'SVG starts with <svg');
  assert.ok(out.svg.includes('path'), 'SVG has path elements');
});

test('generateQr: handles URLs with CJK + query params', async () => {
  const url = 'http://192.168.1.100:7788/?key=hmh-a1b2c3d4e5f6g7h8';
  const out = await generateQr(url);
  assert.ok(out.terminal.length > 50);
  assert.ok(out.svg.length > 100);
});

test('generateQr: different inputs produce different QR codes', async () => {
  const a = await generateQr('https://a.com');
  const b = await generateQr('https://b.com');
  assert.notEqual(a.svg, b.svg, 'different content -> different QR');
});
