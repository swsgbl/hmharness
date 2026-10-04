/**
 * @hmharness/browser - BrowserOS discovery + running-instance detection
 *
 * BrowserOS (browseros-ai/BrowserOS) is a Chromium fork, so the control
 * plane is the Chrome DevTools Protocol it inherits: launch a DEDICATED
 * instance with --remote-debugging-port + own profile, drive it over the
 * loopback. Discovery is install-roots + PATH (+ config override) — the
 * lsp registry pattern. Automatic downloads are explicitly NOT done here
 * (supply chain; source allowlist + sha256 pinning is trust.ts's job).
 *
 * A user's DAILY BrowserOS is detected (Local State prefs carry its
 * managed CDP port, default 9100, and MCP proxy port, default 9000) but
 * never driven: hmh launches its own instance instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const BROWSEROS_INSTALL_URL = 'https://www.browseros.com';
export const BROWSEROS_REPO_URL = 'https://github.com/browseros-ai/BrowserOS';

export interface DiscoveredBrowser {
  id: string;
  command: string;
  product: 'browseros';
  origin: 'install-local' | 'PATH' | 'config';
  /** a real Chromium binary is >100MB; a broken shim/stub is not */
  healthy: boolean;
  unhealthyReason?: string;
  /** from `--version` when the platform prints it (Windows GUI subsystem
   *  stays silent — silence is not unhealthiness for a browser binary) */
  version?: string;
}

/** Default per-user install roots for the classic BrowserOS build.
 *  Real-machine layout (2026-10, Win): %LOCALAPPDATA%\BrowserOS\Application\
 *  with the executable named CHROME.EXE (Chromium's own name — the product
 *  docs say "BrowserOS.exe" but the installed tree keeps chrome.exe);
 *  BrowserOS.exe is probed too in case other installers rename it. */
export function browserosRoots(): string[] {
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  if (process.platform === 'win32') {
    const bases = [la, pf, pf86].filter(Boolean) as string[];
    const out: string[] = [];
    for (const b of bases) {
      out.push(join(b, 'BrowserOS', 'Application', 'chrome.exe'));
      out.push(join(b, 'BrowserOS', 'Application', 'BrowserOS.exe'));
    }
    return out;
  }
  if (process.platform === 'darwin') {
    return ['/Applications/BrowserOS.app/Contents/MacOS/BrowserOS'];
  }
  return ['/usr/lib/browseros/browseros', '/opt/browseros/browseros', join(homedir(), '.local', 'bin', 'browseros')];
}

/** Default user-data-dir of the user's DAILY BrowserOS (detection only). */
export function browserosUserDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BrowserOS', 'User Data');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BrowserOS');
  }
  return join(homedir(), '.config', 'browser-os');
}

function which(cmd: string): string | null {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `where ${cmd}`], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    : spawnSync('which', [cmd], { encoding: 'utf8', timeout: 5_000 });
  if (probe.status !== 0) return null;
  const first = (probe.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return first ?? null;
}

/** Health = a plausible Chromium binary on disk. The binary is NEVER
 *  EXECUTED for probing: on Windows, chrome-family `--version` LAUNCHES
 *  THE BROWSER (GUI-subsystem quirk — observed popping a full BrowserOS
 *  instance on every `hmh` startup). Version info, when wanted, is parsed
 *  from the versioned directory that ships beside the executable
 *  (Application/<ver>/chrome.exe layout). */
function healthProbe(command: string): { healthy: boolean; reason?: string; version?: string } {
  try {
    const size = statSync(command).size;
    if (size < 1_000_000) return { healthy: false, reason: `suspiciously small for a browser binary (${size} bytes)` };
  } catch {
    return { healthy: false, reason: 'not readable on disk' };
  }
  let version: string | undefined;
  try {
    const dir = dirname(command);
    const m = basename(dir).match(/^\d+\.\d+\.\d+\.\d+$/);
    if (m) version = m[0];
  } catch { /* version display is optional */ }
  return { healthy: true, version };
}

/** Discover BrowserOS on THIS machine (install roots > PATH > config
 *  override). Memoized; force re-probes. */
let discoveryCache: DiscoveredBrowser[] | null = null;
export function discoverBrowsers(force = false, opts: { roots?: string[]; executablePath?: string } = {}): DiscoveredBrowser[] {
  if (!force && discoveryCache) return discoveryCache;
  const out: DiscoveredBrowser[] = [];
  const push = (command: string, origin: DiscoveredBrowser['origin']) => {
    const h = healthProbe(command);
    out.push({ id: 'browseros', command, product: 'browseros', origin, healthy: h.healthy, unhealthyReason: h.reason, version: h.version });
  };
  // 1. config override — the user wrote this path deliberately, highest precedence
  if (opts.executablePath && existsSync(opts.executablePath)) push(opts.executablePath, 'config');
  // 2. official install layout
  for (const root of opts.roots ?? browserosRoots()) {
    if (existsSync(root)) push(root, 'install-local');
  }
  // 3. PATH
  const onPath = which('browseros') ?? (process.platform === 'win32' ? which('BrowserOS.exe') : null);
  if (onPath) push(onPath, 'PATH');
  // first (preferred) source wins; config never duplicates a discovered copy
  const seen = new Set<string>();
  discoveryCache = out.filter((b) => (seen.has(b.command) ? false : (seen.add(b.command), true)));
  return discoveryCache;
}

export interface RunningDetection {
  running: boolean;
  /** managed CDP port of the daily instance (default 9100) */
  cdpPort?: number;
  /** MCP proxy port of the daily instance (default 9000) */
  mcpPort?: number;
}

/** Detect the user's DAILY BrowserOS: Chromium writes its managed ports
 *  into Local State (`browseros.server.cdp_port` / `.proxy_port`). Purely
 *  informational — hmh never attaches to this instance. */
export async function detectRunning(userDataDir = browserosUserDataDir()): Promise<RunningDetection> {
  let cdpPort = 9100;
  let mcpPort = 9000;
  try {
    const localState = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8')) as {
      browseros?: { server?: { cdp_port?: number; proxy_port?: number } };
    };
    if (localState.browseros?.server?.cdp_port) cdpPort = localState.browseros.server.cdp_port;
    if (localState.browseros?.server?.proxy_port) mcpPort = localState.browseros.server.proxy_port;
  } catch {
    return { running: false };
  }
  // any HTTP answer (even 404/405) proves a listener; only a network error proves absence
  for (const port of [cdpPort, mcpPort]) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      return { running: true, cdpPort, mcpPort };
    } catch { /* try the other port */ }
  }
  return { running: false };
}
