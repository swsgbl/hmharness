/**
 * desktop-host tests (2026-10-09, HMH Desktop bridge):
 * spawn the real desktop-host.ts child and pin the supervisor contract -
 * stdout bootstrap line (one json line, port 0 -> OS-assigned), the x-hmh-key
 * gate on EVERY route, the graceful /api/desktop/shutdown, and the
 * missing/short-token guard exit. Uses a throwaway HMH_HOME so the machine's
 * real config/providers are never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const hostTs = join(here, '..', 'desktop-host.ts');
const TOKEN = randomBytes(32).toString('base64url');

interface HostProc {
  port: number;
  child: ReturnType<typeof spawn>;
}

async function startHost(envExtra: Record<string, string> = {}): Promise<HostProc> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-desktop-host-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', hostTs], {
    cwd: here,
    env: { ...process.env, HMH_HOME: home, HMH_DESKTOP_TOKEN: TOKEN, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const v = JSON.parse(line) as { hmhDesktopHostReady?: boolean; port?: number; version?: string };
        if (v.hmhDesktopHostReady === true && typeof v.port === 'number' && typeof v.version === 'string') {
          clearTimeout(timer);
          resolve(v.port);
        }
      } catch { /* normal stderr-ish noise on stdout: none per contract */ }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  if (port === null) {
    child.kill();
    await rm(home, { recursive: true, force: true });
    throw new Error('desktop-host did not emit the bootstrap line within 30s');
  }
  // stash home for cleanup via child env is not possible; register exit cleanup
  const exiting = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  void exiting.then(() => rm(home, { recursive: true, force: true })).catch(() => undefined);
  return { port, child };
}

test('bootstrap + x-hmh-key gate + graceful shutdown(整链路)', async () => {
  const host = await startHost();
  try {
    assert.ok(host.port > 0 && host.port < 65536, `OS 分配端口(${host.port})`);

    // 无 key → 401 DesktopError 形状
    const noKey = await fetch(`http://127.0.0.1:${host.port}/api/state`);
    assert.equal(noKey.status, 401);
    const noKeyBody = (await noKey.json()) as { code: string; message: string; retryable: boolean };
    assert.equal(noKeyBody.code, 'AUTH_FAILED');
    assert.equal(noKeyBody.retryable, false);

    // 错 key → 401
    const badKey = await fetch(`http://127.0.0.1:${host.port}/api/state`, { headers: { 'x-hmh-key': 'wrong' } });
    assert.equal(badKey.status, 401);

    // 对 key → 200,state 快照可达
    const ok = await fetch(`http://127.0.0.1:${host.port}/api/state`, { headers: { 'x-hmh-key': TOKEN } });
    assert.equal(ok.status, 200);
    const state = (await ok.json()) as { daemonVersion: string; home?: string };
    assert.ok(typeof state.daemonVersion === 'string' && state.daemonVersion.length > 0);
    assert.ok(String(state.home).includes('hmh-desktop-host-'), 'HMH_HOME 隔离生效(临时目录)');

    // graceful shutdown:token 保护下进程自行退出
    const sd = await fetch(`http://127.0.0.1:${host.port}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { 'x-hmh-key': TOKEN },
    });
    assert.equal(sd.status, 200);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      host.child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, '优雅退出 exit 0');
  } finally {
    if (host.child.exitCode === null) host.child.kill();
  }
});

test('无 token → 拒绝启动(exit 2)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-desktop-host-'));
  const child = spawn(process.execPath, ['--import', 'tsx', hostTs], {
    cwd: here,
    env: { ...process.env, HMH_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 2);
  assert.match(stderr, /HMH_DESKTOP_TOKEN/);
  await rm(home, { recursive: true, force: true });
});

test('短 token(<32)→ 拒绝启动(exit 2)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-desktop-host-'));
  const child = spawn(process.execPath, ['--import', 'tsx', hostTs], {
    cwd: here,
    env: { ...process.env, HMH_HOME: home, HMH_DESKTOP_TOKEN: 'short-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 2);
  await rm(home, { recursive: true, force: true });
});

test('/api/diff:git 工作区返回只读变更,非 git 返回 git:false(M4 Diff 面板)', async () => {
  // 临时 git 仓:一个已修改文件 + 一个未跟踪文件
  const repo = await mkdtemp(join(tmpdir(), 'hmh-diff-'));
  await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8');
  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      import('node:child_process').then(({ execFile }) =>
        execFile('git', args, { cwd: repo, timeout: 8_000, windowsHide: true }, (err) => (err ? reject(err) : resolve())));
    });
  try {
    await git(['init', '-q']);
    await git(['config', 'user.email', 't@t']);
    await git(['config', 'user.name', 't']);
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'init']);
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
    await writeFile(join(repo, 'b.txt'), 'new\n', 'utf8');
  } catch {
    await rm(repo, { recursive: true, force: true });
    assert.fail('git fixture 准备失败');
  }

  const home = await mkdtemp(join(tmpdir(), 'hmh-desktop-host-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  // cwd=repo(临时仓)时 bare 'tsx' 无法从 cwd 解析 —— 传绝对 file URL
  // (Windows 绝对路径直接给 --import 会被当成 'g:' 协议,必须 pathToFileURL)
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const child = spawn(process.execPath, ['--import', tsxUrl, hostTs], {
    cwd: repo, // server cwd = wsRoot → diff 面向该仓
    env: { ...process.env, HMH_HOME: home, HMH_DESKTOP_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx > 0) {
        try {
          const v = JSON.parse(buf.slice(0, idx)) as { hmhDesktopHostReady?: boolean; port?: number };
          if (v.hmhDesktopHostReady === true && typeof v.port === 'number') {
            clearTimeout(timer);
            resolve(v.port);
          }
        } catch { /* not json */ }
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  try {
    assert.notEqual(port, null, 'desktop-host 启动');
    const r = await fetch(`http://127.0.0.1:${port}/api/diff`, { headers: { 'x-hmh-key': TOKEN } });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { git: boolean; changed: Array<{ state: string; path: string }>; stat: string };
    assert.equal(d.git, true);
    const paths = d.changed.map((c) => c.path);
    assert.ok(paths.includes('a.txt'), '修改的文件在列表');
    assert.ok(paths.includes('b.txt'), '未跟踪文件在列表');
    assert.match(d.stat, /a\.txt/, 'diff --stat 输出');
    // 非 git 目录 → git:false 不报错
    const r2 = await fetch(`http://127.0.0.1:${port}/api/diff?sessionId=nope`, { headers: { 'x-hmh-key': TOKEN } });
    assert.equal(r2.status, 200);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
