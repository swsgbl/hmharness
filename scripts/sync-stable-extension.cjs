// sync full built payload (v0.23.31) into the stable install dirs used by
// user browsers + rebuild XPI, then re-verify consistency
const fs = require('fs'), path = require('path');
const LIVE = 'C:/Users/hongfu/.hmharness/extension-live-2';
// chromium stable dir + firefox stable dir + XPI
for (const [kind, payloadDir] of [['chromium', LIVE + '/chromium'], ['firefox', LIVE + '/firefox']]) {
  const dst = `C:/Users/hongfu/.hmharness/extension-install/${kind}/${kind}`;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(payloadDir)) {
    const a = path.join(payloadDir, f), b = path.join(dst, f);
    const stat = fs.statSync(a);
    if (stat.isFile()) { fs.copyFileSync(a, b); }
  }
  console.log(kind, 'synced:', fs.readdirSync(dst).join(', '));
}
console.log('stable dirs synced from live-2 (single source of truth)');
const mv = JSON.parse(fs.readFileSync('C:/Users/hongfu/.hmharness/extension-install/chromium/chromium/manifest.json', 'utf8'));
console.log('stable chromium manifest v' + mv.version);
