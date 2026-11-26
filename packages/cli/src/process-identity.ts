/**
 * @hmharness/cli - is that process ours?
 *
 * Every daemon here is managed through a pid file under HMH_HOME, and a pid
 * file outlives its process: a daemon killed on Windows (taskkill, logoff) gets
 * no SIGTERM and never cleans up after itself, and every OS reuses pids. So
 * "the pid is alive" does not mean "the daemon is running" - it may be a
 * stranger wearing the old number. Killing it (`hmh web stop`, the extension
 * watchdog's 60s sweep) is the worst outcome; trusting it is quieter but just
 * as real, because a daemon that "is running" is never started again.
 *
 * The command line tells them apart. It is read with the platform's own tool
 * (PowerShell CIM on Windows, /proc or ps elsewhere). When it cannot be read
 * at all the answer is `unknown`, and each caller then falls back to what it
 * always did - it just no longer acts on a process it can see is not ours.
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type ProcessIdentity = 'self' | 'other' | 'unknown';

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill a daemon and whatever it spawned. Best effort - a process that is already gone is not an error. */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(pid); } catch { /* gone */ } }
}

/** The command line of a process, or null when it cannot be read
 *  (not running under this account, no query tool on this platform). */
export function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: 'utf8', timeout: 8000 },
      ).trim();
      return out || null;
    }
    try {
      // Linux: /proc is exact and needs no tool (absent on macOS -> ps)
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    } catch {
      return execSync(`ps -o args= -p ${pid}`, { encoding: 'utf8', timeout: 5000 }).trim() || null;
    }
  } catch {
    return null;
  }
}

// A pid's identity does not change while it lives, but one CLI run asks about
// the same daemon several times (stop, evict, respawn) and each query is a
// PowerShell start on Windows - remember the answer for a moment.
const recent = new Map<number, { at: number; id: ProcessIdentity }>();
const REMEMBER_MS = 10_000;

/** Is the live process behind `pid` one of ours, judged by its command line? */
export function identifyProcess(pid: number, isOurs: (commandLine: string) => boolean): ProcessIdentity {
  const hit = recent.get(pid);
  if (hit && Date.now() - hit.at < REMEMBER_MS) return hit.id;
  const cmd = commandLineOf(pid);
  const id: ProcessIdentity = cmd === null ? 'unknown' : isOurs(cmd) ? 'self' : 'other';
  recent.set(pid, { at: Date.now(), id });
  return id;
}

/** Test hook: forget every remembered identity. */
export function forgetIdentities(): void {
  recent.clear();
}
