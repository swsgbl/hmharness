#!/usr/bin/env node
// install-kaihongos.cjs — one-command board installer for @hmharness/cli on
// TWIN COPY: scripts/install-kaihongos.cjs (repo installs) and
// packages/cli/board/install-kaihongos.cjs (ships in the npm package - the
// board auto-update channel runs THIS one, settled design T28). Keep both
// in sync when bumping FALLBACK_PINS.
// KaihongOS / OpenHarmony 5.0 boards (no npm, no Python, read-only rootfs).
//
// What it does (idempotent, re-run any time):
//   1. locates a usable Node >= 22 (the running one, or known board paths)
//   2. resolves the @hmharness/* version set from registry.npmjs.org
//      (offline fallback: known-good pins below)
//   3. downloads the 10 first-party tarballs and unpacks them under
//      <BOARD_HOME>/.local/hmharness/node_modules  (staged, verified, swapped)
//   4. writes a hardened launcher and installs it into THREE locations:
//        <BOARD_HOME>/.local/bin/hmh   (user path, always writable)
//        /usr/local/bin/hmh            (default PATH on classic shells)
//        /system/bin/hmh               (read-only rootfs, remount dance;
//                                        ALSO visible inside isolated
//                                        tmpfs mount-namespace terminals
//                                        where /bin -> /system/bin)
//   5. first run: `hmh init` if config.json is missing
//
// Usage:
//   node install-kaihongos.cjs                 # install/upgrade to latest
//   node install-kaihongos.cjs --bin-only      # only (re)write launchers
//   node install-kaihongos.cjs --home=/x       # non-default board home
//
// Only Node core modules are used; tar extraction uses busybox tar.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// ---------- board constants -------------------------------------------------
let BOARD_HOME = '/data/local/home';               // KaihongOS board home
let BIN_ONLY = false;

for (const a of process.argv.slice(2)) {
  if (a.startsWith('--home=')) BOARD_HOME = a.slice(7);
  else if (a === '--bin-only') BIN_ONLY = true;
  else { console.error('unknown arg:', a); process.exit(2); }
}

const ROOT = path.join(BOARD_HOME, '.local', 'hmharness');
const NM = path.join(ROOT, 'node_modules');
const HMH_HOME = path.join(BOARD_HOME, '.hmharness');
const REG = 'https://registry.npmjs.org';
const PACKAGES = ['cli', 'web', 'agent', 'kernel', 'sandbox', 'evolution',
  'domain-ops', 'evaluation', 'observability', 'domain-harmony'];

// Known-good pin set (offline fallback when the registry is unreachable).
const FALLBACK_PINS = {
  cli: '0.23.15', web: '0.23.15', agent: '0.23.15', kernel: '0.23.15',
  sandbox: '0.23.15', evolution: '0.23.15', 'domain-ops': '0.23.15',
  evaluation: '0.23.15', observability: '0.23.15', 'domain-harmony': '0.23.15',
};

// ---------- helpers ---------------------------------------------------------
function log(msg) { console.log(msg); }

function httpsJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { headers: { 'User-Agent': 'hmh-kaihongos-installer' }, timeout: timeoutMs || 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ' -> ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function go() {
      attempt++;
      const req = https.request(new URL(url), { headers: { 'User-Agent': 'hmh-kaihongos-installer' }, timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ' -> ' + res.statusCode)); return; }
        const out = fs.createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', (e) => {
        if (attempt < 10 && /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(e.code || '')) setTimeout(retry, 1500 * attempt);
        else reject(e);
      });
      req.end();
    }
    function retry() { if (attempt < 10) go(); else reject(new Error('retries exhausted: ' + url)); }
    go();
  });
}

function extract(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // busybox tar is present on KaihongOS / OpenHarmony boards and understands
  // --strip-components. (GNU/toybox tar also fine if busybox is missing.)
  const cmds = [
    ['busybox', ['tar', '-xzf', tgz, '-C', dest, '--strip-components=1']],
    ['tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']],
  ];
  for (const [bin, args] of cmds) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    if (r.status === 0) return;
    if (r.error && r.error.code !== 'ENOENT') log('  warn: ' + bin + ' tar: ' + (r.stderr || r.error.message).slice(0, 120));
  }
  throw new Error('no usable tar (tried busybox tar, tar)');
}

async function resolveVersions() {
  log('resolving latest @hmharness/cli from registry ...');
  const meta = await httpsJSON(REG + '/@hmharness/cli');
  const cliLatest = meta['dist-tags'].latest;
  const deps = (meta.versions[cliLatest].dependencies) || {};
  const pins = { cli: cliLatest };
  for (const n of PACKAGES.slice(1)) {
    const want = deps['@hmharness/' + n];
    if (want && want !== '*') { pins[n] = want.replace(/[^0-9.]/g, ''); continue; }
    const m = await httpsJSON(REG + '/@hmharness/' + n);
    pins[n] = m['dist-tags'].latest;
  }
  return pins;
}

// ---------- node discovery --------------------------------------------------
function findNode() {
  const cands = [process.execPath,
    path.join(BOARD_HOME, 'dsh-pack/node/bin/node'),
    path.join(BOARD_HOME, '.ohos/node/bin/node'),
    '/usr/local/bin/node', '/usr/bin/node', '/system/bin/node'];
  for (const c of cands) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      const v = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (v.status === 0) { const maj = parseInt((v.stdout || '').replace('v', ''), 10); if (maj >= 22) return c; }
    } catch (_) { /* next */ }
  }
  return null;
}

// ---------- launcher --------------------------------------------------------
function launcherSource(nodeBin) {
  return [
    '#!/system/bin/sh',
    '# hmh launcher — KaihongOS board install (generated by install-kaihongos.cjs)',
    '# Board layout is fixed under ' + BOARD_HOME + ', independent of caller HOME/PATH.',
    'HROOT="' + ROOT + '"',
    'HNODE="' + nodeBin + '"',
    '[ -x "$HNODE" ] || for c in node ' + BOARD_HOME + '/dsh-pack/node/bin/node ' + BOARD_HOME + '/.ohos/node/bin/node; do',
    '  [ -x "$c" ] && HNODE="$c" && break',
    'done',
    '# optional board-wide secrets file (edit or remove — keys normally live in config.json)',
    '[ -f ' + BOARD_HOME + '/.config/apikeys.env ] && . ' + BOARD_HOME + '/.config/apikeys.env',
    '# board shells run with HOME=/ — force a real writable HOME and a stable state dir',
    '[ -z "${HMH_HOME:-}" ] && export HMH_HOME="' + HMH_HOME + '"',
    'export HOME="' + BOARD_HOME + '"',
    'export NODE_ALLOW_JIT="${NODE_ALLOW_JIT:-1}"',
    '# drop --jitless inherited from sandbox profiles; board root shell can JIT',
    'NODE_OPTIONS="$(echo "${NODE_OPTIONS:-}" | sed \'s|--jitless||g; s/  */ /g\')"',
    'NODE_OPTIONS="$(echo "$NODE_OPTIONS" | sed \'s/^ *//;s/ *$//\')"',
    '[ -n "$NODE_OPTIONS" ] && export NODE_OPTIONS',
    '# optional DevEco-layout toolchain shims (hvigorw / ohpm)',
    '[ -z "${HM_DEVECO_HOME:-}" ] && [ -d ' + BOARD_HOME + '/.local/hm-devtools ] && export HM_DEVECO_HOME="' + BOARD_HOME + '/.local/hm-devtools"',
    'exec "$HNODE" "$HROOT/node_modules/@hmharness/cli/dist/main.js" "$@"',
    '',
  ].join('\n');
}

function writeLauncher(nodeBin) {
  const src = launcherSource(nodeBin);
  const userBin = path.join(BOARD_HOME, '.local', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(path.join(userBin, 'hmh'), src);
  fs.chmodSync(path.join(userBin, 'hmh'), 0o755);
  log('launcher: ' + path.join(userBin, 'hmh'));

  // System locations live on the read-only rootfs — remount rw, copy, restore ro.
  // /system/bin matters most: isolated tmpfs-namespace terminals (ttyd web
  // terminals, containers) see no /usr at all, but /bin -> /system/bin + /data.
  for (const sysBin of ['/usr/local/bin', '/system/bin']) {
    try { fs.mkdirSync(sysBin, { recursive: true }); } catch (_) { /* exists */ }
    const target = path.join(sysBin, 'hmh');
    const rw = spawnSync('mount', ['-o', 'remount,rw', '/'], { encoding: 'utf8' });
    try {
      fs.writeFileSync(target, src);
      fs.chmodSync(target, 0o755);
      log('launcher: ' + target + (rw.status === 0 ? ' (rootfs remounted rw then ro)' : ''));
    } catch (e) {
      log('warn: could not write ' + target + ': ' + e.message);
    } finally {
      if (rw.status === 0) spawnSync('mount', ['-o', 'remount,ro', '/'], { encoding: 'utf8' });
    }
  }
}

// ---------- main ------------------------------------------------------------
(async () => {
  log('board home: ' + BOARD_HOME);
  const nodeBin = findNode();
  if (!nodeBin) { console.error('FATAL: no Node >= 22 found (looked at PATH, dsh-pack, .ohos). hmh needs Node >= 22.'); process.exit(1); }
  log('node: ' + nodeBin + ' (' + (spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout || '').trim() + ')');

  if (!BIN_ONLY) {
    let pins;
    try { pins = await resolveVersions(); }
    catch (e) {
      log('warn: registry unreachable (' + e.message.slice(0, 80) + ') — falling back to known-good pins');
      pins = Object.assign({}, FALLBACK_PINS);
    }
    for (const n of PACKAGES) log('  @hmharness/' + n + '@' + pins[n]);

    const STAGE = NM + '.new';
    fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(path.join(STAGE, '@hmharness'), { recursive: true });
    for (const name of PACKAGES) {
      const ver = pins[name];
      const tgz = path.join(ROOT, '.stage.tgz');
      process.stdout.write('download ' + name + '@' + ver + ' ... ');
      await download(REG + '/@hmharness/' + name + '/-/' + name + '-' + ver + '.tgz', tgz);
      const dest = path.join(STAGE, '@hmharness', name);
      extract(tgz, dest);
      const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
      if (pkg.version !== ver) throw new Error(name + ': unpacked ' + pkg.version + ' != ' + ver);
      log('ok');
    }
    fs.rmSync(path.join(ROOT, '.stage.tgz'), { force: true });

    // syntax-check the staged CLI entrypoint before swapping anything
    const main = path.join(STAGE, '@hmharness', 'cli', 'dist', 'main.js');
    const chk = spawnSync(nodeBin, ['--check', main], { encoding: 'utf8' });
    if (chk.status !== 0) throw new Error('staged main.js failed --check: ' + (chk.stderr || '').slice(0, 200));
    log('staged CLI entrypoint OK');

    const BAK = NM + '.bak';
    fs.rmSync(BAK, { recursive: true, force: true });
    if (fs.existsSync(NM)) fs.renameSync(NM, BAK);
    fs.renameSync(STAGE, NM);
    log('installed @hmharness/cli@' + pins.cli + ' (previous tree kept at ' + BAK + ')');
  }

  writeLauncher(nodeBin);

  // first run: create the state skeleton + blank config (never overwrite)
  if (!fs.existsSync(path.join(HMH_HOME, 'config.json'))) {
    log('first run: creating config skeleton at ' + HMH_HOME);
    const r = spawnSync(nodeBin, [path.join(NM, '@hmharness', 'cli', 'dist', 'main.js'), 'init'], {
      encoding: 'utf8', env: Object.assign({}, process.env, { HMH_HOME, HOME: BOARD_HOME }),
    });
    log((r.stdout || r.stderr || '').trim().split('\n').slice(-3).join('\n'));
  }

  console.log('\nnext steps:');
  console.log('  1. put your provider keys in ' + path.join(HMH_HOME, 'config.json'));
  console.log('     (presets for 38 vendors: docs/PROVIDERS.md)');
  console.log('  2. hmh check     # verify toolchain');
  console.log('  3. hmh tui       # or: hmh web start  →  http://127.0.0.1:7788');
  console.log('pitfalls & details: docs/KAIHONGOS.md');
})().catch((e) => { console.error('INSTALL FAILED:', e.message); process.exit(1); });
