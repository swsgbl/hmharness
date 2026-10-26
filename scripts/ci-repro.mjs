/** 完全模拟 CI:干净 clone → npm install → build,复现 agent 类型错误。 */
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const work = 'C:/Users/hongfu/AppData/Local/Temp/hmh-ci-repro';
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
console.log('== clone(file://) ==');
let r = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/swsgbl/hmharness.git', work], { encoding: 'utf8', timeout: 300_000 });
if (r.status !== 0) { console.log('clone https fail,try local:', r.stderr.slice(0, 80)); r = spawnSync('git', ['clone', '--depth', '1', 'G:/hmharness', work], { encoding: 'utf8', timeout: 300_000 }); }
console.log('clone exit:', r.status);

console.log('== npm install ==');
r = spawnSync('npm', ['install'], { cwd: work, encoding: 'utf8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
console.log('install exit:', r.status, (r.stderr ?? '').slice(-100));

console.log('== workspace link check ==');
const link = `${work}/node_modules/@hmharness/kernel`;
console.log('node_modules kernel exists:', existsSync(link));
try { console.log('is symlink/junction →', readFileSync(`${link}/package.json`, 'utf8').includes('0.23.40') ? 'version 0.23.40' : 'other'); } catch (e) { console.log('read fail:', String(e).slice(0, 60)); }
try { const st = spawnSync('cmd', ['/c', `dir /AL ${work}\\node_modules\\@hmharness | findstr kernel`], { encoding: 'utf8' }); console.log(st.stdout.trim() || '(no junction listed)'); } catch { /* ok */ }

console.log('== build ==');
r = spawnSync('npm', ['run', 'build'], { cwd: work, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
const out = (r.stdout ?? '') + (r.stderr ?? '');
const lines = out.split('\n');
console.log(lines.filter((l) => /error TS|@hmharness.*build|fix-dts/.test(l)).slice(-15).join('\n'));
console.log('build exit:', r.status);
