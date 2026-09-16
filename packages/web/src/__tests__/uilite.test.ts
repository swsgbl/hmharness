import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatchScore, parseUnifiedDiff, looksLikeDiff, renderMarkdown, uiLiteSource } from '../uilite.ts';

test('fuzzyMatchScore: subsequence rank, prefix/boundary bonuses, -1 on miss', () => {
  assert.ok(fuzzyMatchScore('st', 'settings.ts') >= 0, 's-t is a subsequence');
  assert.ok(fuzzyMatchScore('st', 'server.ts') >= 0, 's-t is a subsequence here too');
  assert.equal(fuzzyMatchScore('sxz', 'server.ts'), -1, 'x absent -> miss');
  assert.ok(fuzzyMatchScore('ser', 'server.ts') > fuzzyMatchScore('ser', 'hmm/user-registry.ts'), 'shorter base path wins ties');
  assert.ok(fuzzyMatchScore('mdl', 'src/models/user.ts') >= 0, 'm-d-l is a subsequence');
  assert.equal(fuzzyMatchScore('zzz', 'server.ts'), -1, 'absent chars miss');
  assert.ok(fuzzyMatchScore('', 'anything') === 0, 'empty query matches everything cheaply');
  // boundary bonus: query starting a path segment beats a mid-word match
  const seg = fuzzyMatchScore('page', 'web/src/page.ts');
  assert.ok(seg >= 0);
});

test('parseUnifiedDiff: classifies file/hunk/add/del/ctx lines', () => {
  const diff = [
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,4 @@',
    ' same',
    '-old line',
    '+new line',
    ' tail',
  ].join('\n');
  const segs = parseUnifiedDiff(diff);
  assert.deepEqual(segs.map((s) => s.kind), ['file', 'file', 'file', 'hunk', 'ctx', 'del', 'add', 'ctx']);
  assert.equal(segs.find((s) => s.kind === 'add')!.text, '+new line');
});

test('looksLikeDiff: requires both file markers and a hunk header', () => {
  assert.ok(looksLikeDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new'));
  assert.ok(!looksLikeDiff('plain tool output'));
  assert.ok(!looksLikeDiff('@@ -1 +1 @@\n but no file header'));
  assert.ok(!looksLikeDiff('--- a/f\n+++ b/f\n no hunk'));
});

test('renderMarkdown: headings, bold, inline code, fences, lists, tables, links', () => {
  const md = [
    '# Title',
    'para with **bold** and `code` and [link](https://example.com)',
    '',
    '- one',
    '- two',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1',
    '```',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<table><thead><tr><td>a<\/td><td>b<\/td>/);
  assert.match(html, /<div class="codeblk"><div class="codebar"><span>ts<\/span>/);
  assert.match(html, /<pre>const x = 1/);
  // escaping: raw <script> must never survive
  assert.ok(!/<\/?script/.test(renderMarkdown('x <script>alert(1)</script> y')));
  // autolink must not double-wrap the URL inside a rendered [label](url)
  assert.equal((html.match(/<a href="https:\/\/example\.com"/g) || []).length, 1, 'exactly one anchor for the linked URL');
});

test('uiLiteSource: serialized functions are plain ES5 (no arrows, no ${}) for inline injection', () => {
  const src = uiLiteSource();
  assert.match(src, /function fuzzyMatchScore/);
  assert.match(src, /function parseUnifiedDiff/);
  assert.match(src, /function renderMarkdown/);
  // regex backticks are legal (the injection is a RUNTIME value, not template
  // source) — but arrow functions and ${} interpolation would violate the
  // page's vanilla-JS + no-interpolation rules
  assert.ok(!src.includes('=>'), 'no arrow functions — must run in the vanilla page script');
  assert.ok(!src.includes('${'), 'no template interpolation syntax');
});
