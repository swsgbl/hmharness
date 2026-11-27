/**
 * Web requests through an HTTP proxy (2026-11-27).
 *
 * A stand-in proxy on loopback speaks the proxy protocol: plain http arrives
 * in absolute form and is answered by the proxy itself, https arrives as a
 * CONNECT tunnel into a local TLS server. Every assertion is about what went
 * over the wire - which requests the proxy saw, which went straight past it.
 *
 * The TLS server needs a certificate: generated with openssl at test time (it
 * ships with Git for Windows and every CI image); without openssl the https
 * cases are skipped and say so.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as proxyFetch from '../proxy-fetch.ts';
import { webFetchTool, createWebSearchTool, parseDuckDuckGo } from '../tools.ts';

// the stand-in TLS server presents a self-signed certificate; this test process only
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** What the stand-in proxy was asked for, in order. */
const seen: string[] = [];
let proxyUp = true;
let proxy: Server;
let plain: Server;
let tls: TlsServer | null = null;
let proxyPort = 0;
let plainPort = 0;
let tlsPort = 0;

/* ---------------- a certificate for the local TLS server ---------------- */

// A minimal config of the test's own. "Which openssl" follows the PATH: measured
// on 2026-11-27, started outside the developer shell the first one is
// C:\Windows\System32\openssl.exe - it answers `version`, and then cannot produce
// a certificate. So every candidate is tried with the real command, and the first
// one that succeeds is used.
const CERT_CONFIG = [
  '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
  '[dn]', 'CN = localhost',
  '[v3]', 'subjectAltName = DNS:localhost,IP:127.0.0.1', 'basicConstraints = CA:TRUE',
].join('\n');

function opensslCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    try {
      // Git for Windows ships one next to git: <git>\mingw64\libexec\git-core -> <git>\usr\bin
      const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      candidates.push(join(execPath, '..', '..', 'usr', 'bin', 'openssl.exe'));
    } catch { /* no git on PATH */ }
  }
  candidates.push('openssl');
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe');
  return candidates;
}

let certificateError = '';
/** The first openssl that actually produces a certificate here; `certificateError` says why not, when none does. */
function makeCertificate(dir: string): { key: string; cert: string } | null {
  writeFileSync(join(dir, 'openssl.cnf'), CERT_CONFIG, 'utf8');
  const tried: string[] = [];
  for (const bin of opensslCandidates()) {
    try {
      execFileSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-config', 'openssl.cnf'], { cwd: dir, timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
    } catch (err) {
      const why = (err as { stderr?: Buffer })?.stderr?.toString() || (err as Error)?.message || String(err);
      tried.push(`${bin}: ${why.trim().split(/\r?\n/)[0]}`);
    }
  }
  certificateError = tried.join(' | ');
  return null;
}
// decided once, before the tests are defined: a skip flag is read at definition time
const certDir = mkdtempSync(join(tmpdir(), 'hmh-proxy-cert-'));
const certificate = makeCertificate(certDir);

const listen = (s: Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

before(async () => {
  // plain http: the proxy answers it itself (absolute form on the request line)
  proxy = createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via-proxy ' + req.url);
  });
  // https: a CONNECT tunnel, whatever the target answers inside it
  proxy.on('connect', (req, clientSocket, head) => {
    seen.push('CONNECT ' + req.url);
    if (!proxyUp) { clientSocket.destroy(); return; }
    const [host, port] = String(req.url).split(':');
    const upstream = connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  // a plain local server: loopback traffic must reach it directly, never through the proxy
  plain = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain-direct'); });
  if (certificate) {
    tls = createTlsServer(certificate, (req, res) => {
      if (req.url === '/hop') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('tls-direct ' + req.url);
    });
  }
  [proxyPort, plainPort, tlsPort] = await Promise.all([listen(proxy), listen(plain), tls ? listen(tls) : Promise.resolve(0)]);
});

after(async () => {
  await Promise.all([close(proxy), close(plain), tls ? close(tls) : Promise.resolve()]);
  rmSync(certDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const PROXY = () => new URL('http://127.0.0.1:' + proxyPort);
const TLS = (path: string) => 'https://localhost:' + tlsPort + path;
const skip = certificate ? false : 'no openssl could produce a certificate for the local TLS server: ' + certificateError;

/* ---------------- the request, through the wire ---------------- */

test('plain http goes to the proxy in absolute form and comes back as a Response', async () => {
  seen.length = 0;
  // the target carries a non-loopback name: loopback targets are never proxied
  const res = await proxyFetch.fetchViaProxy('http://example.com/a?b=1', { headers: { accept: 'text/plain' } }, PROXY());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(await res.text(), 'via-proxy http://example.com/a?b=1');
  assert.deepEqual(seen, ['GET http://example.com/a?b=1']);
});

test('https goes through a CONNECT tunnel with TLS inside it', { skip }, async () => {
  seen.length = 0;
  const res = await proxyFetch.fetchViaProxy(TLS('/doc'), {}, PROXY());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'tls-direct /doc');
  assert.deepEqual(seen, ['CONNECT localhost:' + tlsPort], 'the proxy saw the tunnel, and nothing of the request inside it');
});

test('redirects are followed through the proxy; a loop stops and returns the last redirect', { skip }, async () => {
  seen.length = 0;
  let res = await proxyFetch.fetchViaProxy(TLS('/hop'), {}, PROXY());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'tls-direct /landed');
  res = await proxyFetch.fetchViaProxy(TLS('/loop'), {}, PROXY());
  assert.equal(res.status, 302);
});

test('a proxy that is down fails the request; it is not quietly sent direct', { skip }, async () => {
  proxyUp = false;
  try {
    await assert.rejects(() => proxyFetch.fetchViaProxy(TLS('/x'), {}, PROXY()));
  } finally { proxyUp = true; }
});

test('an already-aborted request stops before it is sent', { skip }, async () => {
  seen.length = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => proxyFetch.fetchViaProxy(TLS('/x'), { signal: ac.signal }, PROXY()), /abort/i);
  assert.deepEqual(seen, [], 'nothing reached the proxy');
});

/* ---------------- which requests go through a proxy ---------------- */

const target = 'https://github.com/a/b';
const sys: proxyFetch.SystemProxy = { server: '127.0.0.1:10808', bypass: 'localhost;127.*;10.*;<local>' };

test('the standard variables name the proxy; https and http may differ', () => {
  const both = { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://q:2' };
  assert.equal(proxyFetch.proxyFor(target, both, null)?.host, 'p:1');
  assert.equal(proxyFetch.proxyFor('http://github.com/', both, null)?.host, 'q:2');
  assert.equal(proxyFetch.proxyFor(target, { https_proxy: 'p:1' }, null)?.href, 'http://p:1/', 'lower case, no scheme');
  assert.equal(proxyFetch.proxyFor(target, { ALL_PROXY: 'http://all:3' }, null)?.host, 'all:3', 'ALL_PROXY covers both');
  assert.equal(proxyFetch.proxyFor(target, {}, null), null, 'nothing configured: direct');
});

test('NO_PROXY names the exceptions, in the usual notations', () => {
  const e = { HTTPS_PROXY: 'http://p:1' };
  const cases: Array<[string, string, boolean]> = [
    ['github.com', 'github.com', true],
    ['api.github.com', '.github.com', true],
    ['api.github.com', '*.github.com', true],
    ['github.com', 'gist.github.com', false],
    ['10.1.2.3', '10.*', true],
    ['intranet', '<local>', true],
    ['a.b.c', 'x.y,*', true],
    ['example.com', '', false],
  ];
  for (const [host, list, direct] of cases) {
    const via = proxyFetch.proxyFor('https://' + host + '/', { ...e, NO_PROXY: list }, null);
    assert.equal(via === null, direct, `${host} with "${list}"`);
  }
});

test('loopback is never proxied, whatever the lists say', () => {
  const e = { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1' };
  for (const url of ['http://127.0.0.1:11434/api/tags', 'http://localhost:20130/v1/chat', 'http://[::1]:8080/', 'https://localhost/']) {
    assert.equal(proxyFetch.proxyFor(url, e, { server: 'p:1' }), null, url + ': a local model server or gateway stays direct');
  }
});

test('the operating system\'s setting applies while it is on, and only where the environment is silent', () => {
  assert.equal(proxyFetch.proxyFor(target, {}, sys)?.host, '127.0.0.1:10808');
  assert.equal(proxyFetch.proxyFor(target, { HTTPS_PROXY: 'http://p:1' }, sys)?.host, 'p:1', 'the environment wins');
  assert.equal(proxyFetch.proxyFor(target, {}, null), null, 'no system proxy: direct');
  assert.equal(proxyFetch.proxyFor('http://10.0.0.9/', {}, sys), null, 'the system exceptions list is honoured');
  assert.equal(proxyFetch.proxyFor(target, {}, { server: 'http=a:1;https=b:2;socks=c:3' })?.host, 'b:2', 'a scheme map gives the entry for this scheme');
  assert.equal(proxyFetch.proxyFor('http://github.com/', {}, { server: 'http=a:1;https=b:2' })?.host, 'a:1');
});

test('proxies this module cannot speak are left alone: the request goes direct', () => {
  for (const bad of ['socks5h://127.0.0.1:10808', 'socks5h://p:1', 'socks4a://p:2', '', 'http://', 'pac+https://x/y']) {
    assert.equal(proxyFetch.normalizeProxy(bad), null, bad);
  }
  assert.equal(proxyFetch.normalizeProxy('127.0.0.1:10808')?.href, 'http://127.0.0.1:10808/');
  assert.equal(proxyFetch.proxyFor(target, { HTTPS_PROXY: 'socks5h://127.0.0.1:10808' }, sys), null);
});

test('the system setting: only while switched on, read once in a while, switchable off, never an error', () => {
  // the values alone
  assert.deepEqual(
    proxyFetch.systemProxyFrom({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:10808', ProxyOverride: 'localhost;127.*' }),
    { server: '127.0.0.1:10808', bypass: 'localhost;127.*' });
  // a proxy app in tunnel mode leaves its server behind with the switch off: that must read as "off"
  assert.equal(proxyFetch.systemProxyFrom({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:10808' }), null);
  assert.equal(proxyFetch.systemProxyFrom({ ProxyEnable: '0x1' }), null, 'on, but no server named');
  assert.equal(proxyFetch.systemProxyFrom({}), null);

  // the lookup, against a counting stand-in for the registry
  const on: proxyFetch.InternetSettings = { ProxyEnable: '0x1', ProxyServer: '127.0.0.1:10808', ProxyOverride: 'localhost;127.*;<local>' };
  const off: proxyFetch.InternetSettings = { ProxyEnable: '0x0', ProxyServer: '127.0.0.1:10808' };
  let values = on;
  let reads = 0;
  const read = (): proxyFetch.InternetSettings => { reads++; return values; };
  const T = Date.parse('2026-11-27T00:00:00Z');
  proxyFetch.resetSystemProxyCache();
  assert.deepEqual(proxyFetch.readSystemProxy({}, T, read, 'win32'), { server: '127.0.0.1:10808', bypass: 'localhost;127.*;<local>' });
  proxyFetch.readSystemProxy({}, T + 1000, read, 'win32');
  assert.equal(reads, 1, 'a second look inside the TTL reads nothing');
  values = off;
  assert.equal(proxyFetch.readSystemProxy({}, T + 29_999, read, 'win32')?.server, '127.0.0.1:10808', 'inside the TTL the old answer stands');
  assert.equal(proxyFetch.readSystemProxy({}, T + 30_000, read, 'win32'), null, 'the TTL past, the switch-off is seen');
  assert.equal(reads, 2);
  assert.equal(proxyFetch.readSystemProxy({ HMH_NO_SYSTEM_PROXY: '1' }, T + 60_000, read, 'win32'), null, 'switched off by the user');
  assert.equal(reads, 2, 'and nothing was read for it');
  assert.equal(proxyFetch.readSystemProxy({}, T + 90_000, read, 'linux'), null, 'another system: no setting this module reads');
  assert.equal(reads, 2);
  proxyFetch.resetSystemProxyCache();
  assert.equal(proxyFetch.readSystemProxy({}, T + 120_000, () => { throw new Error('reg: access denied'); }, 'win32'), null, 'an unreadable registry is "no setting", not an error');
  // and the real lookup on this machine: a well-formed setting or null, never an error
  const real = proxyFetch.readSystemProxy({}, 0);
  assert.ok(real === null || (typeof real.server === 'string' && real.server.length > 0), 'a well-formed setting or nothing');
});

test('web_search goes through a configured proxy too', async () => {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'HMH_NO_SYSTEM_PROXY'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxyPort;
  process.env.NO_PROXY = '';
  process.env.HMH_NO_SYSTEM_PROXY = '1';
  // a home of the test's own: the search tool remembers an unreachable engine on disk
  const home = await mkdtemp(join(tmpdir(), 'hmh-proxy-search-'));
  try {
    seen.length = 0;
    const tool = createWebSearchTool([{ name: 'StandIn', endpoint: 'http://engine.example/?q=', parse: parseDuckDuckGo }], { timeoutMs: 4_000 });
    const out = await tool.execute({ query: 'openharmony docs' }, { cwd: home, home } as never);
    // the proxy's plain answer holds no results: "no results", which means the engine was REACHED
    assert.notEqual(out.isError, true, out.output);
    assert.match(out.output, /no results/);
    assert.deepEqual(seen, ['GET http://engine.example/?q=openharmony%20docs']);
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]!; }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/* ---------------- the tool itself ---------------- */

test('web_fetch: a configured proxy carries the request; loopback stays direct; failures keep their cause', async () => {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'HMH_NO_SYSTEM_PROXY'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.HTTPS_PROXY = 'http://127.0.0.1:' + proxyPort;
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
  process.env.NO_PROXY = '';
  process.env.HMH_NO_SYSTEM_PROXY = '1';
  try {
    seen.length = 0;
    const out = await webFetchTool.execute({ url: 'http://example.com/page' }, { cwd: '.', home: '.' } as never);
    assert.notEqual(out.isError, true);
    assert.match(out.output, /^via-proxy http:\/\/example\.com\/page/);
    assert.deepEqual(seen, ['GET http://example.com/page']);
    seen.length = 0;
    const local = await webFetchTool.execute({ url: 'http://127.0.0.1:' + plainPort + '/x' }, { cwd: '.', home: '.' } as never);
    assert.match(local.output, /^plain-direct/);
    assert.deepEqual(seen, [], 'the local address went past the proxy');
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]!; }
  }
});
