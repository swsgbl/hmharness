/** 手动按链跑:clean→kernel→…→每步后记录 node_modules kernel 的状态与 dist signal。 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';

const W = 'C:/Users/hongfu/AppData/Local/Temp/hmh-ci-repro';
const sh = (cmd) => spawnSync('cmd', ['/c', cmd], { cwd: W, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
const kernelState = () => {
  const p = `${W}/node_modules/@hmharness/kernel`;
  let kind = 'missing';
  try { kind = statSync(p).isSymbolicLink() ? 'symlink' : (statSync(p + '/package.json') ? 'real-dir' : '?'); } catch { /* */ }
  let ver = '';
  try { ver = JSON.parse(readFileSync(`${p}/package.json`, 'utf8')).version; } catch { /* */ }
  let dts = 'no-dist';
  try { dts = readFileSync(`${p}/dist/provider.d.ts`, 'utf8').includes('signal') ? 'signal-ok' : 'SIGNAL-LOST'; } catch { /* */ }
  // index.d.ts 是否 re-export provider
  let idx = 'no-index';
  try { idx = readFileSync(`${p}/dist/index.d.ts`, 'utf8').split('\n').filter((l) => l.includes('provider')).join(';').slice(0, 80); } catch { /* */ }
  return `${kind} v${ver} ${dts} idx[${idx}]`;
};
const pkgs = ['kernel', 'lsp', 'observability', 'evaluation', 'sandbox', 'cognitive', 'evolution', 'domain-harmony', 'domain-ops', 'environments', 'browser', 'extension'];
console.log('== clean-dist ==');
console.log(sh('npm run clean-dist').status);
for (const p of pkgs) {
  const r = sh(`npm run build -w @hmharness/${p}`);
  sh('node scripts/fix-dts.mjs');
  console.log(`${p}: exit=${r.status} | kernel=${kernelState()}`);
  if (r.status !== 0) { console.log((r.stdout ?? '').split('\n').filter((l) => l.includes('error')).slice(0, 3).join('\n')); break; }
}
console.log('== agent build now ==');
const a = sh('npm run build -w @hmharness/agent');
console.log('agent exit:', a.status);
console.log((a.stdout ?? '').split('\n').filter((l) => l.includes('error TS')).slice(0, 3).join('\n'));
console.log('kernel state at agent time:', kernelState());
