#!/usr/bin/env node
// heal-tree.cjs — self-healing completeness check for the hmharness board tree.
// TWIN COPY: scripts/heal-tree.cjs (repo installs) and
// packages/cli/board/heal-tree.cjs (ships in the npm package). Keep both in
// sync. install-kaihongos.cjs copies this file to <HMH_HOME>/heal-tree.cjs
// and the launcher hook (see installHealLayer) runs it before every start.
//
// WHY: a board auto-update swaps node_modules wholesale; any incompleteness
// in the package set — a lagging hardcoded list, a rename or split between
// releases — bricks the next launch with ERR_MODULE_NOT_FOUND. Repairs made
// INSIDE the tree are wiped by the same swap, so the healer lives outside it
// (in ~/.hmharness, the state dir no update touches).
//
// HOW: discover the required @hmharness/* set from the tree itself —
//   1. BFS over installed package.json "dependencies" (declared graph)
//   2. static scan of built code for '@hmharness/<name>' imports (catches
//      undeclared-but-imported packages)
// then download any missing tarball from registry.npmjs.org at the version
// the tree is on; offline, restore from node_modules.bak at the same version.
// No hardcoded package list: immune to upstream growth. As a second layer it
// also re-extends the PACKAGES list of the embedded board installer, so the
// NEXT auto-update itself installs a complete tree.
//
// Exit 0 = tree verified complete. Exit 1 = could not complete (retried on
// the next launch). The launcher never blocks on this script.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// Board home is overridable so the same script serves non-default --home=
// installs; the launcher hook exports HMH_BOARD_HOME before invoking it.
const BOARD_HOME = process.env.HMH_BOARD_HOME || '/data/local/home';
const HROOT = path.join(BOARD_HOME, '.local', 'hmharness');
const NM = path.join(HROOT, 'node_modules', '@hmharness');
const HMH_HOME = path.join(BOARD_HOME, '.hmharness');
const LOG = path.join(HMH_HOME, 'heal.log');
const REG = 'https://registry.npmjs.org';
const MAX_ROUNDS = 6;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* best-effort */ }
}

// ---------- registry helpers (Node core only, busybox for tar) --------------
function download(url, file) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const go = () => {
      attempt++;
      const req = https.request(new URL(url), { headers: { 'User-Agent': 'hmh-heal' }, timeout: 45000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ' -> ' + res.statusCode)); return; }
        const out = fs.createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', (e) => {
        if (attempt < 8 && /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(e.code || '')) setTimeout(retry, 2000 * attempt);
        else reject(e);
      });
      req.end();
    };
    const retry = () => { if (attempt < 8) go(); else reject(new Error('retries exhausted: ' + url)); };
    go();
  });
}

function extract(tgz, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const cmds = [
    ['busybox', ['tar', '-xzf', tgz, '-C', dest, '--strip-components=1']],
    ['tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']],
  ];
  for (const [bin, args] of cmds) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    if (r.status === 0) return;
  }
  throw new Error('no usable tar');
}

/** Offline fallback: copy a package from the previous tree (node_modules.bak)
 *  when the registry is unreachable, but ONLY at the exact same version. */
function restoreFromBak(name, ver) {
  const bakPkg = path.join(HROOT, 'node_modules.bak', '@hmharness', name, 'package.json');
  try {
    const bak = JSON.parse(fs.readFileSync(bakPkg, 'utf8'));
    if (bak.version !== ver) return false;
    fs.cpSync(path.dirname(bakPkg), path.join(NM, name), { recursive: true });
    return true;
  } catch { return false; }
}

// ---------- discovery -------------------------------------------------------
function readPkg(name) {
  try { return JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8')); }
  catch { return null; }
}

/** All @hmharness/* names referenced by the tree: declared deps (BFS) plus
 *  imports found in built code (catches undeclared imports). */
function discoverRequired() {
  const have = new Set(fs.readdirSync(NM));
  const declared = new Map(); // name -> Set of required version strings
  const queue = ['cli'];
  const seen = new Set();
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n) || !have.has(n)) continue;
    seen.add(n);
    const deps = (readPkg(n) || {}).dependencies || {};
    for (const [dep, ver] of Object.entries(deps)) {
      if (!dep.startsWith('@hmharness/')) continue;
      const sub = dep.slice(11);
      if (!declared.has(sub)) declared.set(sub, new Set());
      declared.get(sub).add(String(ver));
      if (have.has(sub) && !seen.has(sub)) queue.push(sub);
    }
  }
  // static import scan over built code (dist/, board/, root .js) for BOTH
  // declared and undeclared references
  const imported = new Set();
  const scanDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') scanDir(p); continue; }
      if (!e.name.endsWith('.js') && !e.name.endsWith('.cjs') && !e.name.endsWith('.mjs')) continue;
      let src;
      try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/@hmharness\/([a-z0-9][a-z0-9.-]*)/g)) imported.add(m[1]);
    }
  };
  for (const n of have) scanDir(path.join(NM, n));
  return { have, declared, imported };
}

/** Best version for a missing package: prefer the tree's cli version (first-party
 *  packages release in lockstep), then any explicitly declared version, then
 *  the max declared. */
function pickVersion(name, declared, cliVer) {
  const vs = declared.get(name) || new Set();
  if (vs.has(cliVer)) return cliVer;
  const clean = [...vs].map((v) => v.replace(/[^0-9.]/g, '')).filter(Boolean).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  });
  return clean[clean.length - 1] || cliVer;
}

// ---------- layer 2: patch the embedded installer's package list ------------
function patchEmbeddedInstaller(required) {
  const inst = path.join(NM, 'cli', 'board', 'install-kaihongos.cjs');
  if (!fs.existsSync(inst)) return;
  let src;
  try { src = fs.readFileSync(inst, 'utf8'); } catch { return; }
  const m = src.match(/const PACKAGES = \[([^\]]*)\]/);
  if (!m) return;
  const cur = new Set([...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]));
  const need = new Set([...cur, ...required]);
  need.delete('cli');
  if (need.size === cur.size - (cur.has('cli') ? 1 : 0)) return; // nothing new
  const names = ['cli', ...[...need].sort()];
  const arr = "const PACKAGES = [" + names.map((n) => "'" + n + "'").join(', ') + "];";
  const next = src.replace(/const PACKAGES = \[[^\]]*\]/, arr +
    '\n// (list auto-extended by heal-tree.cjs: registry deps + code imports)');
  // write only when it still parses (write to a .cjs temp — node --check
  // rejects unknown extensions — then check and swap)
  try {
    const tmp = inst + '.heal.cjs';
    fs.writeFileSync(tmp, next);
    const c2 = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (c2.status === 0) { fs.rmSync(inst, { force: true }); fs.renameSync(tmp, inst); log('patched embedded installer PACKAGES -> ' + names.length + ' packages'); }
    else { fs.rmSync(tmp, { force: true }); log('warn: embedded installer patch failed --check (' + String((c2.stderr || '')).split('\n')[0].slice(0, 120) + '), left stock'); }
  } catch (e) { log('warn: could not patch embedded installer: ' + e.message); }
}

// ---------- main ------------------------------------------------------------
(async () => {
  // keep the log bounded
  try { const st = fs.statSync(LOG); if (st.size > 256 * 1024) fs.rmSync(LOG); } catch { /* new */ }
  // single-instance lock (5 min staleness). NOTE: exit via process.exitCode +
  // return — process.exit() skips finally and would leak the lock dir.
  const lock = path.join(HMH_HOME, '.heal.lock');
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 5 * 60_000) { log('another heal is running, skipping (stamp untouched)'); process.exit(1); }
  } catch { /* no lock */ }
  fs.rmSync(lock, { recursive: true, force: true });
  try { fs.mkdirSync(lock); } catch { /* ok */ }

  let exitCode = 1;
  try {
    if (!fs.existsSync(path.join(NM, 'cli'))) {
      log('FATAL: cli package missing entirely — run the board installer manually');
      return;
    }
    const cliVer = readPkg('cli').version;
    log('heal start · tree @' + cliVer);

    let installedTotal = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { have, declared, imported } = discoverRequired();
      const missing = [...new Set([...declared.keys(), ...imported])].filter((n) => !have.has(n));
      if (missing.length === 0) {
        // complete: patch the embedded installer so the NEXT auto-update
        // itself installs a complete tree (layer 2), then report success
        patchEmbeddedInstaller(new Set([...declared.keys(), ...imported]));
        log('tree complete (' + have.size + ' first-party packages)' + (installedTotal ? ' · installed ' + installedTotal + ' this run' : ''));
        exitCode = 0;
        return;
      }
      let progressed = false;
      let networkFailed = false;
      for (const name of missing) {
        const ver = pickVersion(name, declared, cliVer);
        const tgz = path.join(HROOT, '.heal.tgz');
        log('missing ' + name + ' -> installing @' + ver);
        try {
          await download(REG + '/@hmharness/' + name + '/-/' + name + '-' + ver + '.tgz', tgz);
          extract(tgz, path.join(NM, name));
          const got = readPkg(name);
          if (!got || got.version !== ver) throw new Error('unpacked ' + (got && got.version) + ' != ' + ver);
          log('installed ' + name + '@' + ver);
          installedTotal++; progressed = true;
        } catch (e) {
          const notFound = /-> 404/.test(e.message);
          log((notFound ? 'warn: ' : 'error: ') + name + '@' + ver + ': ' + e.message.slice(0, 140));
          if (notFound) continue; // scan-only overmatch: ignore
          // network failure: try the previous tree at the same version, else
          // keep going — other packages may still download fine
          networkFailed = true;
          if (restoreFromBak(name, ver)) { log('restored ' + name + '@' + ver + ' from node_modules.bak (offline)'); installedTotal++; progressed = true; }
        }
      }
      if (!progressed) { log('no progress this round' + (networkFailed ? ' (network unreachable — will retry next launch)' : '')); return; }
    }
    log('rounds exhausted');
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
  process.exitCode = exitCode;
})();
