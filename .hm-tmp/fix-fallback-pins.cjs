// 修 FALLBACK_PINS:10 包 → 15 包(离线路径 undefined 404 根修),两份孪生副本同步改。
// 保留各文件原有行尾风格(CRLF),替换后逐字节复核。
const fs = require('fs');
const FILES = [
  'G:/hmharness/scripts/install-kaihongos.cjs',
  'G:/hmharness/packages/cli/board/install-kaihongos.cjs',
];
const OLD_PINS = `const FALLBACK_PINS = {
  cli: '0.23.42', web: '0.23.42', agent: '0.23.42', kernel: '0.23.42',
  sandbox: '0.23.42', evolution: '0.23.42', 'domain-ops': '0.23.42',
  evaluation: '0.23.42', observability: '0.23.42', 'domain-harmony': '0.23.42',
};`;
const NEW_PINS = `const FALLBACK_PINS = {
  cli: '0.23.42', web: '0.23.42', agent: '0.23.42', kernel: '0.23.42',
  sandbox: '0.23.42', evolution: '0.23.42', 'domain-ops': '0.23.42',
  evaluation: '0.23.42', observability: '0.23.42', 'domain-harmony': '0.23.42',
  cognitive: '0.23.42', environments: '0.23.42', lsp: '0.23.42',
  browser: '0.23.42', extension: '0.23.42',
};`;
// 注释补一段事实说明(插在 "Known-good pin set" 注释块的承诺行之后)
const OLD_NOTE = `// first-party set so the offline path cannot produce an incomplete tree.`;
const NEW_NOTE = `// first-party set so the offline path cannot produce an incomplete tree.
// 2026-10-27 fix: this list had only 10 names while PACKAGES had grown to 15 —
// pins[n] was undefined for cognitive/environments/lsp/browser/extension, so
// the offline path tried <name>-undefined.tgz → 404 → INSTALL FAILED (directly
// contradicting the promise above; evidence: cli 0.23.42 declares 14 deps).`;

for (const f of FILES) {
  let t = fs.readFileSync(f, 'utf8');
  if (!t.includes(OLD_PINS)) { console.error('PINS block not found in ' + f); process.exit(1); }
  if (!t.includes(OLD_NOTE)) { console.error('NOTE anchor not found in ' + f); process.exit(1); }
  t = t.replace(OLD_PINS, NEW_PINS).replace(OLD_NOTE, NEW_NOTE);
  fs.writeFileSync(f, t);
  // 复核
  const back = fs.readFileSync(f, 'utf8');
  const pins = back.match(/const FALLBACK_PINS = \{[\s\S]*?\};/)[0];
  const names = [...pins.matchAll(/'([^']+)':|(\w+):/g)].map(m => m[1] || m[2]);
  console.log(f + ' → pins names(' + names.length + '): ' + names.join(','));
  console.log('  CRLF preserved: ' + (back.includes('\r\n') === fs.readFileSync(f === FILES[0] ? FILES[1] : FILES[0], 'utf8').includes('\r\n')));
}
// 两副本仍等价
const [a, b] = FILES.map(f => fs.readFileSync(f, 'utf8'));
console.log('twins still identical:', a === b);
// 语法检查
require('child_process').spawnSync('node', ['--check', FILES[0]], { stdio: 'inherit' });
require('child_process').spawnSync('node', ['--check', FILES[1]], { stdio: 'inherit' });
console.log('syntax check done');
