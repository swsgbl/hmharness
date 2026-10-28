// Tabbit Browser (process name chrome.exe, autolaunch in HKCU Run):
// 1) read its full Run entry + find real exe
// 2) append our --load-extension to the autolaunch value
// 3) patch any Tabbit shortcuts
const { execSync } = require('child_process');
const fs = require('fs');
const EXT = 'C:\\Users\\hongfu\\.hmharness\\extension-live-2\\chromium';
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VAL = 'GoogleChromeAutoLaunch_3178C5A286036008CE80BC07467A662F';
try {
  const out = execSync(`reg query "${KEY}" /v ${VAL}`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const line = out.split('\n').find((l) => l.includes('REG_SZ')) ?? '';
  const cur = line.split('REG_SZ')[1]?.trim() ?? '';
  console.log('current autolaunch:', cur.slice(0, 220));
  if (!/--load-extension/i.test(cur)) {
    const next = `${cur} --load-extension="${EXT}"`;
    execSync(`reg add "${KEY}" /v ${VAL} /t REG_SZ /d "${next.replace(/"/g, '\\"')}" /f`, { timeout: 15000, windowsHide: true });
    console.log('autolaunch patched with extension arg');
  } else console.log('autolaunch already carries extension');
  // find the Tabbit exe for reference
  const exe = cur.match(/"([^"]+chrome\.exe)"/)?.[1];
  if (exe && fs.existsSync(exe)) console.log('tabbit exe:', exe);
} catch (e) { console.log('FAIL:', String(e.stderr || e).slice(0, 200)); }
