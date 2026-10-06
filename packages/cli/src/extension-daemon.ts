/**
 * @hmharness/cli - extension bridge daemon helpers
 * `hmh extension start|stop` — the background form of `hmh extension serve`.
 * The popup tells the user "桥未运行" when nothing answers on 7789; this
 * daemon is the fix that keeps the bridge alive across reboots/terminals,
 * exactly like the web UI daemon (web-daemon.ts) it is modeled on.
 *
 * Files under HMH_HOME: extension.pid / extension.log / extension.version.
 * The spawned child is the SAME foreground `extension serve` — one code path.
 */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';

export const DEFAULT_EXTENSION_PORT = 7789;

export function readExtensionPid(): number {
  try {
    const p = Number(readFileSync(join(homeDir(), 'extension.pid'), 'utf8').trim());
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

/** Probe the bridge: up only if /v1/status answers as OUR protocol (hmext/1).
 *  Anything else on the port (or silence) means "not us" → safe to reclaim. */
export interface ExtensionProbe { up: boolean; connected: boolean }
export async function probeExtensionDaemon(port = DEFAULT_EXTENSION_PORT): Promise<ExtensionProbe> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false, connected: false };
    const d = await r.json() as Record<string, unknown>;
    const up = d?.ok === true && d?.protocol === 'hmext/1';
    return { up, connected: up && d?.connected === true };
  } catch {
    return { up: false, connected: false };
  }
}

/** Windows-first: find the PID LISTENING on 127.0.0.1:<port> via netstat, so
 *  `stop` can evict an orphan whose pid file went stale (same trap as web). */
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

export async function waitExtensionPortFree(port = DEFAULT_EXTENSION_PORT, maxMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (portOwnerPid(port) === 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return portOwnerPid(port) === 0;
}

export function stopExtensionDaemon(port = DEFAULT_EXTENSION_PORT): boolean {
  const pid = readExtensionPid();
  let killed = false;
  if (pid && alive(pid)) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else {
      try { process.kill(pid); } catch { /* gone */ }
    }
    killed = true;
  }
  try { unlinkSync(join(homeDir(), 'extension.pid')); } catch { /* absent */ }
  const owner = portOwnerPid(port);
  if (owner && owner !== pid) {
    try {
      spawn('taskkill', ['/PID', String(owner), '/T', '/F'], { windowsHide: true });
      killed = true;
    } catch { /* best effort */ }
  }
  return killed;
}

/** Spawn the bridge detached (no window). extraArgs carries --port through. */
function spawnExtensionDaemon(entry: string, port: number): number {
  const home = homeDir();
  const log = openSync(join(home, 'extension.log'), 'a');
  const child = spawn(process.execPath, [entry, 'extension', 'serve', `--port=${port}`], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: process.cwd(),
  });
  child.unref();
  try { closeSync(log); } catch { /* already gone */ }
  const pid = child.pid ?? 0;
  if (pid > 0) {
    writeFileSync(join(home, 'extension.pid'), String(pid));
    try {
      const v = createRequire(import.meta.url)('../package.json').version as string;
      writeFileSync(join(home, 'extension.version'), v);
    } catch { /* best effort */ }
  }
  return pid;
}

function recordedVersion(): string {
  try { return readFileSync(join(homeDir(), 'extension.version'), 'utf8').trim(); } catch { return ''; }
}

function cliVersion(): string {
  try { return createRequire(import.meta.url)('../package.json').version as string; } catch { return ''; }
}

/**
 * Idempotent: if OUR bridge already answers on the port, keep it (never
 * EADDRINUSE-race a second spawn). A recorded-version mismatch means the
 * daemon is a code snapshot from an older CLI → evict + respawn. Returns the
 * final probe so callers can report connected state without re-fetching.
 */
export async function ensureExtensionDaemon(port = DEFAULT_EXTENSION_PORT, entry = process.argv[1]): Promise<ExtensionProbe> {
  const pid = readExtensionPid();
  const served = await probeExtensionDaemon(port);
  const stale = pid > 0 && alive(pid) && recordedVersion() !== cliVersion();
  if (served.up && !stale) return served;
  if (stale) {
    stopExtensionDaemon(port);
    await waitExtensionPortFree(port);
  }
  spawnExtensionDaemon(entry, port);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probeExtensionDaemon(port);
    if (p.up) return p;
  }
  return { up: false, connected: false };
}

/** Simple start (no staleness handling): used by the explicit `start` command. */
export function startExtensionDaemon(port = DEFAULT_EXTENSION_PORT, entry = process.argv[1]): { already: boolean; pid: number } {
  const pid = readExtensionPid();
  if (pid && alive(pid)) return { already: true, pid };
  return { already: false, pid: spawnExtensionDaemon(entry, port) };
}
