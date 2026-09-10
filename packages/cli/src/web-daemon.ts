/**
 * @hmharness/cli - web daemon helpers
 * Shared by `hmh web start|stop|status` and the TUI auto-link (hmh tui
 * brings the web UI up unless --no-web). One pid file + one log file under
 * HMH_HOME; the daemon runs detached with no window and survives terminals.
 *
 * VERSION-AWARE (this bit me twice): a daemon is a code snapshot frozen at
 * spawn time. After `npm i -g @hmharness/cli@X` the running daemon still
 * serves the OLD code — new features silently missing, and the user sees
 * stale behavior forever. `ensureWebDaemon` now compares the daemon's
 * recorded version against the running CLI and auto-restarts on mismatch.
 */
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';

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

/** cheap probe: does OUR server answer on the port (not just any listener)?
 *  Accepts ANY hmh /api/state shape - a daemon from an older build still
 *  serves the UI, and rejecting it made the TUI auto-link spawn a fresh
 *  daemon that died on EADDRINUSE every startup (the "lost setting" bug). */
export async function hmhWebUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const d = await r.json();
    return !!d && typeof d === 'object';
  } catch {
    return false;
  }
}

/** Windows-first: find the PID LISTENING on 127.0.0.1:<port> via netstat.
 *  Used to reclaim a port held by an orphaned/old daemon whose pid file is
 *  stale - `hmh web stop` must be able to evict it, or restarts never heal. */
function portOwnerPid(port: number): number {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const m = line.trim().match(new RegExp(`^(TCP)\\s+\\S*?:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)$`));
      if (m) return Number(m[2]);
    }
  } catch { /* netstat unavailable - give up quietly */ }
  return 0;
}

export function stopWebDaemon(): boolean {
  const pid = readWebPid();
  let killed = false;
  if (pid && alive(pid)) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else {
      try { process.kill(pid); } catch { /* gone */ }
    }
    killed = true;
  }
  try { unlinkSync(join(homeDir(), 'web.pid')); } catch { /* absent */ }
  // stale pid file but the port is still held (orphaned/old daemon): evict
  const owner = portOwnerPid(DEFAULT_WEB_PORT);
  if (owner && owner !== pid) {
    try {
      spawn('taskkill', ['/PID', String(owner), '/T', '/F'], { windowsHide: true });
      killed = true;
    } catch { /* best effort */ }
  }
  return killed;
}

/** Spawn the daemon (no window, detached). Returns the pid. Records the
 *  spawning CLI's version so a later upgrade can detect the stale snapshot. */
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
  if (pid > 0) {
    writeFileSync(join(home, 'web.pid'), String(pid));
    try {
      const v = createRequire(import.meta.url)('../package.json').version as string;
      writeFileSync(join(home, 'web.version'), v);
    } catch { /* best effort */ }
  }
  return pid;
}

function daemonVersion(): string {
  try { return readFileSync(join(homeDir(), 'web.version'), 'utf8').trim(); } catch { return ''; }
}

function cliVersion(): string {
  try { return createRequire(import.meta.url)('../package.json').version as string; } catch { return ''; }
}

/**
 * Idempotent: if our web UI is already up (pid file alive, or the port
 * answers as hmh), keep it; otherwise spawn it and wait up to ~6s for
 * readiness. Returns true when the web UI is usable.
 *
 * Version check: a daemon spawned by an older CLI keeps serving old code
 * (the user sees missing features for days). We compare the recorded daemon
 * version with the current CLI and restart on mismatch.
 */
export async function ensureWebDaemon(port = DEFAULT_WEB_PORT, entry = process.argv[1]): Promise<boolean> {
  const pid = readWebPid();
  const daemonV = daemonVersion();
  const myV = cliVersion();
  const stale = daemonV !== '' && myV !== '' && daemonV !== myV;

  if (!stale) {
    if (pid && alive(pid)) return true;
    if (await hmhWebUp(port)) return true;
  } else {
    // stale daemon: kill it (it may hold the pid OR just the port)
    stopWebDaemon();
    await new Promise((r) => setTimeout(r, 600));
  }

  spawnWebDaemon(port, entry);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await hmhWebUp(port)) return true;
  }
  return false;
}

/** Report whether the running daemon matches the current CLI version. */
export function webDaemonStale(): { stale: boolean; daemon: string; cli: string } {
  const d = daemonVersion();
  const c = cliVersion();
  return { stale: d !== '' && c !== '' && d !== c, daemon: d, cli: c };
}

export function startWebDaemon(port = DEFAULT_WEB_PORT, entry = process.argv[1]): { already: boolean; pid: number } {
  const pid = readWebPid();
  if (pid && alive(pid)) return { already: true, pid };
  return { already: false, pid: spawnWebDaemon(port, entry) };
}
