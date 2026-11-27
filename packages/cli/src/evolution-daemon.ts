/**
 * @hmharness/cli - evolution daemon (2026-09-23 direction fix)
 *
 * The evolution engine runs as a SILENT BACKGROUND PROCESS, exactly like the
 * web daemon. The user NEVER runs `hmh evolve` manually - it just happens.
 *
 * Lifecycle: starts automatically on `hmh web start` (and `hmh evolve-auto`).
 * Runs one evolution cycle every `evolution.autoEveryHours` hours (default
 * 6h), then sleeps. `hmh web stop` stops it again (0.23.55: until then nothing
 * could - it kept cycling, and spending model quota, after "stop"). After each
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
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';
import { identifyProcess, isAlive, killProcessTree } from './process-identity.ts';

const EVOL_DAEMON_PID = 'evolution-daemon.pid';
const EVOL_DAEMON_LOG = 'evolution-daemon.log';
const RUNNER_NAME = 'evolution-daemon-runner';

/** The pid of the RUNNING evolution daemon, or null. The pid file alone proves
 *  nothing: it outlives its process (a runner killed on Windows gets no
 *  SIGTERM, so it never cleans up after itself) and pids are reused. Until
 *  0.23.55 a stranger wearing the old number read as "daemon alive" - evolution
 *  silently never restarted - and `hmh web stop` would have killed it.
 *  A command line that cannot be read at all keeps the old trust in the pid. */
function daemonPid(home: string): number | null {
  let pid: number;
  try {
    const n = Number(readFileSync(join(home, EVOL_DAEMON_PID), 'utf8').trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    pid = n;
  } catch { return null; }
  if (!isAlive(pid)) return null;
  return identifyProcess(pid, (cmd) => cmd.includes(RUNNER_NAME)) === 'other' ? null : pid;
}

/** The running daemon's pid (null when none) - read-only, for `hmh web status`. */
export function evolutionDaemonPid(home: string = homeDir()): number | null {
  return daemonPid(home);
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
// How long one evolve cycle may take. It was 30 minutes until 0.23.56 - and on
// the machine this was diagnosed on (2026-11-26) EVERY runner cycle died at
// exactly that limit, while the same cycles started from inside the app (no
// limit) ran to completion. A healthy cycle is dozens of real model calls plus
// tool runs; the cap has to be far above a slow one, and the interval (hours)
// keeps the next one from piling on.
const CYCLE_TIMEOUT_MS = Number(process.env.HMH_EVOLVE_TIMEOUT_MS || 3 * 60 * 60 * 1000);
const FIRST_CYCLE_MS = Number(process.env.HMH_FIRST_CYCLE_MS || 30000);
function stamp() { return new Date().toISOString(); }
var ANSI = /\\u001b\\[[0-9;]*m/g;
function duration(ms) { return ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min'; }
// the last lines of a command's output, on one line: what a killed or failed
// cycle was doing when it stopped - the log used to hold only "Command failed"
function tailOf(out, n) {
  return String(out || '').replace(ANSI, '').split(/\\r?\\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(-n).join(' | ');
}
function runHmh(args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(hmhBin, [hmhEntry, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '') + String(stderr || ''), ms: Date.now() - started });
    });
  });
}
// one cycle at a time: a long cycle must not be overlapped by the next tick
// (two concurrent cycles would race the same files and double the model spend)
var busy = false;
async function cycle() {
  if (busy) { console.log(stamp(), 'evolve cycle skipped - the previous one is still running'); return; }
  busy = true;
  try {
    console.log(stamp(), 'evolve cycle started');
    const evo = await runHmh(['evolve'], CYCLE_TIMEOUT_MS);
    if (evo.err) {
      const why = evo.err.killed ? 'KILLED at the ' + duration(CYCLE_TIMEOUT_MS) + ' limit' : 'exit ' + (evo.err.code === undefined ? String(evo.err.signal) : String(evo.err.code));
      console.error(stamp(), 'evolve cycle FAILED after ' + duration(evo.ms) + ' - ' + why + ' | last output: ' + tailOf(evo.out, 8));
    } else {
      console.log(stamp(), 'evolve cycle done in ' + duration(evo.ms) + ' | ' + tailOf(evo.out, 4));
    }
  } catch (e) { console.error(stamp(), 'evolve error:', String(e).slice(0, 200)); }
  // finetune gate after every evolve cycle - the command itself decides
  // (labels threshold, no running job, cooldown, kill switch, a retired
  // provider) so an unattended run is always safe and cheap when nothing is due
  try {
    const ft = await runHmh(['auto-finetune', '--submit'], 900000);
    // The ENDING of the output is what happened: submitted, files reused,
    // upload failed, provider retired, nothing due. Until 0.23.59 the first
    // three lines that mentioned fine-tuning were logged instead, and 50 days
    // of "上传失败" (2026-10-08 .. 11-27) hid behind the same three lines.
    console.log(stamp(), 'finetune gate (' + duration(ft.ms) + '):', tailOf(ft.out, 3));
  } catch (e) { console.error(stamp(), 'finetune error:', String(e).slice(0, 200)); }
  busy = false;
}
writeFileSync(join(home, '${pidFile}'), String(process.pid));
setTimeout(cycle, FIRST_CYCLE_MS);
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

  const { runnerPath, cwd } = evolutionSpawnOptions(home);
  const entryAbs = join(import.meta.dirname ?? '.', 'main.js');
  writeFileSync(runnerPath, daemonRunnerSource(EVOL_DAEMON_PID, entryAbs), 'utf8');

  const log = openSync(join(home, EVOL_DAEMON_LOG), 'a');

  const child = spawn(process.execPath, [runnerPath], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd,
    env: { ...process.env, HMH_HOME: home },
  });
  child.unref();
  // the child inherited a dup of this fd; closing ours prevents the
  // "Closing file descriptor on garbage collection" startup warnings.
  // (An ESM module has no `require`: the old `require('node:fs').closeSync`
  // here always threw and was swallowed by the empty catch.)
  try { closeSync(log); } catch { /* already gone */ }
  return { running: true, pid: child.pid, started: true };
}

/** The runner file and the directory it is launched in. The runner's cwd is
 *  inherited by every `hmh evolve` / `auto-finetune` child, and the bench
 *  cases run their tools in it, so it must be a directory of the daemon's own -
 *  not whichever folder happened to launch it (the Startup folder's, a
 *  project's, the installed package's: a live cwd handle there blocks the next
 *  upgrade on Windows). Created on demand. */
export function evolutionSpawnOptions(home: string): { runnerPath: string; cwd: string } {
  const cwd = join(home, 'evolution', 'scratch');
  mkdirSync(cwd, { recursive: true });
  return { runnerPath: join(home, `${RUNNER_NAME}.cjs`), cwd };
}

export function stopEvolutionDaemon(): boolean {
  const home = homeDir();
  const pid = daemonPid(home);
  // gone either way: the file names a dead runner, or a stranger - and a
  // stranger is NOT killed (the old code trusted the number)
  try { unlinkSync(join(home, EVOL_DAEMON_PID)); } catch { /* absent */ }
  if (!pid) return false;
  // the whole tree: a cycle in flight is a child of the runner, and on Windows
  // ending the runner alone left that child calling the model for up to 30 minutes
  killProcessTree(pid);
  return true;
}

export function daemonPidFileAlive(home: string): boolean {
  return existsSync(join(home, EVOL_DAEMON_PID)) && daemonPid(home) !== null;
}
