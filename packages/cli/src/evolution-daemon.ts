/**
 * @hmharness/cli - evolution daemon (2026-09-23 direction fix)
 *
 * The evolution engine runs as a SILENT BACKGROUND PROCESS, exactly like the
 * web daemon. The user NEVER runs `hmh evolve` manually - it just happens.
 *
 * Lifecycle: starts automatically on `hmh tui` / `hmh web` / any command that
 * calls ensureEvolutionDaemon(). Runs one evolution cycle every
 * `evolution.autoEveryHours` hours (default 6h), then sleeps. After each
 * evolve cycle it also runs the auto-finetune gate (2026-09-25: labels past
 * threshold -> pairs exported -> uploaded -> cloud training submitted, all
 * unattended; `hmh auto-finetune` itself decides whether anything is due).
 *
 * 2026-09-25 bugfix: the runner used to be a .cjs file with top-level await
 * + ESM import statements - a SyntaxError at module load, so the daemon died
 * instantly on every start since 0.14.25 and the PID file was never written.
 * The runner is now plain CJS (require only) and verified with node --check.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
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

/** Build the runner source. Plain CJS - verified with node --check in the
 * daemon tests (the 0.14.25 version was silently broken ESM-in-CJS).
 * entryAbs: absolute path of the CLI's dist/main.js - the runner lives in
 * HMH_HOME, so relative resolution never finds the installed CLI (second
 * latent bug in the old runner). */
export function daemonRunnerSource(pidFile: string, entryAbs: string): string {
  const entryJson = JSON.stringify(entryAbs);
  return `
const { execFile } = require('node:child_process');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.HMH_HOME || join(require('node:os').homedir(), '.hmharness');
const hmhBin = process.execPath;
const hmhEntry = ${entryJson};
const HOURS = Number(process.env.HMH_EVOLVE_EVERY_HOURS || 6);
function stamp() { return new Date().toISOString(); }
function runHmh(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(hmhBin, [hmhEntry, ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}
async function cycle() {
  try {
    const evo = await runHmh(['evolve'], 600000);
    console.log(stamp(), 'evolve cycle done', evo.err ? ('err ' + String(evo.err).slice(0, 120)) : '');
  } catch (e) { console.error(stamp(), 'evolve error:', String(e).slice(0, 200)); }
  // finetune gate after every evolve cycle - the command itself decides
  // (labels threshold, no running job, cooldown, kill-switch) so an
  // unattended run is always safe and cheap when nothing is due
  try {
    const ft = await runHmh(['auto-finetune', '--submit'], 900000);
    const interesting = ft.out.split('\\n').filter((l) => l.includes('\\u2713') || l.includes('\\u5fae\\u8c03') || l.includes('ERR')).slice(0, 3);
    console.log(stamp(), 'finetune gate:', interesting.join(' | ') || 'not due');
  } catch (e) { console.error(stamp(), 'finetune error:', String(e).slice(0, 200)); }
}
writeFileSync(join(home, '${pidFile}'), String(process.pid));
setTimeout(cycle, 30000);
setInterval(cycle, HOURS * 3600000);
process.on('SIGTERM', () => { try { unlinkSync(join(home, '${pidFile}')); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { unlinkSync(join(home, '${pidFile}')); } catch {} process.exit(0); });
`;
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

  const runnerPath = join(home, 'evolution-daemon-runner.cjs');
  const entryAbs = join(import.meta.dirname ?? '.', 'main.js');
  writeFileSync(runnerPath, daemonRunnerSource(EVOL_DAEMON_PID, entryAbs), 'utf8');

  const log = openSync(join(home, EVOL_DAEMON_LOG), 'a');

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

export function daemonPidFileAlive(home: string): boolean {
  return existsSync(join(home, EVOL_DAEMON_PID)) && daemonPid(home) !== null;
}
