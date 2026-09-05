/**
 * Website guard (scripts/check-website.cjs)
 * The marketing site (website/index.html) carries an inline i18n dictionary
 * (zh/en) and inline JS. This gate catches, before merge:
 *   1. a syntax error in any inline <script> block (edits to dict strings),
 *   2. data-i18n="key" references missing from either dictionary,
 *   3. zh/en dictionary key drift (one side missing a key -> undefined UI),
 *   4. a stale install command (quick start must ship the published
 *      `npm install -g @hmharness/cli`, not the old dev `npm link` flow).
 * Run locally: node scripts/check-website.cjs  (CI runs it on every push.)
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'website', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let fail = 0;

// 1. every inline <script> block must be syntactically valid JS
const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((s) => s.trim());
blocks.forEach((code, i) => {
  try { new Function(code); } catch (e) { console.log('SCRIPT-SYNTAX-FAIL block ' + i + ': ' + e.message); fail = 1; }
});
console.log('script blocks ok:', blocks.length);

// 2/3. data-i18n keys must exist in BOTH dictionaries; zh/en key sets identical.
// The dict lives in the first script block; eval the object literal directly
// (balanced-brace slice) so one-key-per-line formatting and colons inside
// translated strings cannot fool the parser.
const dictSrc = blocks.find((b) => b.includes('data-i18n') || b.includes('I18N') || b.includes('ins_title')) || blocks[0] || '';
function keysOf(name) {
  const start = dictSrc.search(new RegExp('\\b' + name + '\\s*:\\s*\\{'));
  if (start < 0) return null;
  const open = dictSrc.indexOf('{', start);
  let end = -1, depth = 0;
  for (let j = open; j < dictSrc.length; j++) {
    if (dictSrc[j] === '{') depth++;
    else if (dictSrc[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  try { return new Set(Object.keys(eval('(' + dictSrc.slice(open, end + 1) + ')'))); }
  catch { return null; }
}
const zh = keysOf('zh'), en = keysOf('en');
if (!zh || !en) { console.log('DICT-NOT-FOUND (expected zh:/en: object literals)'); fail = 1; }
else {
  const refs = [...html.matchAll(/data-i18n="([a-z0-9_]+)"/gi)].map((m) => m[1]);
  for (const k of refs) {
    if (!zh.has(k)) { console.log('MISSING-IN-ZH: ' + k); fail = 1; }
    if (!en.has(k)) { console.log('MISSING-IN-EN: ' + k); fail = 1; }
  }
  for (const k of zh) if (!en.has(k)) { console.log('EN-MISSING: ' + k); fail = 1; }
  for (const k of en) if (!zh.has(k)) { console.log('ZH-MISSING: ' + k); fail = 1; }
  console.log('i18n refs:', refs.length, 'zh keys:', zh.size, 'en keys:', en.size);
}

// 4. quick start ships the published command; the dev npm-link flow must not regress into it
if (!html.includes('npm install -g @hmharness/cli')) { console.log('INSTALL-CMD-MISSING (npm install -g @hmharness/cli)'); fail = 1; }
if (html.includes('npm link -w')) { console.log('STALE-NPM-LINK (published packages must not instruct npm link)'); fail = 1; }

console.log(fail ? 'WEBSITE-CHECK-FAILED' : 'WEBSITE-CHECK-OK');
process.exit(fail);
