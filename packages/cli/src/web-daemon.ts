/**
 * @hmh/cli - web daemon helpers
 * Shared by `hmh web start|stop|status` and the TUI auto-link (hmh tui
 * brings the web UI up unless --no-web). One pid file + one log file under
 * HMH_HOME; the daemon runs detached with no window and survives terminals.
 */
import { spawn } from 'node:child_process';
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmh/kernel';

export const DEFAULT_WEB_PORT = 7788;

export function readWebPid(): number {
  try {
    const p = Number(readFileSync(join(homeDir(), 'web.pid'), 'utf8').trim());
    return Number.isFinite(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** cheap probe: does OUR server answer on the port (not just any listener)? */
export async function hmhWebUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const d = (await r.json()) as { model?: string };
    return typeof d.model === 'string';
  } catch {
    return false;
  }
}

export function stopWebDaemon(): boolean {
  const pid = readWebPid();
  if (!pid || !alive(pid)) {
    try { unlinkSync(join(homeDir(), 'web.pid')); } catch { /* absent */ }
    return false;
  }
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try { process.kill(pid); } catch { /* gone */ }
  }
  try { unlinkSync(join(homeDir(), 'web.pid')); } catch { /* absent */ }
  return true;
}

/** Spawn the daemon (no window, detached). Returns the pid. */
function spawnWebDaemon(port: number, entry = process.argv[1]): number {
  const home = homeDir();
  const log = openSync(join(home, 'web.log'), 'a');
  const child = spawn(process.execPath, [entry, 'web', `--port=${port}`], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: process.cwd(),
  });
  child.unref();
  const pid = child.pid ?? 0;
  if (pid > 0) writeFileSync(join(home, 'web.pid'), String(pid));
  return pid;
}

/**
 * Idempotent: if our web UI is already up (pid file alive, or the port
 * answers as hmh), keep it; otherwise spawn it and wait up to ~6s for
 * readiness. Returns true when the web UI is usable.
 */
export async function ensureWebDaemon(port = DEFAULT_WEB_PORT, entry = process.argv[1]): Promise<boolean> {
  const pid = readWebPid();
  if (pid && alive(pid)) return true;
  if (await hmhWebUp(port)) return true;
  spawnWebDaemon(port, entry);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await hmhWebUp(port)) return true;
  }
  return false;
}

export function startWebDaemon(port = DEFAULT_WEB_PORT, entry = process.argv[1]): { already: boolean; pid: number } {
  const pid = readWebPid();
  if (pid && alive(pid)) return { already: true, pid };
  return { already: false, pid: spawnWebDaemon(port, entry) };
}
