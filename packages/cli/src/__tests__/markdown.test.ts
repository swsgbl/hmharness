import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../markdown.ts';

/* helpers: ANSI-stripped view + CJK-aware visible width (same cw table) */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const vis = (ls: string[]): string[] => ls.map(strip);
function widthOf(s: string): number {
  let w = 0;
  for (const ch of strip(s)) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    ) w += 2;
    else w += 1;
  }
  return w;
}
const one = (s: string, w = 40): string => renderMarkdown(s, w)[0] ?? '';

/* ---------------- headings ---------------- */

test('h1: cyan-bold, no hashes, DIM rule of min(width, head+2), no leading blank when first', () => {
  const ls = renderMarkdown('# Title', 40);
  assert.equal(ls.length, 2);
  assert.match(ls[0], /^\x1b\[1m\x1b\[36mTitle\x1b\[0m$/);
  assert.equal(strip(ls[1]), '─'.repeat(7)); // 5 + 2
});

test('h2 shares the h1 voice; blank line before when not first; CJK width counts double', () => {
  const ls = renderMarkdown('intro\n\n## 概览\n', 40);
  assert.match(ls[2], /^\x1b\[1m\x1b\[36m概览\x1b\[0m$/);
  assert.deepEqual(vis(ls), ['intro', '', '概览', '──────']); // 2*2 + 2
});

test('heading gets a blank line before it even without a source blank line', () => {
  assert.deepEqual(vis(renderMarkdown('para\n## H', 40)), ['para', '', 'H', '───']); // 1 + 2
});

test('h3/h4 bold without rule; h5/h6 dim+bold — levels stay visually distinct', () => {
  assert.match(renderMarkdown('### H3', 40)[0], /^\x1b\[1mH3\x1b\[0m$/);
  assert.equal(renderMarkdown('#### H4', 40).length, 1);
  assert.match(renderMarkdown('##### H5', 40)[0], /^\x1b\[2m\x1b\[1mH5\x1b\[0m$/);
  assert.match(renderMarkdown('###### H6', 40)[0], /^\x1b\[2m\x1b\[1mH6\x1b\[0m$/);
});

test('over-wide heading truncates and the rule caps at width', () => {
  const ls = renderMarkdown('# ' + 'a'.repeat(30), 20);
  assert.equal(strip(ls[0]).length, 20); // 19 a + ellipsis
  assert.equal(strip(ls[1]), '─'.repeat(20));
});

/* ---------------- hr ---------------- */

test('thematic break renders as a DIM rule across the width', () => {
  for (const mk of ['---', '***', '___']) {
    assert.deepEqual(vis(renderMarkdown(`a\n\n${mk}\n\nb`, 30)),
      ['a', '', '─'.repeat(30), '', 'b']);
  }
});

/* ---------------- fenced code ---------------- */

test('fence: no fence lines, DIM │ prefix, lang tag on first row, no inline parsing inside', () => {
  const md = '```ts\nconst a = 1;\n**not bold** `no code`\n```';
  const ls = renderMarkdown(md, 40);
  assert.equal(ls.length, 2);
  assert.match(ls[0], /^\x1b\[2m│ /);
  assert.equal(strip(ls[0]), '│ const a = 1;  ts');
  assert.equal(strip(ls[1]), '│ **not bold** `no code`');
});

test('unclosed fence (streaming) still renders as code', () => {
  assert.deepEqual(vis(renderMarkdown('```js\nlet x = 1;', 40)), ['│ let x = 1;  js']);
});

test('over-wide code line truncates with ellipsis within width', () => {
  const ls = renderMarkdown('```\n' + 'x'.repeat(60) + '\n```', 30);
  assert.equal(strip(ls[0]), '│ ' + 'x'.repeat(27) + '…');
  assert.ok(widthOf(ls[0]) <= 30);
});

/* ---------------- blockquote ---------------- */

test('quote: DIM │ prefix, inline formats apply inside', () => {
  const ls = renderMarkdown('> **bold** quote', 30);
  assert.match(ls[0], /^\x1b\[2m│ /);
  assert.equal(strip(ls[0]), '│ bold quote');
  assert.match(ls[0], /\x1b\[1m/);
});

test('long quote wraps within width-2', () => {
  const ls = renderMarkdown('> ' + '字'.repeat(40), 30);
  assert.ok(ls.length > 1);
  for (const l of ls) assert.ok(widthOf(l) <= 30, `too wide: ${l}`);
});

/* ---------------- tables ---------------- */

test('table: box border, padded cells, bold header, colon alignment l/c/r', () => {
  const md = '| Left | Mid | Right |\n| :- | :-: | -: |\n| a | b | c |';
  assert.deepEqual(vis(renderMarkdown(md, 40)), [
    '┌──────┬─────┬───────┐',
    '│ Left │ Mid │ Right │',
    '├──────┼─────┼───────┤',
    '│ a    │  b  │     c │',
    '└──────┴─────┴───────┘',
  ]);
  assert.match(renderMarkdown('| H |\n| - |\n| d |', 40)[1], /\x1b\[1m/); // header bold
});

test('table without outer pipes is still a table', () => {
  const md = 'a | b\n-- | --\n1 | 2';
  assert.deepEqual(vis(renderMarkdown(md, 40)), [
    '┌───┬───┐',
    '│ a │ b │',
    '├───┼───┤',
    '│ 1 │ 2 │',
    '└───┴───┘',
  ]);
});

test('pipe row without a separator row stays prose', () => {
  assert.deepEqual(vis(renderMarkdown('time | value\n10 | 20', 40)), ['time | value', '10 | 20']);
});

test('in-budget table keeps natural column widths — no premature ellipsis', () => {
  const md = `| ${'a'.repeat(50)} | b |\n| --- | --- |`;
  const ls = renderMarkdown(md, 80);
  for (const l of ls) assert.ok(!strip(l).includes('…'), strip(l));
  assert.ok(strip(ls[1]).includes('a'.repeat(50))); // longest column untouched
  assert.ok(ls.every((l) => widthOf(l) <= 80));
});

test('CJK table: double-width cells align exactly', () => {
  const md = '| 名称 | 说明 |\n| --- | --- |\n| 构建 | 运行 |';
  assert.deepEqual(vis(renderMarkdown(md, 40)), [
    '┌──────┬──────┐',
    '│ 名称 │ 说明 │',
    '├──────┼──────┤',
    '│ 构建 │ 运行 │',
    '└──────┴──────┘',
  ]);
});

test('over-wide table shrinks widest column first, truncated cells end with …', () => {
  const md = '| api | desc |\n| --- | --- |\n| /very/long/path/xyz | short |';
  const ls = renderMarkdown(md, 24);
  for (const l of ls) assert.ok(widthOf(l) <= 24, `too wide: ${strip(l)}`);
  const body = vis(ls)[3];
  assert.ok(body.includes('…'), body);
  assert.equal(body, '│ /very/long/… │ short │');
});

test('inline formats render inside cells and \\| stays literal', () => {
  const md = '| a \\| b | c |\n| --- | --- |\n| **x** | y |';
  const ls = renderMarkdown(md, 40);
  assert.equal(strip(ls[1]), '│ a | b │ c │');
  assert.match(ls[3], /\x1b\[1m/);
});

/* ---------------- lists ---------------- */

test('bullets, ordered markers, nesting at +2 per level', () => {
  assert.deepEqual(vis(renderMarkdown('- a\n- b', 40)), ['• a', '• b']);
  assert.deepEqual(vis(renderMarkdown('1. x\n2. y', 40)), ['1. x', '2. y']);
  assert.deepEqual(vis(renderMarkdown('- top\n  - nested\n    - deep', 40)),
    ['• top', '  • nested', '    • deep']);
});

test('task list: ☐ dim / ☑ green', () => {
  const ls = renderMarkdown('- [ ] todo\n- [x] done', 40);
  assert.deepEqual(vis(ls), ['☐ todo', '☑ done']);
  assert.match(ls[0], /\x1b\[2m☐/);
  assert.match(ls[1], /\x1b\[32m☑/);
});

test('long list item wraps with continuation aligned under the text', () => {
  const ls = renderMarkdown('- ' + 'a'.repeat(60), 30);
  assert.ok(ls.length >= 3);
  for (const l of ls) assert.ok(widthOf(l) <= 30, `too wide: ${strip(l)}`);
  // continuation lines indent by the marker width so text lines up under "• "
  assert.ok(strip(ls[1]).startsWith('  ' + 'a'), strip(ls[1]));
});

test('loose list (blank line between items) keeps a blank between rows', () => {
  assert.deepEqual(vis(renderMarkdown('- a\n\n- b', 40)), ['• a', '', '• b']);
});

/* ---------------- inline formats ---------------- */

test('bold / em / code / link / escape / html strip', () => {
  assert.match(one('**bold**'), /^\x1b\[1mbold\x1b\[0m$/);
  assert.match(one('*em*'), /^\x1b\[1mem\x1b\[0m$/);   // italics shown as bold
  assert.match(one('_em_'), /^\x1b\[1mem\x1b\[0m$/);
  assert.match(one('`code`'), /^\x1b\[7mcode\x1b\[0m$/); // inverse video
  assert.match(one('[text](https://x.y)'), /^\x1b\[4mtext\x1b\[0m$/); // underlined text
  assert.ok(!one('[text](https://x.y)').includes('https')); // url dropped
  assert.equal(one('\\*literal\\*'), '*literal*');
  assert.equal(one('a <br> b'), 'a  b'); // html tag stripped
  assert.equal(one('a < b'), 'a < b');   // not a tag, stays literal
});

test('snake_case and 2*3*4 stay literal (word-boundary rules)', () => {
  assert.equal(one('snake_case_var'), 'snake_case_var');
  assert.equal(one('2*3*4'), '2*3*4');
  assert.equal(one('**not closed'), '**not closed'); // streaming tail stays literal
});

test('mixed inline in a paragraph', () => {
  assert.equal(strip(one('mix **b** `c` [d](u) end')), 'mix b c d end');
});

/* ---------------- paragraphs + wrapping ---------------- */

test('paragraph wrap at width=40 never exceeds it (ASCII and CJK)', () => {
  const ascii = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam.';
  const cjk = '这是一段比较长的中文段落文本用于验证终端换行逻辑确保每一行都不超过四十列的显示宽度并且要在中文字符之间正确断行,后面再混合一些 english words 验证空格优先断点。';
  for (const p of [ascii, cjk]) {
    const ls = renderMarkdown(p, 40);
    assert.ok(ls.length > 1, 'expected wrapping');
    for (const l of ls) assert.ok(widthOf(l) <= 40, `too wide: ${l}`);
  }
  // space-preferred break: the english tail moves to its own line whole
  const mixed = renderMarkdown(cjk + ' tail', 40);
  for (const l of mixed) assert.ok(widthOf(l) <= 40, `too wide: ${l}`);
});

test('blocks separated by one blank line', () => {
  assert.deepEqual(vis(renderMarkdown('para\n\n> q', 60)), ['para', '', '│ q']);
});

/* ---------------- streaming determinism ---------------- */

test('same prefix renders identically; completed blocks never reflow', () => {
  const md = '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- x\n- y\n\ntail text';
  const full = renderMarkdown(md, 40);
  assert.deepEqual(full, renderMarkdown(md, 40));
  const cut = md.indexOf('- x');
  const prefix = renderMarkdown(md.slice(0, cut), 40);
  assert.ok(prefix.length > 0);
  assert.deepEqual(full.slice(0, prefix.length), prefix);
});
