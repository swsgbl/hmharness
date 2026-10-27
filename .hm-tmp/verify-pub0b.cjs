// 验证 publish.cjs 的 0b 块:语法 + 用隔离副本模拟执行(pin 同步 + 覆盖断言)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'G:/hmharness';
const src = fs.readFileSync(path.join(ROOT, 'scripts/publish.cjs'), 'utf8');

// 1. 语法
const chk = spawnSync('node', ['--check', path.join(ROOT, 'scripts/publish.cjs')], { encoding: 'utf8' });
console.log('publish.cjs syntax:', chk.status === 0 ? 'OK' : 'FAIL\n' + chk.stderr);

// 2. 提取 0b 块的同步+断言逻辑,在临时目录模拟执行
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pub0b-'));
// 造一个假 repo 结构:packages/cli/package.json(0.23.42 + 14 deps)+ 两份安装器副本(当前已修好的)
fs.mkdirSync(path.join(tmp, 'packages/cli'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'packages/cli/board'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'packages/cli/package.json'), path.join(tmp, 'packages/cli/package.json'));
fs.copyFileSync(path.join(ROOT, 'scripts/install-kaihongos.cjs'), path.join(tmp, 'scripts/install-kaihongos.cjs'));
fs.copyFileSync(path.join(ROOT, 'packages/cli/board/install-kaihongos.cjs'), path.join(tmp, 'packages/cli/board/install-kaihongos.cjs'));

// 从 publish.cjs 提取 0b 块(从 '// 0b.' 到 '\n}\n' 边界),ROOT 重定向到 tmp
const start = src.indexOf('// 0b.');
const end = src.indexOf('// 0. preflight');
const block = src.slice(start, end).replace(/\bpath\.join\(ROOT/g, 'path.join(TMP_ROOT');
const harness = `
const fs = require('fs'); const path = require('path'); const process = require('process');
const ROOT = ${JSON.stringify(tmp)}; const TMP_ROOT = ROOT;
const cliPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
const v = cliPkg.version;
${block}
console.log('(simulation reached end without exit)');
`;
const simFile = path.join(tmp, 'sim.cjs');
fs.writeFileSync(simFile, harness);
const r = spawnSync('node', [simFile], { encoding: 'utf8' });
console.log('--- 0b simulation (pins already 15, expect coverage ok) ---');
console.log(r.stdout);
if (r.status !== 0) { console.log('SIM FAILED:\n' + r.stderr); process.exit(1); }

// 3. 负例:把 tmp 里的安装器 pins 砍回 10 包,断言必须 process.exit(1)
const inst = fs.readFileSync(path.join(tmp, 'scripts/install-kaihongos.cjs'), 'utf8');
const cut = inst.replace(/  cognitive: '[^']+', environments: '[^']+', lsp: '[^']+',\r?\n  browser: '[^']+', extension: '[^']+',\r?\n/, '');
if (cut === inst) { console.error('negative-case patch failed to apply'); process.exit(1); }
fs.writeFileSync(path.join(tmp, 'scripts/install-kaihongos.cjs'), cut);
const r2 = spawnSync('node', [simFile], { encoding: 'utf8' });
console.log('--- 0b simulation (pins cut to 10, expect coverage FAILED exit 1) ---');
console.log('exit code:', r2.status);
console.log(r2.stdout || r2.stderr);
if (r2.status !== 1) { console.error('NEGATIVE CASE DID NOT FAIL'); process.exit(1); }
console.log('ALL CHECKS PASS');
