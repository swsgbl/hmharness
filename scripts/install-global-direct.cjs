// bypass shell wrappers: run npm-cli.js directly via the real node
const { execFileSync } = require('child_process');
const NODE = process.execPath;
const npmCli = NODE.replace(/node\.exe$/, '') + 'node_modules\\npm\\bin\\npm-cli.js';
const fs = require('fs');
if (!fs.existsSync(npmCli)) { console.log('npm-cli.js not at', npmCli); process.exit(1); }
try {
  const out = execFileSync(NODE, [npmCli, 'i', '-g', '@hmharness/cli@0.23.49', '--registry', 'https://registry.npmjs.org/'], { encoding: 'utf8', timeout: 600000, windowsHide: true });
  console.log(out.split('\n').filter((l) => /added|changed/.test(l)).join('\n') || '(installed, no summary line)');
} catch (e) {
  console.log('INSTALL FAIL:', String(e.stderr || e).slice(-400));
  process.exit(1);
}
const v = JSON.parse(fs.readFileSync('C:/Users/hongfu/AppData/Roaming/npm/node_modules/@hmharness/cli/package.json', 'utf8')).version;
console.log('global hmh →', v);
