/**
 * @hmharness/web - desktop-host(2026-10-09, HMH Desktop 桥宿主;单实例守卫 2026-10-15)
 *
 * hmharness 的桌面模式入口:HMH Desktop 的 Electron 主进程经 DesktopRuntimeSupervisor
 * spawn 本文件。合同(与 hmh-desktop packages/host-adapter 的 fake-host 同款):
 *   - 只绑 127.0.0.1,端口 port 0(操作系统分配);
 *   - 高熵会话 token 由 supervisor 经环境变量 HMH_DESKTOP_TOKEN 传入(>=32 字符),
 *     所有 /api/* 强制 X-Hmh-Key 校验;token 绝不进 URL/日志;
 *   - stdout 首行输出引导行 {"hmhDesktopHostReady":true,"port":N,"version":V},
 *     其余日志一律走 stderr(supervisor 的 stdout 解析保持纯净);
 *   - POST /api/desktop/shutdown(token 保护)优雅退出;
 *   - 不启用 LAN/WAN/tunnel/移动配对(exposure 强制 loopback);
 *   - 单实例(v33 审计 P0-C):HMH_HOME/desktop-host.lock 记 pid+port(绝不记 token
 *     材料)。已有活实例持有本 home 时拒绝启动(exit 3),绝不杀既有进程;持有者已死
 *     的陈旧锁自动回收。
 */
import { startServer } from './server.ts';
import { homeDir } from '@hmharness/kernel';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const token = process.env.HMH_DESKTOP_TOKEN ?? '';
if (token.length < 32) {
  process.stderr.write('desktop-host: HMH_DESKTOP_TOKEN (>=32 chars, high-entropy) is required - the desktop supervisor owns token generation\n');
  process.exit(2);
}

// ---- single-instance claim (P0-C): refuse when a live host already owns this home ----
const lockPath = join(homeDir(), 'desktop-host.lock');
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user - still alive
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
let owner: { pid: number; port: number } | null = null;
try {
  const prev = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; port?: unknown };
  if (typeof prev.pid === 'number' && pidAlive(prev.pid)) {
    owner = { pid: prev.pid, port: typeof prev.port === 'number' ? prev.port : 0 };
  }
} catch {
  // no lock, or unreadable/corrupt - claimable
}
if (owner) {
  process.stderr.write(`[hmh desktop-host] another desktop-host (pid ${owner.pid}, port ${owner.port}) already owns this HMH_HOME - refusing to start (single-instance, P0-C); this process never kills the other\n`);
  process.exit(3);
}
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 0 }) + '\n');
process.on('exit', () => {
  // best-effort release: only remove OUR claim (a reclaimed lock belongs to the newer host)
  try {
    const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (cur.pid === process.pid) rmSync(lockPath, { force: true });
  } catch { /* already gone */ }
});

// supervisor 管信号与退出;这里只负责把服务带起来并保持存活
const handle = await startServer({ port: 0, desktop: { token } });
// rewrite the claim with the OS-assigned port (supervisor diagnostics; best-effort)
try {
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: handle.port }) + '\n');
} catch { /* lock bookkeeping must never take the host down */ }
process.stderr.write(`[hmh desktop-host] serving on 127.0.0.1:${handle.port}\n`);
