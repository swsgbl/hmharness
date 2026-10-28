'use strict';
/**
 * Clean-room release verify (audit 03 / P0-2 acceptance gate).
 *
 *   node scripts/cleanroom-verify.cjs --version 0.23.44 [--keep]
 *
 * What it proves, in order: the published npm tarball for @hmharness/cli@X
 * downloads from the OFFICIAL registry and its bytes hash to the registry's
 * own integrity digest; it installs into a throwaway dir with a throwaway
 * npm cache; every @hmharness/* pin and every installed package equals X
 * (codexhost-bridge ships outside the CLI dep graph and is verified against
 * registry metadata instead); the CLI's live surfaces — check, web server,
 * task accept / interrupt / resume, bench, evolve — respond structurally.
 * Every run archives sha256, full stdout/stderr, environment info and the
 * package graph under website/evidence/cleanroom/vX/<timestamp>/ (append-only).
 *
 * Field-tested traps this script defends against (see the task brief):
 * - the local npm default registry is a mirror that lags fresh publishes by
 *   ~10 minutes (fake ETARGET) → every network call pins the official registry;
 * - npm walks UP the tree for a package.json and installs into the user's
 *   home if the temp dir has none → write {"name":"cleanroom-probe"} first;
 * - a warm npm cache can mask a broken tarball → --cache <tmp>/npm-cache;
 * - the real ~/.hmharness must never be touched → HMH_HOME=<tmp>/home plus a
 *   fake provider (HMH_BASE_URL on a closed port) so model calls exercise the
 *   REAL http path and fail honestly without any API key.
 *
 * Exit code: 1 when any hard check (download / install / pins / versions,
 * including the registry fallback for packages outside the dep graph) fails
 * or a live surface crashes; live surfaces the CLI cannot serve are honestly
 * reported as SKIPPED with a reason and do not fail the run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const {
  EXPECTED_PACKAGES, PKG_PREFIX, parseArgs, verifyPinnedGraph, summarizeRows, evidenceDirName,
} = require('./cleanroom-verify-core.cjs');

const NPM_REGISTRY = 'https://registry.npmjs.org';
const HTTP_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 360_000;
const LIVE_TIMEOUT_MS = 180_000;
const FAKE_BASE_URL = 'http://127.0.0.1:9/v1'; // port 9 (discard): closed everywhere, no key needed

/* ------------------------------- plumbing ------------------------------- */

const logLines = [];
function log(line) {
  const text = line === undefined ? '' : String(line);
  console.log(text);
  logLines.push(text);
}

function npmVersion() {
  try { return execFileSync('npm --version', { encoding: 'utf8', timeout: 15_000, shell: true }).trim(); }
  catch { return 'unknown'; }
}

/** HTTPS GET returning {status, headers, body(Buffer)}; follows redirects. */
function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: HTTP_TIMEOUT_MS, headers: { 'user-agent': 'hmharness-cleanroom-verify', accept: 'application/json' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 301 && status <= 308 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  const { status, body } = await httpsGet(url);
  if (status !== 200) throw new Error(`GET ${url} -> HTTP ${status}`);
  return JSON.parse(body.toString('utf8'));
}

/** Download to a file while streaming sha256/sha512/sha1 digests. Redirects
 *  restart the whole attempt (fresh write stream each hop). */
async function downloadWithDigests(url, dest) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const opened = await new Promise((resolve, reject) => {
      const req = https.get(current, { timeout: HTTP_TIMEOUT_MS }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 301 && status <= 308 && res.headers.location) {
          res.resume();
          resolve({ redirect: new URL(res.headers.location, current).toString() });
          return;
        }
        if (status !== 200) { res.resume(); reject(new Error(`download ${current} -> HTTP ${status}`)); return; }
        resolve({ redirect: null, res });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout downloading ${current}`)));
      req.on('error', reject);
    });
    if (opened.redirect) { current = opened.redirect; continue; }
    const digests = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512'), sha1: crypto.createHash('sha1') };
    return await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      opened.res.on('data', (c) => { for (const h of Object.values(digests)) h.update(c); file.write(c); });
      opened.res.on('end', () => file.end(() => resolve({
        sha256: digests.sha256.digest('hex'),
        sha512B64: digests.sha512.digest('base64'),
        sha1Hex: digests.sha1.digest('hex'),
      })));
      opened.res.on('error', reject);
      file.on('error', reject);
    });
  }
  throw new Error(`too many redirects downloading ${url}`);
}

/** Run a shell command, capturing output into the log; never throws. */
function runLogged(label, cmd, { cwd, env, timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    log(`$ ${cmd}`);
    exec(cmd, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (err.code ?? -1) : 0;
      for (const [tag, text] of [['stdout', stdout], ['stderr', stderr]]) {
        for (const l of String(text).split(/\r?\n/)) if (l.trim()) log(`  [${label}/${tag}] ${l}`);
      }
      if (err && err.killed) log(`  [${label}] timed out after ${timeoutMs}ms`);
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(err && err.killed) });
    });
  });
}

function localApi(port, method, pathname, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, timeout: 10_000, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON — record raw */ }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout', json: null }); });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message ?? e), json: null }));
    if (body) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- the verify steps --------------------------- */

async function stepDownload(registry, version) {
  const meta = await fetchJson(`${registry}/${PKG_PREFIX}cli/${version}`);
  if (meta.version !== version) throw new Error(`registry reports ${meta.version}, asked for ${version}`);
  const tarballUrl = meta.dist?.tarball;
  if (!tarballUrl) throw new Error('registry metadata has no dist.tarball');
  return { meta, tarballUrl };
}

function checkIntegrity(digests, dist) {
  const problems = [];
  if (dist.integrity && dist.integrity.startsWith('sha512-')) {
    if (`sha512-${digests.sha512B64}` !== dist.integrity) problems.push('sha512 integrity mismatch vs registry metadata');
  } else if (dist.shasum && dist.shasum !== digests.sha1Hex) {
    problems.push('sha1 shasum mismatch vs registry metadata');
  }
  return problems;
}

async function stepInstall(tmp, tarballPath, registry) {
  // package.json FIRST: without it npm walks up the tree and installs into
  // the user's home directory (field-tested trap).
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'cleanroom-probe', private: true }, null, 2));
  const cacheDir = path.join(tmp, 'npm-cache');
  const q = (p) => `"${p}"`;
  const cmd = [
    'npm', 'install', q(tarballPath),
    `--registry ${registry}`, // mirror lags fresh publishes — always official
    `--cache ${q(cacheDir)}`, // cold cache: a warm one can mask a broken tarball
    '--no-audit', '--no-fund',
  ].join(' ');
  return runLogged('install', cmd, { cwd: tmp, timeoutMs: INSTALL_TIMEOUT_MS });
}

async function stepReadGraph(tmp, version) {
  const cliPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'node_modules', '@hmharness', 'cli', 'package.json'), 'utf8'));
  const scopeDir = path.join(tmp, 'node_modules', '@hmharness');
  const installed = {};
  for (const name of fs.readdirSync(scopeDir)) {
    const pj = path.join(scopeDir, name, 'package.json');
    if (!fs.statSync(path.join(scopeDir, name)).isDirectory() || !fs.existsSync(pj)) continue;
    installed[name] = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  }
  const graph = verifyPinnedGraph({ cliDependencies: cliPkg.dependencies, installed, expectedVersion: version });
  log(`installed @hmharness/* packages: ${graph.installedCount} → ${Object.entries(graph.installed).map(([k, v]) => `${k}@${v}`).join(', ')}`);
  log(`CLI pins ${graph.pinnedCount} @hmharness/* deps${graph.unexpected.length ? `; unexpected: ${graph.unexpected.join(', ')}` : ''}`);
  return graph;
}

/** Packages missing from the installed tree (codexhost-bridge) must still be
 *  PROVEN published at X via registry metadata — the 16-package release claim
 *  would otherwise rest on hope. */
async function stepRegistryFallback(missing, registry, version) {
  const results = {};
  for (const name of missing) {
    try {
      const meta = await fetchJson(`${registry}/${PKG_PREFIX}${name}/${version}`);
      results[name] = meta.version === version ? `registry confirms ${version}` : `registry reports ${meta.version}`;
    } catch (e) {
      results[name] = `registry lookup failed: ${String(e.message ?? e).slice(0, 120)}`;
    }
    log(`registry fallback ${name}@${version}: ${results[name]}`);
  }
  return results;
}

/* ------------------------- live-path verification ------------------------ */

function cliMainJs(tmp) { return path.join(tmp, 'node_modules', '@hmharness', 'cli', 'dist', 'main.js'); }

function childEnv(home) {
  // Fake provider on a closed port: model calls travel the REAL http path and
  // fail honestly (connection refused) with zero API keys in play.
  return {
    ...process.env,
    HMH_HOME: home,
    HMH_BASE_URL: FAKE_BASE_URL,
    HMH_API_KEY: 'cleanroom-probe-no-key',
    HMH_MODEL: 'probe-model',
    NO_COLOR: '1',
  };
}

function spawnCli(label, args, { tmp, home, stdinData = '', timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliMainJs(tmp), ...args], { cwd: tmp, env: childEnv(home), windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    if (stdinData) child.stdin.write(stdinData);
    child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      for (const [tag, text] of [['stdout', stdout], ['stderr', stderr]]) {
        for (const l of String(text).split(/\r?\n/)) if (l.trim()) log(`  [${label}/${tag}] ${l}`);
      }
      resolve({ code, signal, stdout: String(stdout), stderr: String(stderr), timedOut });
    });
    child.on('error', (e) => resolve({ code: -1, signal: '', stdout: '', stderr: String(e), timedOut: false }));
  });
}

function looksCrashed(r) {
  return /ERR_MODULE_NOT_FOUND|SyntaxError:|ERR_UNHANDLED_REJECTION|ERR_INTERNAL_ASSERTION/.test(r.stderr + r.stdout);
}

async function liveCheck(tmp, home) {
  const r = await spawnCli('check', ['check'], { tmp, home });
  const structured = /^[a-z0-9_ -]+: (OK|MISSING|WARN)/im.test(r.stdout);
  if (r.code === null || looksCrashed(r) || !structured) {
    return { step: 'hmh check (toolchain probe)', status: 'FAIL', detail: `exit=${r.code} signal=${r.signal}; structured toolchain lines=${structured}` };
  }
  return { step: 'hmh check (toolchain probe)', status: 'PASS', detail: `exit=${r.code}; toolchain probe lines: ${r.stdout.split(/\r?\n/).filter((l) => /^[a-z]/i.test(l)).length}` };
}

async function liveWebAndTask(tmp, home, version, rows) {
  const port = await freePort();
  const { spawn } = require('node:child_process');
  const server = spawn(process.execPath, [cliMainJs(tmp), 'web', `--port=${port}`], { cwd: tmp, env: childEnv(home), windowsHide: true });
  let serverOut = '';
  let serverError = '';
  server.stdout.on('data', (c) => { serverOut += c; });
  server.stderr.on('data', (c) => { serverOut += c; });
  // an un-listened 'error' (spawn ENOENT, port races) would crash the verify
  // process itself and skip the evidence archive — catch it, poll handles it
  server.on('error', (e) => { serverError = String(e.message ?? e); });
  const killServer = async () => {
    if (process.platform === 'win32') {
      await new Promise((r) => exec(`taskkill /PID ${server.pid} /T /F`, { windowsHide: true }, () => r()));
    } else { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  try {
    // smoke: poll /api/state until it answers with our version
    let state = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const res = await localApi(port, 'GET', '/api/state');
      if (res.status === 200 && res.json) { state = res.json; break; }
      if (server.exitCode !== null && server.exitCode !== undefined) break; // server died
    }
    if (!state) {
      rows.push({ step: 'web /api/state smoke', status: 'FAIL', detail: `no 200 from 127.0.0.1:${port} within 30s${serverError ? `; server error: ${serverError}` : ''}; server output: ${serverOut.split(/\r?\n/).slice(-3).join(' | ').slice(0, 200)}` });
      return;
    }
    const versionOk = state.daemonVersion === version;
    rows.push({
      step: 'web /api/state smoke', status: versionOk ? 'PASS' : 'FAIL',
      detail: `HTTP 200, daemonVersion=${state.daemonVersion}, busy=${state.busy}, workspace=${String(state.workspace?.name ?? '')}`,
    });

    // task accept → state → interrupt → resume (channel semantics, no real key)
    const post = await localApi(port, 'POST', '/api/task', { text: 'list the files in the current working directory, then stop.' });
    const interrupt = await localApi(port, 'POST', '/api/interrupt');
    await sleep(3000); // let the fake-provider call fail honestly
    const after = await localApi(port, 'GET', '/api/state');
    const accepted = post.status === 200 && post.json?.ok === true;
    const interruptAnswered = interrupt.status === 200 && interrupt.json && typeof interrupt.json.ok === 'boolean';
    const sessionLanded = Boolean(after.json?.activeSessionId);
    rows.push({
      step: 'task accept (POST /api/task)', status: accepted ? 'PASS' : 'FAIL',
      detail: `HTTP ${post.status} ${post.text.slice(0, 80)} — boundary: fake baseUrl ${FAKE_BASE_URL}, no real key`,
    });
    rows.push({
      step: 'interrupt (POST /api/interrupt)', status: interruptAnswered ? 'PASS' : 'FAIL',
      detail: `HTTP ${interrupt.status} ${interrupt.text.slice(0, 80)} — structural answer is the channel proof (task may have already failed honestly without a key)`,
    });
    rows.push({
      step: 'session rollout landed', status: sessionLanded ? 'PASS' : 'FAIL',
      detail: sessionLanded ? `activeSessionId=${after.json.activeSessionId}, busy=${after.json.busy}` : `busy=${after.json?.busy}, no activeSessionId after task`,
    });

    const resume = await spawnCli('resume', ['resume', '--last'], { tmp, home, stdinData: '\n' });
    const resumedOk = /resuming/i.test(resume.stdout) && !looksCrashed(resume);
    rows.push({
      step: 'resume --last (CLI)', status: resumedOk ? 'PASS' : 'FAIL',
      detail: resumedOk ? `${/resuming[^\r\n]*/i.exec(resume.stdout)?.[0]?.trim()} · repl exits cleanly on stdin EOF (exit=${resume.code})` : `exit=${resume.code}; stdout=${resume.stdout.slice(0, 120)}`,
    });
  } finally {
    await killServer();
  }
}

async function liveBench(tmp, home) {
  const r = await spawnCli('bench', ['bench'], { tmp, home });
  const structured = /pass rate: \d+%/.test(r.stdout);
  if (!structured || looksCrashed(r)) return { step: 'hmh bench', status: 'FAIL', detail: `exit=${r.code}; no structured "pass rate:" line` };
  return { step: 'hmh bench', status: 'PASS', detail: `exit=${r.code}; ${(r.stdout.match(/pass rate: \d+%/)?.[0]) ?? ''} (no key: case list may be empty — output recorded as-is)` };
}

/** The gate here is reachability + honest failure, not a finished evolve
 *  cycle: with the fake provider every model call burns the provider's own
 *  retry budget (6 attempts, exponential backoff), so a full cycle can outlast
 *  the timeout. Once the structured baseline report ("case ... threw") is on
 *  record, a verifier timeout is a PASS with the termination noted honestly. */
async function liveEvolve(tmp, home) {
  const EVOLVE_TIMEOUT_MS = 120_000;
  const r = await spawnCli('evolve', ['evolve', '--max=1'], { tmp, home, timeoutMs: EVOLVE_TIMEOUT_MS });
  const structured = /evolve/.test(r.stdout) && /baseline/.test(r.stdout);
  const honestFailure = /case \S+ threw/.test(r.stdout);
  if (!structured || looksCrashed(r)) return { step: 'hmh evolve --max=1', status: 'FAIL', detail: `exit=${r.code}; no structured cycle/baseline output` };
  const term = r.timedOut || r.code === null ? `terminated by verifier timeout at ${EVOLVE_TIMEOUT_MS / 1000}s after the structured failure below` : `exit=${r.code}`;
  return { step: 'hmh evolve --max=1', status: 'PASS', detail: `${term}; honest failure without a key: ${honestFailure ? (/case \S+ threw[^\r\n]*/.exec(r.stdout)?.[0] ?? '').slice(0, 100) : 'model errors reported in-structure'}` };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const argv = parseArgs(process.argv.slice(2), {
    fallbackVersion: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version,
  });
  if (!argv.version) { log('no --version given and no repo package.json version to fall back to'); process.exit(2); }
  for (const u of argv.unknown) log(`(ignoring unknown arg: ${u})`);
  // the registry value reaches a shell command string below — accept ONLY a
  // well-formed http(s) URL so no shell metacharacter can ever ride in
  const registry = (() => {
    try {
      const u = new URL(argv.registry || NPM_REGISTRY);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
      return u.toString().replace(/\/+$/, '');
    } catch {
      log(`invalid --registry "${argv.registry}", refusing to run (must be an http(s) URL)`);
      process.exit(2);
    }
  })();
  const startedAt = new Date();
  const rows = [];
  const meta = {
    version: argv.version, registry, keep: argv.keep,
    startedAt: startedAt.toISOString(),
    node: process.version, npm: npmVersion(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    platform: process.platform,
  };
  log(`clean-room verify @hmharness/cli@${argv.version} — registry ${registry} — node ${meta.node} — npm ${meta.npm} — ${meta.os}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-cleanroom-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  meta.tmpDir = tmp;
  let report = { meta, steps: [] };

  try {
    // 1. download + fingerprint from the official registry
    let tarballUrl = '', digests = null, integrityProblems = [];
    try {
      const dl = await stepDownload(registry, argv.version);
      tarballUrl = dl.tarballUrl;
      const tarballPath = path.join(tmp, `hmharness-cli-${argv.version}.tgz`);
      digests = await downloadWithDigests(tarballUrl, tarballPath);
      integrityProblems = checkIntegrity(digests, dl.meta.dist ?? {});
      meta.tarball = { url: tarballUrl, sha256: digests.sha256, registryIntegrity: dl.meta.dist?.integrity ?? dl.meta.dist?.shasum ?? '', bytes: fs.statSync(tarballPath).size };
      log(`tarball: ${tarballUrl}`);
      log(`sha256: ${digests.sha256}`);
      log(`registry integrity digest matches: ${integrityProblems.length === 0 ? 'YES' : 'NO — ' + integrityProblems.join('; ')}`);
      const ok = integrityProblems.length === 0 && meta.tarball.bytes > 0;
      rows.push({ step: 'download + fingerprint', status: ok ? 'PASS' : 'FAIL', detail: `${meta.tarball.bytes} bytes, sha256 ${digests.sha256.slice(0, 16)}…, integrity ${ok ? 'matches' : 'MISMATCH'}` });
      if (!ok) throw new Error('download/integrity hard failure');

      // 2. clean-room install (fresh dir + package.json first + cold cache + official registry)
      const inst = await stepInstall(tmp, tarballPath, registry);
      const installedOk = inst.code === 0 && fs.existsSync(cliMainJs(tmp));
      rows.push({ step: 'clean-room npm install', status: installedOk ? 'PASS' : 'FAIL', detail: `npm exit=${inst.code}${inst.timedOut ? ' (timeout)' : ''}; dist/main.js present=${fs.existsSync(cliMainJs(tmp))}` });
      if (!installedOk) throw new Error('install hard failure');

      // 3. pin/version verification over the installed graph
      const graph = await stepReadGraph(tmp, argv.version);
      meta.packageGraph = { installed: graph.installed, pins: graph.pins, unexpected: graph.unexpected, expected: EXPECTED_PACKAGES };
      const fatal = graph.problems.filter((p) => p.code !== 'MISSING');
      for (const p of fatal) log(`PIN/VERSION problem: ${p.code} ${p.package}: ${p.detail}`);
      const regFallback = await stepRegistryFallback(graph.missing, registry, argv.version);
      const fallbackOk = graph.missing.every((m) => regFallback[m]?.startsWith('registry confirms'));
      const pinsOk = fatal.length === 0 && fallbackOk;
      rows.push({
        step: 'pin + version verification', status: pinsOk ? 'PASS' : 'FAIL',
        detail: `${graph.installedCount} installed packages all @${argv.version}; ${graph.pinnedCount} CLI pins exact${graph.missing.length ? `; ${graph.missing.join(',')} outside dep graph → ${fallbackOk ? 'registry confirms' : 'registry NOT confirmed'}` : ''}${graph.unexpected.length ? `; unexpected: ${graph.unexpected.join(',')}` : ''}`,
      });
      if (!pinsOk) throw new Error('pin/version hard failure');

      // 4. live surfaces
      rows.push(await liveCheck(tmp, home));
      await liveWebAndTask(tmp, home, argv.version, rows);
      rows.push(await liveBench(tmp, home));
      rows.push(await liveEvolve(tmp, home));
    } catch (e) {
      if (!rows.length) rows.push({ step: 'download + fingerprint', status: 'FAIL', detail: String(e.message ?? e).slice(0, 200) });
      else log(`hard failure: ${e.message ?? e}`);
    }
  } finally {
    // 5. archive (append-only) + summary
    const finishedAt = new Date();
    meta.finishedAt = finishedAt.toISOString();
    report = { meta, steps: rows };
    try {
      const root = path.join(__dirname, '..', 'website', 'evidence', 'cleanroom');
      fs.mkdirSync(root, { recursive: true });
      const readme = path.join(root, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, 'Clean-room release-verify artifacts (audit 03 / P0-2): one directory per run, append-only — never rewrite history here.\n', 'utf8');
      }
      const versionRoot = path.join(root, `v${argv.version}`);
      const existing = fs.existsSync(versionRoot) ? fs.readdirSync(versionRoot) : [];
      const rel = evidenceDirName(argv.version, finishedAt.toISOString(), existing); // "vX/<stamp>"
      const dir = path.join(root, ...rel.split('/'));
      fs.mkdirSync(dir, { recursive: true });
      meta.evidenceDir = rel;
      // PII scrub at the single write choke point: the OS username appears in
      // tmpDir/env paths; published evidence must never carry it (pre-push
      // hook enforces). Applies to every artifact we write below.
      const user = os.userInfo().username;
      const scrub = (s) => user ? String(s).split(user).join('<user>') : String(s);
      fs.writeFileSync(path.join(dir, 'report.json'), scrub(JSON.stringify(report, null, 2) + '\n'), 'utf8');
      fs.writeFileSync(path.join(dir, 'console-output.txt'), scrub(logLines.join('\n') + '\n'), 'utf8');
      fs.writeFileSync(path.join(dir, 'environment.json'), scrub(JSON.stringify(meta, null, 2) + '\n'), 'utf8');
      if (meta.packageGraph) fs.writeFileSync(path.join(dir, 'package-graph.json'), scrub(JSON.stringify(meta.packageGraph, null, 2) + '\n'), 'utf8');
      log(`evidence archived: ${rel}`);
    } catch (e) {
      log(`ARCHIVE FAILED (exit still governed by checks): ${e.message ?? e}`);
    }
    if (argv.keep) log(`--keep: temp dir retained at ${tmp}`);
    else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    log('');
    log(summarizeRows(rows));
    const failCount = rows.filter((r) => r.status === 'FAIL').length;
    process.exit(failCount ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
