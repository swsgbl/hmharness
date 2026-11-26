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
import { pathToFileURL } from 'node:url';
import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';
import { daemonCwd } from './daemon-cwd.ts';
import { identifyProcess, isAlive, killProcessTree, type ProcessIdentity } from './process-identity.ts';

export const DEFAULT_EXTENSION_PORT = 7789;

export function readExtensionPid(): number {
  try {
    const p = Number(readFileSync(join(homeDir(), 'extension.pid'), 'utf8').trim());
    return Number.isFinite(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

/** Is the process the bridge of ours (`main.js extension serve`), or one of
 *  its watchdogs (the detached one, or the scheduled task's entry script)?
 *  Every kill below is gated on this. The bridge used to be stopped BLIND:
 *  `extension stop` and the watchdog's 60s sweep taskkilled whatever the pid
 *  file or the port named - a stranger behind a stale pid, or another program
 *  that happened to sit on 7789, killed over and over, once a minute. */
function bridgeIdentity(pid: number): ProcessIdentity {
  return identifyProcess(pid, (cmd) =>
    /(^|\s)extension\s+serve\b/.test(cmd)
    || /extension-watchdog-task\.cjs/.test(cmd)
    || (/extension-daemon\.js/.test(cmd) && /runWatchdogLoop/.test(cmd)));
}

/** May the holder of the bridge port be evicted? Only something we can name as
 *  ours; where the command line cannot be read, the old trust stands off Windows. */
function evictable(id: ProcessIdentity): boolean {
  return id === 'self' || (id === 'unknown' && process.platform !== 'win32');
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
  if (pid && isAlive(pid)) {
    // only the bridge of OURS: a stale pid file plus a reused pid names a stranger
    if (bridgeIdentity(pid) !== 'other') {
      killProcessTree(pid);
      killed = true;
    } else {
      console.error(`[extension] extension.pid names pid ${pid}, which is not an hmh bridge - left alone`);
    }
  }
  try { unlinkSync(join(homeDir(), 'extension.pid')); } catch { /* absent */ }
  // a stale pid file while the port is still held: evict only our own orphan.
  // A foreign program on the port is NOT ours to kill - and the watchdog
  // runs this every minute, so a blind kill here meant killing it once a minute
  const owner = portOwnerPid(port);
  if (owner && owner !== pid) {
    if (evictable(bridgeIdentity(owner))) {
      killProcessTree(owner);
      killed = true;
    } else {
      console.error(`[extension] port ${port} is held by a non-hmh process - not evicting`);
    }
  }
  return killed;
}

/** Is the port held by a process that is not ours (so no bridge may be spawned into it)? */
function foreignHolder(port: number): boolean {
  const owner = portOwnerPid(port);
  return !!owner && !evictable(bridgeIdentity(owner));
}

/** Spawn the bridge detached (no window). extraArgs carries --port through. */
function spawnExtensionDaemon(entry: string, port: number): number {
  const home = homeDir();
  const log = openSync(join(home, 'extension.log'), 'a');
  const child = spawn(process.execPath, [entry, 'extension', 'serve', `--port=${port}`], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: daemonCwd(process.cwd(), entry),
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
  // stale = a bridge of OURS from an older CLI (a stranger behind the pid file is not a stale bridge)
  const stale = pid > 0 && isAlive(pid) && recordedVersion() !== cliVersion() && bridgeIdentity(pid) !== 'other';
  if (served.up && !stale) return served;
  // dead or stale: clear whatever is OURS off the port, then bring the bridge back
  stopExtensionDaemon(port);
  await waitExtensionPortFree(port);
  // someone else holds the port: stay down. A bridge spawned into it only dies
  // on EADDRINUSE - and from the watchdog that meant a dead spawn once a minute
  if (foreignHolder(port)) return { up: false, connected: false };
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
  // "already running" only for the bridge of ours (a stale pid file may name a stranger)
  if (pid && isAlive(pid) && bridgeIdentity(pid) !== 'other') return { already: true, pid };
  return { already: false, pid: spawnExtensionDaemon(entry, port) };
}

// --------------------------------------------------------------- watchdog

/** Path of the watchdog pid file under HMH_HOME. */
export function watchdogPidPath(): string {
  return join(homeDir(), 'extension-watchdog.pid');
}

/**
 * Watchdog body (runs INSIDE the detached watchdog process): probe the
 * bridge every 60s; dead or stale → respawn it. Idempotent by design —
 * a second watchdog exits when the pid file already names a live process.
 * The bridge dying must never be a state the user can observe (round 54:
 * "插件又不能用了" = the daemon had silently died and nothing revived it).
 */
export async function runWatchdogLoop(port: number, entry: string): Promise<never> {
  const wp = watchdogPidPath();
  try {
    const existing = Number(readFileSync(wp, 'utf8').trim());
    // another watchdog is on duty - but only a real one: a stranger behind a stale
    // pid file used to make every new watchdog exit at once, leaving nobody on duty
    if (Number.isFinite(existing) && existing > 0 && existing !== process.pid && isAlive(existing) && bridgeIdentity(existing) !== 'other') {
      process.exit(0);
    }
  } catch { /* no pid file yet */ }
  writeFileSync(wp, String(process.pid));
  for (;;) {
    try {
      const served = await probeExtensionDaemon(port);
      const pid = readExtensionPid();
      const stale = pid > 0 && isAlive(pid) && recordedVersion() !== cliVersion() && bridgeIdentity(pid) !== 'other';
      if (!served.up || stale) {
        // what is ours gets cleared off the port (a hung bridge included); a
        // foreign holder is left alone and no doomed spawn is made into it
        stopExtensionDaemon(port);
        await waitExtensionPortFree(port, 3000);
        if (!foreignHolder(port)) spawnExtensionDaemon(entry, port);
      }
    } catch { /* a watchdog that throws is a watchdog that dies — never */ }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** Spawn the watchdog detached (no window). Safe to call repeatedly. */
export function startWatchdog(port = DEFAULT_EXTENSION_PORT, entry = process.argv[1]): number {
  try {
    const wp = watchdogPidPath();
    const existing = Number(readFileSync(wp, 'utf8').trim());
    if (Number.isFinite(existing) && existing > 0 && isAlive(existing) && bridgeIdentity(existing) !== 'other') return existing;
  } catch { /* none yet */ }
  const log = openSync(join(homeDir(), 'extension-watchdog.log'), 'a');
  const child = spawn(process.execPath, [
    '-e',
    `import('${pathToFileURL(entry).href.replace(/main\.js$/, 'extension-daemon.js')}').then(m => m.runWatchdogLoop(${port}, ${JSON.stringify(entry)}))`,
  ], { detached: true, stdio: ['ignore', log, log], windowsHide: true, cwd: daemonCwd(process.cwd(), entry) });
  child.unref();
  try { closeSync(log); } catch { /* gone */ }
  return child.pid ?? 0;
}

/** Stop the watchdog (used by `extension stop` — it must not resurrect). */
const WATCHDOG_TASK = 'hmharness-extension-watchdog';

/** Windows scheduled-task watchdog: the OS revives the watchdog every
 *  minute REGARDLESS of process trees, logoffs, or test sweeps — detached
 *  pids died twice in the field (round 55/56), a SYSTEM timer cannot.
 *  Field-hardened: (a) the task entry is a PLAIN SCRIPT FILE — inline -e
 *  code gets its quotes eaten by schtasks/TR; (b) run through `cmd /c
 *  start /b` so the SYSTEM-triggered run inherits the user env chain
 *  (mise shim dies without HOME); (c) node path = process.execPath — a
 *  hardcoded Program Files path silently ENOENTs on mise machines. */
export function installScheduledWatchdog(port = DEFAULT_EXTENSION_PORT): boolean {
  if (process.platform !== 'win32') return false;
  const entry = process.argv[1];
  const taskEntry = join(entry, '..', 'extension-watchdog-task.cjs');
  try {
    writeFileSync(taskEntry, [
      `// auto-generated by hmh extension start — scheduled-task watchdog entry`,
      `const { pathToFileURL } = require('node:url');`,
      `const ENTRY = ${JSON.stringify(entry)};`,
      `import(pathToFileURL(${JSON.stringify(join(entry, '..', 'extension-daemon.js'))}).href)`,
      `  .then((m) => m.runWatchdogLoop(${port}, ENTRY))`,
      `  .catch((e) => { try { require('node:fs').appendFileSync(require('node:path').join(require('node:os').homedir(), '.hmharness', 'extension-watchdog.log'), 'task entry error: ' + String(e) + '\\n'); } catch { /* */ } });`,
      ``,
    ].join('\n'), 'utf8');
  } catch { return false; }
  const node = process.execPath.replace(/'/g, "''");
  const ps = [
    `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c start "" /b "${node}" "${taskEntry.replace(/\\/g, '\\\\')}"'`,
    `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew`,
    `Register-ScheduledTask -TaskName '${WATCHDOG_TASK}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    `Write-Host ok`,
  ].join('; ');
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return out.includes('ok');
  } catch {
    try {
      execSync(`schtasks /Query /TN ${WATCHDOG_TASK}`, { stdio: 'ignore', timeout: 10_000 });
      return true; // an existing task under our name is acceptable
    } catch { return false; }
  }
}

export function uninstallScheduledWatchdog(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execSync(`schtasks /Delete /F /TN ${WATCHDOG_TASK}`, { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch { return false; }
}

export function stopWatchdog(): boolean {
  try {
    const wp = watchdogPidPath();
    const pid = Number(readFileSync(wp, 'utf8').trim());
    // only a watchdog of ours gets killed - a stale pid file may name anyone
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid) && bridgeIdentity(pid) !== 'other') {
      killProcessTree(pid);
      try { unlinkSync(wp); } catch { /* absent */ }
      return true;
    }
    try { unlinkSync(wp); } catch { /* absent */ }
  } catch { /* none */ }
  return false;
}
