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
//    (data blocks such as type="application/ld+json" are skipped by design)
const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/\btype\s*=\s*["'](application\/|text\/json)/i.test(m[1]))
  .map((m) => m[2]).filter((s) => s.trim());
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

// 5–7 (2026-11-26, the modern-web-guidance pass). These hold the site to what that pass
//    fixed; each rule failed on the pages before it.
const PAGES = ['index.html', 'faq.html', 'device-loop-proof.html', 'ecosystem-radar.html',
  'quickstart-matrix.html', 'prompt-injection-guardrails.html', 'evidence-provenance.html'];
const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'website', name), 'utf8');

// 5. no third-party script or stylesheet (the homepage's motion is native), no inline event
//    handler, and no horizontal clipping on html/body (it hid a nav that ran past the viewport)
for (const name of PAGES) {
  const page = read(name), where = name;
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(page) || /<link[^>]+rel\s*=\s*["']stylesheet["']/i.test(page)) { console.log(`THIRD-PARTY-RESOURCE ${where}: the site loads no external script or stylesheet`); fail = 1; }
  if (/<[a-z][^>]*\son(?:click|load|error|submit|input|change|mouseover|keydown)\s*=/i.test(page)) { console.log(`INLINE-HANDLER ${where}: use addEventListener`); fail = 1; }
  if (/(?:html|body)\s*\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/i.test(page)) { console.log(`OVERFLOW-X-HIDDEN ${where}: fix the element that is too wide`); fail = 1; }
}

// 6. structure every page keeps: one <main>, a skip link whose target exists, the supported
//    color scheme declared before first paint, and every header cell scoped
for (const name of PAGES) {
  const page = read(name), where = name;
  const mains = (page.match(/<main\b/g) || []).length;
  if (mains !== 1) { console.log(`MAIN-LANDMARK ${where}: expected exactly one <main>, found ${mains}`); fail = 1; }
  // a skip link is for getting past a navigation bar; a page without one needs none
  if (/<nav[\s>]/.test(page) && (!/<a\s+class="skip"\s+href="#main"/.test(page) || !/id="main"/.test(page))) { console.log(`SKIP-LINK ${where}: missing, or its #main target does not exist`); fail = 1; }
  if (!/<meta\s+name="color-scheme"\s+content="dark">/.test(page)) { console.log(`COLOR-SCHEME ${where}: no <meta name="color-scheme">`); fail = 1; }
  const unscoped = (page.match(/<th(?![^>]*\bscope=)[\s>]/g) || []).length;
  if (unscoped) { console.log(`TH-WITHOUT-SCOPE ${where}: ${unscoped} header cell(s)`); fail = 1; }
}

// 7. the unit-test count is quoted in three places. They drifted before (the homepage still
//    said 1068 while the FAQ said 1090): every place must carry the same numbers, and the
//    release bump must update all of them.
{
  const faq = read('faq.html'), llms = read('llms.txt');
  const stat = /<b>(\d+)<\/b><span data-i18n="s3">单元测试\((\d+) 通过\/(\d+) 跳过\)<\/span>/.exec(html);
  const zhS3 = /s3: '单元测试\((\d+) 通过\/(\d+) 跳过\)'/.exec(html);
  const faqN = /(\d+) 个单元测试门禁（最新 CI：(\d+) 通过 \/ (\d+) 跳过）/.exec(faq);
  const llmsN = /· (\d+) 个单元测试 CI 门禁（最新 CI：(\d+) 通过 \/ (\d+) 跳过）/.exec(llms);
  const all = [stat, zhS3, faqN, llmsN];
  if (all.some((m) => !m)) {
    console.log('TEST-COUNT-NOT-FOUND: index stat / index zh s3 / faq / llms.txt (an unfilled placeholder counts as not found)');
    fail = 1;
  } else {
    // the statistic, the FAQ and llms.txt quote tests/pass/skip; the zh dictionary text
    // under the statistic quotes pass/skip only
    const triples = [stat, faqN, llmsN].map((m) => m.slice(1).join('/'));
    const same = new Set(triples).size === 1 && zhS3.slice(1).join('/') === stat[2] + '/' + stat[3];
    if (!same) { console.log('TEST-COUNT-DIFFERS: index stat / index s3 / faq / llms.txt = ' + stat.slice(1).join('/') + '  vs  ' + zhS3.slice(1).join('/') + '  vs  ' + faqN.slice(1).join('/') + '  vs  ' + llmsN.slice(1).join('/')); fail = 1; }
    else console.log('test count (tests/pass/skip) agrees in 4 places:', triples[0]);
  }
}

console.log(fail ? 'WEBSITE-CHECK-FAILED' : 'WEBSITE-CHECK-OK');
process.exit(fail);
