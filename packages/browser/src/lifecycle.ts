/**
 * @hmharness/browser - owned-instance lifecycle
 *
 * Launches a DEDICATED BrowserOS with:
 *   --remote-debugging-port=<port>   (standard Chromium switch — takes
 *                                     precedence over BrowserOS's managed
 *                                     CDP server, so no port fights)
 *   --user-data-dir=HMH_HOME/browser/profile  (never the daily profile)
 * and waits for the debugging endpoint. The instance SURVIVES the process
 * that started it (a visible window the user can watch and log into;
 * `hmh browser stop` is the off switch) — unlike LSP daemons, which are
 * invisible and therefore killed with the host. Exception: a headless
 * instance auto-started by an agent tool is killed on host exit so it
 * cannot rot as an invisible zombie.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverBrowsers, BROWSEROS_INSTALL_URL } from './registry.ts';
import { checkBrowserTrust } from './trust.ts';
import { CdpBrowser } from './cdp.ts';

/** hmh-owned instance CDP port. 9222 is the generic Chrome convention and
 *  often occupied by a user-launched debug browser; +1 keeps ours distinct. */
export const DEFAULT_CDP_PORT = 9223;

export interface OwnedInstance {
  pid: number;
  port: number;
  profileDir: string;
  startedAt: string;
}

export interface StartBrowserOptions {
  executablePath?: string;
  port?: number;
  headless?: boolean;
  /** true when an agent tool auto-started the instance (vs an explicit
   *  `hmh browser start`): only implicit headless instances are killed
   *  with the host — an explicit user start persists until `stop`. */
  implicit?: boolean;
}

interface InstanceFile extends OwnedInstance {
  /** set when the CURRENT process holds the child handle (headless auto-start) */
  killOnExit?: boolean;
}

function statePath(home: string): string {
  return join(home, 'browser', 'instance.json');
}

async function readState(home: string): Promise<InstanceFile | null> {
  try {
    return JSON.parse(await readFile(statePath(home), 'utf8')) as InstanceFile;
  } catch {
    return null;
  }
}

async function portReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** kill a process TREE (browsers spawn children; a bare kill orphans them) */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

/** Read the owned-instance state (for status/stop). */
export async function ownedInstance(home: string): Promise<{ instance: OwnedInstance; alive: boolean; reachable: boolean } | null> {
  const st = await readState(home);
  if (!st) return null;
  return { instance: st, alive: pidAlive(st.pid), reachable: await portReachable(st.port) };
}

/**
 * Ensure an owned BrowserOS is running. Idempotent: reuses the recorded
 * instance when its port answers; refuses to touch a foreign browser that
 * happens to sit on the port. Throws with actionable guidance otherwise.
 */
/** Resolve the pid actually LISTENING on a loopback port. On Windows a
 *  spawned chrome-family launcher hands off to a detached real browser
 *  process and exits — the child pid we hold is NOT the browser, so the
 *  port's listener is the only reliable handle for stop/kill. */
function pidForPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
      if (r.status !== 0) return null;
      for (const line of (r.stdout || '').split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t.length >= 5 && t[0] === 'TCP' && t[3] === 'LISTENING' && t[1]?.endsWith(`:${port}`)) {
          const pid = Number(t[4]);
          if (Number.isInteger(pid) && pid > 0) return pid;
        }
      }
      return null;
    }
    const r = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5_000 });
    if (r.status !== 0) return null;
    const pid = Number((r.stdout || '').split('\n').filter(Boolean)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function startBrowser(home: string, opts: StartBrowserOptions = {}): Promise<OwnedInstance> {
  const port = opts.port ?? DEFAULT_CDP_PORT;
  const existing = await readState(home);
  if (existing && await portReachable(existing.port) && pidAlive(existing.pid)) {
    return existing; // already ours, still alive
  }
  if (existing && !pidAlive(existing.pid)) {
    await rm(statePath(home), { force: true }); // stale record for a dead browser
  }
  if (await portReachable(port)) {
    throw new Error(`port ${port} answers but is NOT an hmh-started browser (no live instance record) — pass --port=<other> or free the port`);
  }

  // force re-discovery when an explicit executable is configured (the
  // memoized cache may predate the config)
  const found = discoverBrowsers(Boolean(opts.executablePath), { executablePath: opts.executablePath }).filter((b) => b.healthy);
  const browser = found[0];
  if (!browser) {
    throw new Error(`BrowserOS not found on this machine — install it from ${BROWSEROS_INSTALL_URL} (or set browser.executablePath in config.json). Discovered: ${found.length ? 'only unhealthy candidates' : 'nothing'}`);
  }
  const verdict = await checkBrowserTrust(home, browser);
  if (!verdict.trusted) {
    throw new Error(`browseros blocked by source trust: ${verdict.reason}`);
  }

  const profileDir = join(home, 'browser', 'profile');
  await mkdir(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push('about:blank');

  // The spawned process is only a LAUNCHER on Windows (it re-execs the
  // real browser detached and exits), so the port — not the child — is
  // the source of truth for "up", and the listener pid is the only
  // reliable handle for stopping.
  const child = spawn(browser.command, args, { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: false });
  if (child.pid === undefined) {
    throw new Error(`failed to spawn BrowserOS (binary: ${browser.command})`);
  }
  child.unref();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await portReachable(port)) {
      const pid = pidForPort(port) ?? child.pid;
      const instance: OwnedInstance = { pid, port, profileDir, startedAt: new Date().toISOString() };
      const record: InstanceFile = { ...instance, killOnExit: Boolean(opts.implicit && opts.headless) && process.env.HMH_BROWSER_PERSIST !== '1' };
      await mkdir(join(home, 'browser'), { recursive: true });
      await writeFile(statePath(home), JSON.stringify(record, null, 1), 'utf8');
      if (record.killOnExit) process.once('exit', () => killTree(pid));
      return instance;
    }
    if (process.platform !== 'win32' && child.exitCode !== null) break; // unix: no handoff, a dead child stays dead
    await new Promise((r) => setTimeout(r, 300));
  }
  killTree(pidForPort(port) ?? child.pid);
  throw new Error(`BrowserOS did not open its debugging port ${port} within 25s (binary: ${browser.command})`);
}

/** Stop the owned instance (never touches the user's daily browser). */
export async function stopBrowser(home: string): Promise<{ stopped: boolean; detail: string }> {
  const st = await readState(home);
  if (!st) {
    return { stopped: false, detail: `no hmh-owned browser recorded (nothing was started via hmh browser start)` };
  }
  if (!pidAlive(st.pid)) {
    await rm(statePath(home), { force: true });
    return { stopped: false, detail: 'recorded instance is already gone (state cleaned)' };
  }
  killTree(st.pid);
  await rm(statePath(home), { force: true });
  return { stopped: true, detail: `killed pid ${st.pid} (CDP port ${st.port})` };
}

/** Create a client bound to the owned instance (convenience for tools). */
export async function clientForInstance(home: string, opts: StartBrowserOptions = {}): Promise<{ client: CdpBrowser; instance: OwnedInstance }> {
  const instance = await startBrowser(home, opts);
  return { client: new CdpBrowser({ port: instance.port }), instance };
}
