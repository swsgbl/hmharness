// add icons to extension payload + manifest
const fs = require('fs');
const path = require('path');

// 1) copy icon files to payload dirs
const ICON_SIZES = [48, 96, 128];
const payloadDirs = [
  'C:/Users/hongfu/.hmharness/extension-live-2/chromium',
  'C:/Users/hongfu/.hmharness/extension-live-2/firefox',
  'C:/Users/hongfu/.hmharness/extension-install/chromium',
  'C:/Users/hongfu/.hmharness/extension-install/firefox',
];

// generate 48/96 sizes from the 128 original using PowerShell
const { execFileSync } = require('child_process');
for (const size of ICON_SIZES) {
  const outPath = `G:/hmharness/.audit/hmharness-icon-${size}.png`;
  if (!fs.existsSync(outPath)) {
    execFileSync('powershell', ['-NoProfile', '-Command', `
      Add-Type -AssemblyName System.Drawing
      $src = [System.Drawing.Image]::FromFile('G:\\hmharness\\.audit\\hmharness-icon-128.png')
      $bmp = New-Object System.Drawing.Bitmap(${size}, ${size})
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($src, 0, 0, ${size}, ${size})
      $bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose(); $src.Dispose()
    `], { timeout: 30000, windowsHide: true });
    console.log(`generated ${size}x${size}`);
  }
}

// 2) copy to payload dirs + update manifest
for (const dir of payloadDirs) {
  const mfPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mfPath)) continue;
  for (const size of ICON_SIZES) {
    fs.copyFileSync(`G:/hmharness/.audit/hmharness-icon-${size}.png`, path.join(dir, `icon-${size}.png`));
  }
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.icons = { 48: 'icon-48.png', 96: 'icon-96.png', 128: 'icon-128.png' };
  // also set action icon (toolbar)
  if (mf.action) mf.action.default_icon = { 48: 'icon-48.png', 96: 'icon-96.png', 128: 'icon-128.png' };
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  console.log(dir.split('/').slice(-2).join('/'), '→ icons added');
}

// 3) also add to source payload in repo
const srcDir = 'G:/hmharness/packages/extension/extension';
for (const size of ICON_SIZES) {
  fs.copyFileSync(`G:/hmharness/.audit/hmharness-icon-${size}.png`, path.join(srcDir, `icon-${size}.png`));
}
const srcMf = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
srcMf.icons = { 48: 'icon-48.png', 96: 'icon-96.png', 128: 'icon-128.png' };
if (srcMf.action) srcMf.action.default_icon = { 48: 'icon-48.png', 96: 'icon-96.png', 128: 'icon-128.png' };
fs.writeFileSync(path.join(srcDir, 'manifest.json'), JSON.stringify(srcMf, null, 2));
console.log('source payload → icons added');
console.log('done');
