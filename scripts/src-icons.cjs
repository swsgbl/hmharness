// copy icons to source + update adapters.ts
const fs = require('fs');
for (const s of [48, 96, 128]) {
  fs.copyFileSync(`G:/hmharness/.audit/hmharness-icon-${s}.png`, `G:/hmharness/packages/extension/extension/icon-${s}.png`);
}
console.log('icons copied to source');
let s = fs.readFileSync('G:/hmharness/packages/extension/src/adapters.ts', 'utf8');
if (!s.includes('icon-48.png')) {
  const ICONS = "icons: { 48: 'icon-48.png', 96: 'icon-96.png', 128: 'icon-128.png' }";
  // add icons after host_permissions line
  s = s.replace(
    /host_permissions: \[`http:\/\/127\.0\.0\.1:\$\{opts\.port\}\/\*`, '<all_urls>'\],/,
    (m) => m + `\n    ${ICONS},`
  );
  fs.writeFileSync('G:/hmharness/packages/extension/src/adapters.ts', s);
  console.log('adapters.ts updated with icons');
} else console.log('already has icons');
