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
  /** give-up is terminal for THIS process: only a manual start() (retry
   *  button / switch-line) or the next process start clears it. */
  failed?: boolean;
}

const CLOUDFLARED_VERSION = '2026.8.2'; // pinned like DSH Desktop
const START_TIMEOUT_MS = 45_000;

/* ---- retry policy (2026-10-29 device incident root-cause) ----
 * The old exit-watcher restarted with a ~3s fixed delay and reset its
 * counter on ANY successful spawn, so a restricted-network board looped all
 * night: cloudflared download fails -> pinggy comes up -> dies in seconds ->
 * "restarting in 3s (1/5)" forever, each round spawning processes and
 * re-downloading until sibling task children died under the pressure. Now:
 *   - cold-start failures back off exponentially (3s,6s,12s,24s,48s … capped)
 *   - reconnects after a tunnel was UP are fast first (1s/3s/5s) — a blip
 *     heals quickly — then join the same exponential ladder
 *   - 5 CONSECUTIVE failures give up for good: one notice, no more spawns */
export const STARTUP_RETRY_BASE_MS = 3_000;
export const RETRY_CAP_MS = 5 * 60_000;
export const RECONNECT_FAST_DELAYS_MS = [1_000, 3_000, 5_000] as const;
export const MAX_CONSECUTIVE_FAILURES = 5;
/** A session that stayed up this long proves the network works — only then
 *  does a later exit reset the failure streak. Shorter-lived sessions count
 *  as failures: that is exactly the "pinggy comes up then dies" loop. */
export const STABLE_UPTIME_MS = 60_000;

/** Cold-start retry delay after the nth consecutive failure (1-based):
 *  3s, 6s, 12s, 24s, 48s … capped at RETRY_CAP_MS. */
export function startupRetryDelayMs(n: number): number {
  const i = Math.max(1, Math.floor(n));
  return Math.min(RETRY_CAP_MS, STARTUP_RETRY_BASE_MS * 2 ** (i - 1));
}

/** Reconnect delay for the nth reconnect after the tunnel WAS up: the first
 *  three are fast (1s/3s/5s), then the same exponential ladder to the cap. */
export function reconnectDelayMs(n: number): number {
  const i = Math.max(1, Math.floor(n));
  const fast = RECONNECT_FAST_DELAYS_MS;
  if (i <= fast.length) return fast[i - 1];
  return Math.min(RETRY_CAP_MS, fast[fast.length - 1] * 2 ** (i - fast.length));
}

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
  /** user wants the tunnel up (persisted intent); retry chains follow it */
  private desired = false;
  /** cold-start failures + short-lived sessions since the last stable one */
  private consecutiveFailures = 0;
  /** reconnect attempts since the tunnel was last up (drives the fast-first ladder) */
  private reconnects = 0;
  /** terminal: budget spent, no more automatic spawns this process */
  private gaveUp = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private port = 0;
  private log: ((m: string) => void) | undefined;
  /** one-shot give-up notice (server wires this to the SSE line channel) */
  private onGiveUp?: (msg: string) => void;

  get state(): TunnelState {
    return {
      active: !!(this.child && this._url),
      loading: this._loading,
      url: this._url,
      provider: this.provider,
      error: this._error,
      startedAt: this._startedAt,
      failed: this.gaveUp,
    };
  }

  async start(port: number, prefer: TunnelProvider = 'cloudflare', log?: (m: string) => void, onGiveUp?: (msg: string) => void): Promise<TunnelState> {
    this.desired = true;
    this.port = port;
    this.log = log;
    if (onGiveUp) this.onGiveUp = onGiveUp;
    // A manual/boot start is an explicit ask (retry button, switch-line, or
    // process start): it clears any previous give-up and grants a fresh
    // backoff budget. The AUTOMATIC retry chain calls startInner() directly
    // and never resets these — that is what bounds the storm.
    this.gaveUp = false;
    this.consecutiveFailures = 0;
    this.reconnects = 0;
    return this.startInner(port, prefer, log);
  }

  private async startInner(port: number, prefer: TunnelProvider, log?: (m: string) => void): Promise<TunnelState> {
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
      this.child = started.child;
      log?.(`[tunnel] online via ${started.provider}: ${started.url}`);
      this.watchChild();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this.scheduleStartupRetry();
    } finally {
      // settle BEFORE reading state: a `return this.state` inside try would
      // evaluate while _loading is still true (finally runs after)
      this._loading = false;
    }
    return this.state;
  }

  protected async startCloudflare(port: number, log?: (m: string) => void): Promise<{ url: string; provider: TunnelProvider; child: ChildProcess }> {
    const bin = await ensureCloudflared(log);
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const url = await waitForUrl(child, extractTryCloudflareUrl, START_TIMEOUT_MS);
    return { url, provider: 'cloudflare', child };
  }

  protected async startPinggy(port: number, log?: (m: string) => void): Promise<{ url: string; provider: TunnelProvider; child: ChildProcess }> {
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
    return { url, provider: 'pinggy', child };
  }

  /** Cold-start path: cloudflared AND pinggy both failed to produce a URL.
   *  Back off exponentially; after MAX_CONSECUTIVE_FAILURES straight
   *  failures give up for good (one notice, no more spawns). */
  private scheduleStartupRetry(): void {
    if (!this.desired || this.gaveUp) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.giveUp();
      return;
    }
    const delay = startupRetryDelayMs(this.consecutiveFailures);
    this.log?.(`[tunnel] start failed — retrying in ${delay / 1000}s (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    this.armRetry(delay, () => { void this.startInner(this.port, 'cloudflare', this.log); });
  }

  /** One pending retry at a time; a fresh schedule replaces a stale one. */
  private armRetry(delayMs: number, fire: () => void): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.desired || this.gaveUp) return;
      fire();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  /** Terminal: mark failed and notify exactly once (the flag short-circuits
   *  every retry path, so this can only fire once per give-up). */
  private giveUp(): void {
    this.gaveUp = true;
    this._error = `tunnel gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`;
    const msg = `[tunnel] 已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，停止自动重试（tunnel:failed）；网页 📱 弹窗可手动重试或换线路，下次启动会再试`;
    this.log?.(msg);
    this.onGiveUp?.(msg);
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
      const startedAt = this._startedAt;
      this._startedAt = undefined;
      if (!this.desired) return;
      // cloudflared died (parent restart orphaned it, network blip, quick-
      // tunnel reclaim): every printed QR is now a dead link (Cloudflare
      // 1033). Bring the tunnel back — fast for blips, backed off when it
      // keeps dying, given up when the network clearly cannot hold one
      // (2026-10-29: the old reset-on-success counter looped here all night).
      const stable = startedAt !== undefined && Date.now() - startedAt >= STABLE_UPTIME_MS;
      if (stable) {
        this.consecutiveFailures = 0;
        this.reconnects = 0;
      } else {
        this.consecutiveFailures += 1;
      }
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.giveUp();
        return;
      }
      this.reconnects += 1;
      const delay = reconnectDelayMs(this.reconnects);
      this.log?.(`[tunnel] exited — reconnecting in ${delay / 1000}s (reconnect ${this.reconnects}, failures ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      this.armRetry(delay, () => { void this.startInner(this.port, 'cloudflare', this.log); });
    });
  }

  async stop(clearDesire = true): Promise<void> {
    if (clearDesire) this.desired = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
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
