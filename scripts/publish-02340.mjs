/** 0.23.40 npm 发布驱动:临时 .npmrc(token 只进本机文件,发布完即删)→publish.cjs→验证。 */
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = process.env.HMH_NPM_TOKEN ?? '';
if (token === '') { console.log('NO TOKEN'); process.exit(1); }
const npmrc = join(homedir(), '.npmrc');
const backup = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : null;
const authLine = `//registry.npmjs.org/:_authToken=${token}`;
writeFileSync(npmrc, (backup ?? '') + '\n' + authLine + '\n', 'utf8');
console.log('npmrc: token 已临时注入(发布后删除)');

try {
  const who = spawnSync('npm', ['whoami', '--registry', 'https://registry.npmjs.org'], { encoding: 'utf8', timeout: 60_000 });
  console.log('whoami:', (who.stdout ?? '').trim() || who.stderr.trim().slice(0, 80));
  if (who.status !== 0) { console.log('AUTH FAIL'); process.exit(1); }

  console.log('=== publish.cjs(预检+16 包顺序发布) ===');
  const pub = spawnSync('node', ['scripts/publish.cjs'], {
    encoding: 'utf8',
    timeout: 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  const out = (pub.stdout ?? '') + (pub.stderr ?? '');
  console.log(out.split('\n').filter((l) => /==|publish|ok|FAIL|ERR|error|done|PREFLIGHT|aborted|published/i.test(l)).slice(-40).join('\n'));
  console.log('exit:', pub.status);
} finally {
  writeFileSync(npmrc, backup ?? '', 'utf8');
  if (backup === null && existsSync(npmrc)) unlinkSync(npmrc);
  console.log('npmrc: token 已清除');
}
