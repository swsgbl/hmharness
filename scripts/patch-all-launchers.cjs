// patch EVERY browser shortcut (desktop + both start menus) to carry the
// unified --load-extension argument pointing at extension-live-2
const fs = require('fs'), path = require('path');
const { execSync } = require('child_process');

const EXT = 'C:\\Users\\hongfu\\.hmharness\\extension-live-2\\chromium';
const NEW_ARG = `--load-extension="${EXT}"`;
const TARGETS = [
  [/brave\.exe$/i, 'brave'],
  [/chrome\.exe$/i, 'chrome'],
  [/msedge\.exe$/i, 'edge'],
  [/opera\.exe$/i, 'opera'],
  [/quark\.exe$/i, 'quark'],
  [/browseros/i, 'browseros'],
];
// never touch: Firefox (gecko needs its own channel), playwright-mcp helpers,
// anything with its own user-data-dir (isolated tooling profiles)
function qualifies(target, args) {
  if (!TARGETS.some(([re]) => re.test(target))) return false;
  if (/--user-data-dir/i.test(args)) return false;
  if (/firefox|private_browsing/i.test(target)) return false;
  return true;
}

function readLnk(p) {
  const out = execSync(`powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${p.replace(/'/g, "''")}'); Write-Host ($s.TargetPath+'|||'+$s.Arguments)"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const [target, args] = out.trim().split('|||');
  return { target: target ?? '', args: args ?? '' };
}
function writeArgs(p, target, args) {
  execSync(`powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${p.replace(/'/g, "''")}'); $s.TargetPath='${target.replace(/'/g, "''")}'; $s.Arguments='${args.replace(/'/g, "''")}'; $s.Save()"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

function walk(dir, depth, acc) {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, acc);
    else if (/\.lnk$/i.test(e.name)) acc.push(full);
  }
}

const lnks = [];
for (const dir of ['C:/Users/hongfu/Desktop', 'C:/Users/hongfu/AppData/Roaming/Microsoft/Windows/Start Menu/Programs', 'C:/ProgramData/Microsoft/Windows/Start Menu/Programs']) walk(dir, 0, lnks);

let patched = 0, kept = 0, skipped = 0;
for (const p of lnks) {
  let info;
  try { info = readLnk(p); } catch { continue; }
  if (!info || !info.target) continue;
  const name = path.basename(p, '.lnk');
  if (!qualifies(info.target, info.args)) { skipped++; continue; }
  // strip any existing --load-extension (old dir), then append the unified one
  const cleaned = info.args.replace(/--load-extension="?[^"]*?"?(?= |$)/gi, '').replace(/\s+/g, ' ').trim();
  const finalArgs = (cleaned + ' ' + NEW_ARG).trim();
  if (info.args.replace(/\s/g, '') === finalArgs.replace(/\s/g, '')) { kept++; continue; }
  try {
    writeArgs(p, info.target, finalArgs);
    console.log('PATCHED', name, '→', finalArgs.slice(0, 110));
    patched++;
  } catch (e) { console.log('FAIL', name, String(e).slice(0, 80)); }
}
console.log(`\nsummary: ${patched} patched, ${kept} already-ok, ${skipped} skipped (non-chromium/isolated)`);
