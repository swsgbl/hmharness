/**
 * @hmharness/web - internet tunnel (deepseek-harness pattern)
 * Gives the phone an https URL that works from ANY network (4G/5G/other WiFi)
 * without firewall/port-forward config, by relaying through a free tunnel:
 *   1. cloudflared Quick Tunnel (default): auto-downloads the binary from
 *      GitHub releases, runs `tunnel --url http://127.0.0.1:<port>`, parses
 *      the https://*.trycloudflare.com URL from stdout.
 *   2. pinggy (fallback): plain `ssh -R 0:localhost:<port> free.pinggy.io`,
 *      parses the https://*.pinggy.link URL. No account, no install.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createConnection } from 'node:net';

export type TunnelProvider = 'cloudflare' | 'pinggy';
export interface TunnelState {
  active: boolean;
  loading: boolean;
  url?: string;
  provider?: TunnelProvider;
  error?: string;
  startedAt?: number;
}

const CLOUDFLARED_VERSION = '2026.8.2'; // pinned like DSH Desktop
const START_TIMEOUT_MS = 45_000;

function binDir(): string {
  return join(homedir(), '.hmharness', 'bin');
}

function cloudflaredPath(): string {
  return join(binDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

export function extractTryCloudflareUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
  return m && m[0].toLowerCase() !== 'https://api.trycloudflare.com' ? m[0] : undefined;
}

export function extractPinggyUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:pinggy(?:-free)?\.link|pinggy\.online)/i);
  return m?.[0];
}

export function isInternetTunnelHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    (h.endsWith('.trycloudflare.com') && h !== 'api.trycloudflare.com') ||
    h.endsWith('.pinggy.link') ||
    h.endsWith('.pinggy-free.link') ||
    h.endsWith('.pinggy.online')
  );
}

function run(cmd: string, args: string[], timeoutMs = 5_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? '') });
      });
      if (!child) resolve({ ok: false, stdout: '' });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

async function findCloudflaredOnPath(): Promise<string | undefined> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = await run(probe, ['cloudflared']);
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return r.ok && first ? first : undefined;
}

/** Download via the OS curl (Windows ships C:\Windows\System32\curl.exe) -
 *  native redirect/proxy/retry handling beats fetch for big GitHub blobs
 *  on flaky links. Order: direct, then the local socks5 proxy if its port
 *  answers (xray et al), then fetch as a last resort. */
async function download(url: string, dest: string, log?: (m: string) => void): Promise<void> {
  const curl = process.platform === 'win32' ? 'C:\\Windows\\System32\\curl.exe' : 'curl';
  const tries: string[][] = [[]];
  // probe the common local socks5 port before routing through it
  const proxyOk = await new Promise<boolean>((ok) => {
    const s = createConnection({ host: '127.0.0.1', port: 10808, timeout: 800 });
    s.once('connect', () => { s.destroy(); ok(true); });
    s.once('error', () => ok(false));
    s.once('timeout', () => { s.destroy(); ok(false); });
  });
  if (proxyOk) tries.push(['-x', 'socks5h://127.0.0.1:10808']);
  let lastErr = '';
  for (const extra of tries) {
    const r = await run(curl, [...extra, '-L', '--fail', '--retry', '2', '--max-time', '240', '--silent', '--show-error', '-o', dest, url], 300_000);
    if (r.ok && existsSync(dest) && statSync(dest).size > 20_000_000) return;
    lastErr = `curl ${extra.join(' ')} failed${r.stdout ? ': ' + r.stdout.trim().slice(0, 120) : ''}`;
    log?.(`[tunnel] ${lastErr}, trying next route…`);
    if (existsSync(dest)) unlinkSync(dest);
  }
  // last resort: node fetch (undici) direct
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    if (statSync(dest).size > 20_000_000) return;
    unlinkSync(dest);
    throw new Error('download truncated');
  } catch (err) {
    if (existsSync(dest)) unlinkSync(dest);
    throw new Error(`${lastErr}; fetch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ensureCloudflared(log?: (m: string) => void): Promise<string> {
  const onPath = await findCloudflaredOnPath();
  if (onPath) return onPath;
  const dest = cloudflaredPath();
  if (existsSync(dest) && statSync(dest).size > 20_000_000) return dest;
  mkdirSync(binDir(), { recursive: true });
  const asset =
    process.platform === 'win32' ? 'cloudflared-windows-amd64.exe'
    : process.platform === 'darwin' && process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz'
    : process.platform === 'darwin' ? 'cloudflared-darwin-amd64.tgz'
    : process.arch === 'arm64' ? 'cloudflared-linux-arm64'
    : 'cloudflared-linux-amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  log?.(`[tunnel] downloading cloudflared (${asset}) …`);
  if (existsSync(dest)) unlinkSync(dest);
  await download(url, dest, log);
  log?.(`[tunnel] cloudflared cached at ${dest}`);
  return dest;
}

/** Wait for a regex to appear in the child's combined output. */
function waitForUrl(child: ChildProcess, extract: (s: string) => string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`tunnel did not come up within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      if (done) return;
      buf += d.toString();
      const url = extract(buf);
      if (url) {
        done = true;
        clearTimeout(timer);
        resolve(url);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`tunnel process exited (code ${code})`));
    });
  });
}

export class TunnelManager {
  private child?: ChildProcess;
  private provider?: TunnelProvider;
  private _url?: string;
  private _error?: string;
  private _loading = false;
  private _startedAt?: number;
  /** user wants the tunnel up (persisted intent); exit-watch restarts it */
  private desired = false;
  private restarts = 0;
  private port = 0;
  private log: ((m: string) => void) | undefined;

  get state(): TunnelState {
    return {
      active: !!(this.child && this._url),
      loading: this._loading,
      url: this._url,
      provider: this.provider,
      error: this._error,
      startedAt: this._startedAt,
    };
  }

  async start(port: number, prefer: TunnelProvider = 'cloudflare', log?: (m: string) => void): Promise<TunnelState> {
    this.desired = true;
    this.port = port;
    this.log = log;
    if (this.child && this._url) return this.state;
    if (this._loading) return this.state;
    this._loading = true;
    this._error = undefined;
    try {
      const started =
        prefer === 'cloudflare'
          ? await this.startCloudflare(port, log).catch((e) => {
              log?.(`[tunnel] cloudflare unavailable, falling back to pinggy: ${String(e.message ?? e)}`);
              return this.startPinggy(port, log);
            })
          : await this.startPinggy(port, log).catch((e) => {
              log?.(`[tunnel] pinggy unavailable, falling back to cloudflare: ${String(e.message ?? e)}`);
              return this.startCloudflare(port, log);
            });
      this._url = started.url;
      this.provider = started.provider;
      this._startedAt = Date.now();
      log?.(`[tunnel] online via ${started.provider}: ${started.url}`);
      this.watchChild();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      // settle BEFORE reading state: a `return this.state` inside try would
      // evaluate while _loading is still true (finally runs after)
      this._loading = false;
    }
    return this.state;
  }

  private async startCloudflare(port: number, log?: (m: string) => void): Promise<{ url: string; provider: TunnelProvider; child: ChildProcess }> {
    const bin = await ensureCloudflared(log);
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const url = await waitForUrl(child, extractTryCloudflareUrl, START_TIMEOUT_MS);
    this.child = child;
    return { url, provider: 'cloudflare', child };
  }

  private async startPinggy(port: number, log?: (m: string) => void): Promise<{ url: string; provider: TunnelProvider; child: ChildProcess }> {
    const probe = await run('ssh', ['-V']); // ssh prints version to stderr; err code 0 on windows openssh
    const sshOk = probe.ok || (await run('where', ['ssh'])).ok;
    if (!sshOk) throw new Error('ssh client not found for pinggy fallback');
    log?.('[tunnel] starting pinggy (ssh) …');
    const child = spawn(
      'ssh',
      ['-p', '443', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-t', '-R', `0:localhost:${port}`, 'free.pinggy.io'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const url = await waitForUrl(child, extractPinggyUrl, START_TIMEOUT_MS);
    this.child = child;
    return { url, provider: 'pinggy', child };
  }

  /** The other provider as a manual "switch line" (换一条线路). */
  async switchLine(port: number, log?: (m: string) => void): Promise<TunnelState> {
    const next: TunnelProvider = this.provider === 'cloudflare' ? 'pinggy' : 'cloudflare';
    await this.stop(false);
    return this.start(port, next, log);
  }

  private watchChild() {
    const child = this.child;
    if (!child) return;
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this._url = undefined;
      this._startedAt = undefined;
      // cloudflared died (parent restart orphaned it, network blip, quick-
      // tunnel reclaim): every printed QR is now a dead link (Cloudflare
      // 1033). Bring the tunnel back with capped backoff so a fresh scan
      // works instead of teaching users about error pages.
      if (this.desired && this.restarts < 5 && this.port) {
        this.restarts += 1;
        const delay = Math.min(30_000, 3_000 * this.restarts);
        this.log?.(`[tunnel] exited — restarting in ${delay / 1000}s (${this.restarts}/5)`);
        setTimeout(() => {
          if (!this.desired) return;
          void this.start(this.port, 'cloudflare', this.log).then((s) => {
            if (s.url) this.restarts = 0;
          });
        }, delay).unref?.();
      }
    });
  }

  async stop(clearDesire = true): Promise<void> {
    if (clearDesire) this.desired = false;
    const child = this.child;
    this.child = undefined;
    this._url = undefined;
    this._startedAt = undefined;
    if (!child || child.exitCode !== null || child.signalCode) return;
    if (process.platform === 'win32' && child.pid) {
      await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], 10_000).catch(() => undefined);
    } else {
      child.kill('SIGTERM');
    }
  }
}

/** One shared manager per server process. */
export const tunnel = new TunnelManager();
