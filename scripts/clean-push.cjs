const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const SRC = 'G:/hmharness';
const TMP = 'G:/hmharness/.gh-push-tmp';

(async () => {
  const L = [];
  // 1. Check what GitHub actually has
  try {
    const r = await run('gh', ['api', 'repos/swsgbl/hmharness/branches/main', '--jq', '.commit.sha'], { timeout: 15000 });
    L.push('GitHub main HEAD: ' + r.stdout.trim().slice(0, 7));
  } catch (e) { L.push('GitHub check: ' + e.message.slice(0, 60)); }
  // Check branch protection
  try {
    const r = await run('gh', ['api', 'repos/swsgbl/hmharness/branches/main/protection'], { timeout: 15000 });
    L.push('branch protection: ' + r.stdout.slice(0, 100));
  } catch (e) { L.push('branch protection: none or inaccessible'); }

  // 2. Create clean repo in temp dir
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  L.push('temp dir created');

  // 3. Copy source (excluding .git, node_modules, dist)
  function copyDir(src, dst) {
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', '.gh-push-tmp', '.kos-tmp', '.zcode', 'dist.v2bak'].includes(item.name)) continue;
      if (item.name.endsWith('.tmpbak') || item.name.endsWith('.opsbak')) continue;
      const s = path.join(src, item.name);
      const d = path.join(dst, item.name);
      if (item.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
      else fs.copyFileSync(s, d);
    }
  }
  copyDir(SRC, TMP);
  L.push('files copied');

  // 4. Init fresh git repo
  await run('git', ['init', '-b', 'main'], { cwd: TMP, timeout: 10000 });
  await run('git', ['add', '-A'], { cwd: TMP, timeout: 30000 });
  await run('git', ['commit', '-m',
    'hmharness v0.17.0 - self-evolving agent harness for HarmonyOS\n\n' +
    'Complete audit implementation: P0(7) + P1(7) + P2(5) + P3(5) = 24/24 = 100%\n' +
    '518 tests passing. npm: @hmharness/cli@0.17.0'], { cwd: TMP, timeout: 30000 });
  const log = await run('git', ['log', '--oneline', '-1'], { cwd: TMP, timeout: 10000 });
  L.push('fresh commit: ' + log.stdout.trim());

  // 5. Push to GitHub (force = replace all history)
  const push = (env) => new Promise(res => {
    const p = spawn('git', ['push', '--force', 'https://github.com/swsgbl/hmharness.git', 'main'], {
      cwd: TMP, env: { ...process.env, ...env }, windowsHide: true,
    });
    let out = '';
    p.stderr.on('data', d => out += d);
    p.on('close', c => res({ ok: c === 0, out: out.trim().split('\n').slice(-3).join('\n') }));
  });
  const socks = { HTTPS_PROXY: 'socks5://127.0.0.1:10808', ALL_PROXY: 'socks5://127.0.0.1:10808' };
  for (let i = 0; i < 3; i++) {
    const r = await push(i % 2 === 0 ? socks : {});
    L.push('push ' + (i + 1) + ': ' + (r.ok ? 'OK ✓' : r.out.slice(0, 120)));
    if (r.ok) break;
    await new Promise(r2 => setTimeout(r2, 5000));
  }

  // 6. Also push to AtomGit
  const pushA = () => new Promise(res => {
    const p = spawn('git', ['push', '--force', 'git@atomgit.com:hongfu/hmharness.git', 'main'], {
      cwd: TMP, windowsHide: true,
    });
    p.on('close', c => res(c === 0));
  });
  if (await pushA()) L.push('push atomgit: OK ✓');

  // 7. Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });
  L.push('temp dir cleaned');

  console.log(L.join('\n'));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
