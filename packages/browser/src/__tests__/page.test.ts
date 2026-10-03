import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickExpr, typeExpr, scrollExpr, parseSnapshot, parseRead, formatSnapshot, SNAPSHOT_EXPR, READ_EXPR } from '../page.ts';
import { startBrowser } from '../lifecycle.ts';
import { discoverBrowsers } from '../registry.ts';

test('page: clickExpr/typeExpr target the stamped ref and escape payloads', () => {
  assert.match(clickExpr(3), /\[data-hmh-ref="3"\]/);
  assert.match(clickExpr(3), /E_NO_REF/);
  const expr = typeExpr(2, 'he said "hi" \\ bye', true);
  assert.match(expr, /\[data-hmh-ref="2"\]/);
  assert.ok(expr.includes('he said \\"hi\\" \\\\ bye')); // JSON-escaped into the expression
  assert.match(expr, /if \(true\)/); // submit branch live
  assert.match(expr, /requestSubmit/);
  assert.match(typeExpr(2, 'x', false), /if \(false\)/); // submit branch dead
  assert.match(typeExpr(5, 'x'), /dispatchEvent\(new Event\('input'/);
});

test('page: scrollExpr clamps unknown directions to down', () => {
  assert.match(scrollExpr('down'), /scrollBy\(0, 600\)/);
  assert.match(scrollExpr('up'), /scrollBy\(0, -600\)/);
  assert.match(scrollExpr('top'), /scrollTo\(0, 0\)/);
  assert.match(scrollExpr('bottom'), /scrollTo\(0, document\.body\.scrollHeight\)/);
  assert.match(scrollExpr('diagonal'), /scrollBy\(0, 600\)/);
});

test('page: parseSnapshot/parseRead validate and formatSnapshot renders refs', () => {
  const snap = parseSnapshot(JSON.stringify({
    title: 'Example',
    url: 'https://example.com',
    elements: [
      { ref: 1, tag: 'a', text: 'More information', href: 'https://www.iana.org/domains/example' },
      { ref: 2, tag: 'input', placeholder: 'Search', role: 'searchbox' },
    ],
  }));
  assert.equal(snap.elements.length, 2);
  const text = formatSnapshot(snap);
  assert.match(text, /\[1\] a "More information" -> https:\/\/www\.iana\.org/);
  assert.match(text, /\[2\] input role=searchbox placeholder="Search"/);
  assert.throws(() => parseSnapshot('not json'));
  assert.throws(() => parseSnapshot({ odd: true }));
  assert.throws(() => parseSnapshot(JSON.stringify({ title: 'x', url: 'y' }))); // no elements array
  const read = parseRead(JSON.stringify({ title: 't', url: 'u', text: 'body text', truncated: false }));
  assert.equal(read.text, 'body text');
  assert.throws(() => parseRead(42));
  // expression sources stamp refs + never leak password values
  assert.match(SNAPSHOT_EXPR, /data-hmh-ref/);
  assert.match(SNAPSHOT_EXPR, /kind !== 'password'/);
  assert.match(READ_EXPR, /12000/);
});

test('lifecycle: startBrowser fails honestly when no BrowserOS exists (install URL shown, never auto-downloaded)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'browser-life-'));
  // hermetic: no install roots, and PATH pointed at a dir with no binaries
  const savedPath = process.env.PATH;
  process.env.PATH = home;
  try {
    discoverBrowsers(true, { roots: [join(home, 'nope', 'BrowserOS.exe')] });
    await assert.rejects(
      () => startBrowser(home, { port: 19223 }),
      /BrowserOS not found[\s\S]*browseros\.com/,
    );
  } finally {
    process.env.PATH = savedPath;
    await rm(home, { recursive: true, force: true });
  }
});
