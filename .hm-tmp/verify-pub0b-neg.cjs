// 负例 v2:cli package.json 多声明 @hmharness/newpkg(模板没有)→ 同步后覆盖断言必须 exit 1
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'G:/hmharness';
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pub0b2-'));
fs.mkdirSync(path.join(tmp, 'packages/cli/board'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
const cliPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf8'));
cliPkg.dependencies['@hmharness/newpkg'] = cliPkg.version; // 未来新包场景
fs.writeFileSync(path.join(tmp, 'packages/cli/package.json'), JSON.stringify(cliPkg, null, 2));
fs.copyFileSync(path.join(ROOT, 'scripts/install-kaihongos.cjs'), path.join(tmp, 'scripts/install-kaihongos.cjs'));
fs.copyFileSync(path.join(ROOT, 'packages/cli/board/install-kaihongos.cjs'), path.join(tmp, 'packages/cli/board/install-kaihongos.cjs'));

const src = fs.readFileSync(path.join(ROOT, 'scripts/publish.cjs'), 'utf8');
const start = src.indexOf('// 0b.');
const end = src.indexOf('// 0. preflight');
const block = src.slice(start, end).replace(/\bpath\.join\(ROOT/g, 'path.join(TMP_ROOT');
const harness = `
const fs = require('fs'); const path = require('path'); const process = require('process');
const ROOT = ${JSON.stringify(tmp)}; const TMP_ROOT = ROOT;
const cliPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
const v = cliPkg.version;
${block}
console.log('(reached end without exit - BAD for this negative case)');
`;
const simFile = path.join(tmp, 'sim.cjs');
fs.writeFileSync(simFile, harness);
const r = spawnSync('node', [simFile], { encoding: 'utf8' });
console.log('exit code:', r.status);
console.log(r.stdout || r.stderr);
if (r.status !== 1) { console.error('NEGATIVE CASE DID NOT FAIL'); process.exit(1); }
console.log('NEGATIVE CASE PASSES (guard fires on missing name)');
