// rollback the junction: restore the real directory
const fs = require('fs');
const { execSync } = require('child_process');
(async () => {
  try { execSync('powershell -NoProfile -Command "Get-Process brave -ErrorAction SilentlyContinue | Stop-Process -Force"', { timeout: 20000, windowsHide: true }); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 2500));
  const target = 'C:/Users/hongfu/.hmharness/extension-install/chromium/chromium';
  const bak = target + '.bak-round58';
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) { fs.rmSync(target, { recursive: true, force: true }); console.log('junction removed'); }
    else console.log('target is a real dir already (no junction)');
  } catch { console.log('target absent'); }
  try {
    if (fs.existsSync(bak)) { fs.renameSync(bak, target); console.log('real dir restored, manifest v' + JSON.parse(fs.readFileSync(target + '/manifest.json', 'utf8')).version); }
    else console.log('no backup present (nothing to restore)');
  } catch (e) { console.log('restore fail:', String(e).slice(0, 100)); }
  process.exit(0);
})();
