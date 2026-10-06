// one-off: sync changed extension payload files into the stable install dirs
// (payload root is nested: extension-install/<kind>/<kind>/)
const fs = require('fs'), path = require('path');
const src = 'G:/hmharness/packages/extension/extension';
for (const kind of ['chromium', 'firefox']) {
  const dst = path.join('C:/Users/hongfu/.hmharness/extension-install', kind, kind);
  if (!fs.existsSync(dst)) { console.log(kind, 'payload dir missing'); continue; }
  for (const f of fs.readdirSync(dst)) {
    const a = path.join(src, f), b = path.join(dst, f);
    if (!fs.existsSync(a)) { console.log(kind, f, '(browser-specific, skip)'); continue; }
    const same = fs.readFileSync(a).equals(fs.readFileSync(b));
    if (!same) { fs.copyFileSync(a, b); console.log(kind, f, 'UPDATED'); }
  }
}
console.log('stable install dirs synced');
