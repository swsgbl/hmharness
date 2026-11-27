/**
 * Outbound web requests through an HTTP proxy (2026-11-27).
 *
 * Of 19 recorded web_fetch failures, 11 said only "fetch failed": sites this
 * network reaches only through a proxy. Node's fetch honours neither the
 * standard proxy variables nor the operating system's proxy setting, and
 * Node's own switch for them (NODE_USE_ENV_PROXY) is no way out for a CLI:
 * measured on 22.23.3 and 24.19, it works only when the variables are present
 * BEFORE the process starts, and it sends loopback through the proxy too
 * (.audit/web-modernization/env-proxy-probe.mjs) - where a local model server
 * or gateway lives.
 *
 * So the web tools send through a proxy themselves when one is configured:
 *   - the standard variables first: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *     (either case), NO_PROXY for exceptions;
 *   - then the operating system's own setting, but only while it is switched
 *     on (Windows: Internet Options, read from the registry);
 *   - loopback never goes through a proxy, whatever the lists say.
 * Only http(s) proxies: SOCKS needs a client this repo does not carry, and a
 * PAC URL cannot be evaluated without a JavaScript sandbox - both are left
 * alone and said so.
 *
 * Everything here is built on node:http / node:tls: https goes through a
 * CONNECT tunnel with TLS inside it, plain http in the absolute form proxies
 * expect. Redirects are followed as fetch would. Certificates are checked
 * against the same store Node's fetch uses.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { Socket } from 'node:net';

/** The operating system's proxy setting, as far as this module can read it. */
export interface SystemProxy {
  /** "host:port" or a scheme map such as "http=h:p;https=h:p". */
  server: string;
  /** exceptions in the system's own syntax ("localhost;127.*;<local>"). */
  bypass?: string;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;
const first = (...values: Array<string | undefined>): string | undefined => values.find((v) => v && v.trim());
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** "host:port", "http://host:port" -> a URL; anything else (socks, pac+, garbage) -> null. */
export function normalizeProxy(value: string | undefined): URL | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'http://' + v;
  try {
    const u = new URL(withScheme);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null;
  } catch { return null; }
}

/** Windows' "http=h:p;https=h:p;socks=h:p" -> the entry for this scheme. */
function schemeEntry(server: string, protocol: string): string | undefined {
  if (!server.includes('=')) return str(server);
  for (const part of server.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() === protocol.slice(0, -1)) return str(part.slice(eq + 1));
  }
  return undefined;
}

/**
 * Does an exceptions list cover this host? Lists are comma- or
 * semicolon-separated; an entry is "*", "<local>" (a name without a dot), a
 * domain ("example.com", ".example.com", "*.example.com") or a pattern with
 * "*" ("10.*", "192.168.*"). CIDR entries are not understood and do not match.
 */
export function bypasses(host: string, list: string | undefined): boolean {
  if (!list) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of list.split(/[,;]/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry === '<local>') { if (!h.includes('.')) return true; continue; }
    // "10.*" is every address under 10., "*.github.com" every name under the domain
    if (entry.includes('*')) {
      if (new RegExp('^' + entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(h)) return true;
      continue;
    }
    if (entry.startsWith('.')) { if (h.endsWith(entry)) return true; continue; }
    if (h === entry || h.endsWith('.' + entry)) return true;
  }
  return false;
}

/** The proxy one request should use, or null for a direct connection. */
export function proxyFor(url: string, env: Record<string, string | undefined>, system: SystemProxy | null): URL | null {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (LOOPBACK.test(target.hostname)) return null;
  const envValue = target.protocol === 'https:'
    ? first(env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy)
    : first(env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy);
  if (envValue) return bypasses(target.hostname, first(env.NO_PROXY, env.no_proxy)) ? null : normalizeProxy(envValue);
  if (!system?.server) return null;
  const entry = schemeEntry(system.server, target.protocol);
  if (!entry || bypasses(target.hostname, system.bypass)) return null;
  return normalizeProxy(entry);
}

/** Windows' Internet Options as this module reads them: value name -> text
 *  ("0x1" for a number, the string for text), missing when not set. */
export type InternetSettings = Record<string, string | undefined>;

const WIN_INTERNET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** One registry query for the whole key (three values, one process). Throws
 *  when the registry cannot be read; the caller treats that as "no setting". */
function readInternetSettings(): InternetSettings {
  const out = execFileSync('reg', ['query', WIN_INTERNET], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const values: InternetSettings = {};
  // "    ProxyEnable    REG_DWORD    0x1" / "    ProxyServer    REG_SZ    host:port"
  for (const m of out.matchAll(/^\s*(\S+)\s+REG_\w+\s+(.*)$/gm)) values[m[1]!] = str(m[2]);
  return values;
}

/** The setting as far as the values go: only while ProxyEnable says on. A
 *  server listed under a switched-off proxy is what a proxy app leaves behind
 *  in system-proxy mode; honouring it would send every request to a port
 *  nothing listens on. */
export function systemProxyFrom(values: InternetSettings): SystemProxy | null {
  if (!/^0x1$/i.test(values.ProxyEnable ?? '')) return null;
  const server = values.ProxyServer;
  return server ? { server, bypass: values.ProxyOverride } : null;
}

let systemCache: { at: number; value: SystemProxy | null } | null = null;
const SYSTEM_TTL_MS = 30_000;
/** Tests start from a clean cache; production never needs to. */
export function resetSystemProxyCache(): void { systemCache = null; }

/**
 * The operating system's proxy setting while it is switched on; null when it
 * is off, unreadable or not a setting this module knows how to read (only
 * Windows has one it reads today). Cached briefly: a user toggles their proxy
 * app while a daemon runs. HMH_NO_SYSTEM_PROXY=1 turns the lookup off.
 * `read` and `platform` are injectable so the rules can be tested anywhere.
 */
export function readSystemProxy(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
  read: () => InternetSettings = readInternetSettings,
  platform: string = process.platform,
): SystemProxy | null {
  if (platform !== 'win32' || env.HMH_NO_SYSTEM_PROXY === '1') return null;
  if (systemCache && now - systemCache.at < SYSTEM_TTL_MS) return systemCache.value;
  let value: SystemProxy | null = null;
  try { value = systemProxyFrom(read()); } catch { /* the registry is not readable here: no setting */ }
  systemCache = { at: now, value };
  return value;
}

/** The proxy for one request from the live environment and system setting. */
export function outboundProxy(url: string): URL | null {
  return proxyFor(url, process.env, readSystemProxy());
}

/** What the request tools need; keeps the two call sites identical. */
export async function outboundFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } & Record<string, unknown>): Promise<Response> {
  const proxy = outboundProxy(url);
  return proxy ? fetchViaProxy(url, init, proxy) : fetch(url, init as never);
}

function portOf(u: URL, dflt: number): number { return u.port ? Number(u.port) : dflt; }

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) return {};
  const pair = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password);
  return { 'proxy-authorization': 'Basic ' + Buffer.from(pair).toString('base64') };
}

function signalError(signal: AbortSignal | undefined): Error | null {
  return signal?.aborted ? (signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted')) : null;
}

/** One request through the proxy, redirects not followed. */
function requestThroughProxy(target: URL, proxy: URL, init: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<IncomingMessage> {
  const aborted = signalError(init.signal);
  if (aborted) return Promise.reject(aborted);
  const headers: Record<string, string> = { 'accept-encoding': 'identity', ...(init.headers ?? {}) };
  const proxyPort = portOf(proxy, proxy.protocol === 'https:' ? 443 : 80);
  if (target.protocol === 'http:') {
    // absolute form: the proxy sees the whole URL
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: proxy.hostname, port: proxyPort, method: 'GET', path: target.href, agent: false,
        headers: { ...headers, ...proxyAuth(proxy), host: target.host },
        ...(init.signal ? { signal: init.signal } : {}),
      }, resolve);
      req.on('error', reject);
      req.end();
    });
  }
  const port = portOf(target, 443);
  return new Promise<Socket>((resolve, reject) => {
    // the tunnel: CONNECT, then the proxy's socket is ours
    const connectReq = httpRequest({
      host: proxy.hostname, port: proxyPort, method: 'CONNECT', path: target.hostname + ':' + port, agent: false,
      headers: { host: target.hostname + ':' + port, ...proxyAuth(proxy) },
      ...(init.signal ? { signal: init.signal } : {}),
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new Error('the proxy refused the tunnel: HTTP ' + res.statusCode));
    });
    connectReq.on('error', reject);
    connectReq.end();
  }).then((socket) => new Promise<IncomingMessage>((resolve, reject) => {
    if (signalError(init.signal)) { socket.destroy(); return reject(signalError(init.signal)); }
    const agent = new HttpsAgent({ keepAlive: false });
    const tlsSocket = tlsConnect({ socket, servername: target.hostname });
    // a TLS handshake that fails has no request yet to report it
    const onHandshakeError = (err: Error) => reject(err);
    tlsSocket.once('error', onHandshakeError);
    agent.createConnection = () => tlsSocket;
    const req = httpsRequest({
      host: target.hostname, port, method: 'GET', path: target.pathname + target.search, headers, agent,
      ...(init.signal ? { signal: init.signal } : {}),
    }, (res) => { tlsSocket.off('error', onHandshakeError); resolve(res); });
    req.on('error', (err) => { tlsSocket.off('error', onHandshakeError); reject(err); });
    req.end();
  }));
}

/** A node:http response as the Web Response the tools already consume. */
function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  let stream: Readable = res;
  // identity was asked for; a server that compresses anyway is still read
  if (encoding === 'gzip') stream = res.pipe(createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(createInflate());
  else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
  headers.delete('content-encoding');
  const empty = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
  return new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream), { status, headers });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** fetch(url, init) through an HTTP proxy, redirects followed as fetch would. */
export async function fetchViaProxy(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; maxRedirects?: number }, proxy: URL): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await requestThroughProxy(target, proxy, init);
    const location = res.headers.location;
    if (REDIRECTS.has(res.statusCode ?? 0) && location && hop < (init.maxRedirects ?? 5)) {
      res.destroy();
      target = new URL(location, target);
      continue;
    }
    return toResponse(res);
  }
}
