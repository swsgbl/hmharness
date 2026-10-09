/**
 * @hmharness/web - desktop-host(2026-10-09, HMH Desktop 桥宿主)
 *
 * hmharness 的桌面模式入口:HMH Desktop 的 Electron 主进程经 DesktopRuntimeSupervisor
 * spawn 本文件。合同(与 hmh-desktop packages/host-adapter 的 fake-host 同款):
 *   - 只绑 127.0.0.1,端口 port 0(操作系统分配);
 *   - 高熵会话 token 由 supervisor 经环境变量 HMH_DESKTOP_TOKEN 传入(>=32 字符),
 *     所有 /api/* 强制 X-Hmh-Key 校验;token 绝不进 URL/日志;
 *   - stdout 首行输出引导行 {"hmhDesktopHostReady":true,"port":N,"version":V},
 *     其余日志一律走 stderr(supervisor 的 stdout 解析保持纯净);
 *   - POST /api/desktop/shutdown(token 保护)优雅退出;
 *   - 不启用 LAN/WAN/tunnel/移动配对(exposure 强制 loopback)。
 */
import { startServer } from './server.ts';

const token = process.env.HMH_DESKTOP_TOKEN ?? '';
if (token.length < 32) {
  process.stderr.write('desktop-host: HMH_DESKTOP_TOKEN (>=32 chars, high-entropy) is required - the desktop supervisor owns token generation\n');
  process.exit(2);
}
// supervisor 管信号与退出;这里只负责把服务带起来并保持存活
const handle = await startServer({ port: 0, desktop: { token } });
process.stderr.write(`[hmh desktop-host] serving on 127.0.0.1:${handle.port}\n`);
