// clean stale npm temp dirs from failed renames, then retry install
const fs = require('fs');
const nm = 'C:/Users/hongfu/AppData/Roaming/npm/node_modules/@hmharness';
for (const d of fs.readdirSync(nm)) {
  if (d.startsWith('.cli-')) {
    try { fs.rmSync(nm + '/' + d, { recursive: true, force: true }); console.log('removed stale temp dir:', d); } catch (e) { console.log('rm fail:', d, String(e).slice(0, 60)); }
  }
}
const { execFileSync } = require('child_process');
const NODE = process.execPath;
const npmCli = NODE.replace(/node\.exe$/, '') + 'node_modules\\npm\\bin\\npm-cli.js';
try {
  execFileSync(NODE, [npmCli, 'i', '-g', '@hmharness/cli@0.23.49', '--registry', 'https://registry.npmjs.org/'], { encoding: 'utf8', timeout: 600000, windowsHide: true });
  console.log('install ok');
} catch (e) { console.log('INSTALL FAIL:', String(e.stderr || e).slice(-200)); process.exit(1); }
const v = JSON.parse(fs.readFileSync(nm + '/cli/package.json', 'utf8')).version;
console.log('global hmh →', v);
