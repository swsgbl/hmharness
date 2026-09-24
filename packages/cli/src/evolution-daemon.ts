/**
 * @hmharness/cli - evolution daemon (2026-09-23 direction fix)
 *
 * The evolution engine runs as a SILENT BACKGROUND PROCESS, exactly like the
 * web daemon. The user NEVER runs `hmh evolve` manually - it just happens.
 *
 * Lifecycle: starts automatically on `hmh tui` / `hmh web` / any command that
 * calls ensureEvolutionDaemon(). Runs one evolution cycle every
 * `evolution.autoEveryHours` hours (default 6h), then sleeps.
 *
 * The user experience: install hmh, enter API key, use it. The system gets
 * smarter on its own. That's it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';

const EVOL_DAEMON_PID = 'evolution-daemon.pid';
const EVOL_DAEMON_LOG = 'evolution-daemon.log';

function daemonPid(home: string): number | null {
  try {
    const raw = readFileSync(join(home, EVOL_DAEMON_PID), 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid)) return null;
    // check alive (Windows: process.kill with signal 0 throws if dead)
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

export interface EvolDaemonStatus {
  running: boolean;
  pid?: number;
  started: boolean;
}

/**
 * Idempotent: if the daemon is already alive, return its pid. Otherwise
 * spawn a detached node process that runs evolution cycles on a schedule.
 * Never blocks the caller - fire-and-forget.
 */
export function ensureEvolutionDaemon(): EvolDaemonStatus {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const existing = daemonPid(home);
  if (existing) return { running: true, pid: existing, started: false };

  const entry = join(import.meta.dirname ?? '.', 'evolution-daemon-runner.mjs');
  // inline runner: import the CLI main and call runEvolution on a timer
  const runnerCode = `
const { runEvolution } = await import('./dist/evolution-evolve.js').catch(() => ({}));
// fallback: use the CLI's evolve path
import { execFile } from 'node:child_process';
import { join } from 'node:path';
const home = process.env.HMH_HOME || join(require('node:os').homedir(), '.hmharness');
const hmhBin = process.execPath;
const hmhEntry = join(import.meta.dirname, 'dist', 'main.js');
const HOURS = Number(process.env.HMH_EVOLVE_EVERY_HOURS || 6);
async function cycle() {
  try {
    const { execFile: ef } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(ef);
    const r = await run(hmhBin, [hmhEntry, 'evolve'], { timeout: 600000, cwd: home }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }));
    console.log(new Date().toISOString(), 'evolve cycle done');
  } catch (e) { console.error(new Date().toISOString(), 'evolve error:', String(e).slice(0, 200)); }
}
// write pid immediately
require('node:fs').writeFileSync(join(home, '${EVOL_DAEMON_PID}'), String(process.pid));
// run first cycle after 30s (let the caller finish startup), then every N hours
setTimeout(cycle, 30000);
setInterval(cycle, HOURS * 3600000);
// cleanup on exit
process.on('SIGTERM', () => { require('node:fs').unlinkSync(join(home, '${EVOL_DAEMON_PID}')); process.exit(0); });
process.on('SIGINT', () => { try { require('node:fs').unlinkSync(join(home, '${EVOL_DAEMON_PID}')); } catch {} process.exit(0); });
`;

  // write the runner to a temp file in HMH_HOME
  const runnerPath = join(home, 'evolution-daemon-runner.cjs');
  writeFileSync(runnerPath, runnerCode, 'utf8');

  const log = ((): number => {
    try { return require('node:fs').openSync(join(home, EVOL_DAEMON_LOG), 'a'); }
    catch { return 0; }
  })();

  const child = spawn(process.execPath, [runnerPath], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, HMH_HOME: home },
  });
  child.unref();
  return { running: true, pid: child.pid, started: true };
}

export function stopEvolutionDaemon(): boolean {
  const home = homeDir();
  const pid = daemonPid(home);
  if (!pid) return false;
  try { process.kill(pid); } catch { }
  try { require('node:fs').unlinkSync(join(home, EVOL_DAEMON_PID)); } catch { }
  return true;
}
