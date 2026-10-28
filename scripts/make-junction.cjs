// replace the ghost-registered dir with a junction to live-2 (path stays,
// content becomes current; Brave's SW must reload on byte change)
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const target = 'C:/Users/hongfu/.hmharness/extension-install/chromium/chromium';
const live = 'C:/Users/hongfu/.hmharness/extension-live-2/chromium';
(async () => {
  try { execSync('powershell -NoProfile -Command "Get-Process brave -ErrorAction SilentlyContinue | Stop-Process -Force"', { timeout: 20000, windowsHide: true }); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 2500));
  try {
    if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
      fs.renameSync(target, target + '.bak-round58');
      console.log('old dir renamed to .bak-round58');
    }
  } catch (e) { console.log('rename fail:', String(e).slice(0, 100)); }
  try {
    execSync(`powershell -NoProfile -Command "New-Item -ItemType Junction -Path '${target.replace(/'/g, "''")}' -Target '${live}' | Out-Null; Write-Host junction-ok"`, { timeout: 20000, windowsHide: true });
    const v = JSON.parse(fs.readFileSync(target + '/manifest.json', 'utf8')).version;
    console.log('junction serves manifest v' + v);
  } catch (e) { console.log('junction fail:', String(e).slice(0, 120)); }
  // also purge Brave SW cache once more so the byte-diff is actually fetched
  try { fs.rmSync('C:/Users/hongfu/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Service Worker/ScriptCache', { recursive: true, force: true }); console.log('ScriptCache purged'); } catch { /* */ }
  spawn('C:\\Users\\hongfu\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('brave relaunched');
  setTimeout(async () => {
    try {
      const d = await (await fetch('http://127.0.0.1:7789/v1/status', { signal: AbortSignal.timeout(1500) })).json();
      console.log('RESULT: connected=' + d.connected, 'v' + (d.extVersion ?? '?'), 'browser=' + (d.browser ?? '-'));
    } catch { console.log('probe fail'); }
    process.exit(0);
  }, 25000);
})();
