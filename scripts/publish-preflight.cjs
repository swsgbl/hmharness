/**
 * Publish preflight (scripts/publish-preflight.cjs)
 * npm publish in this repo is an EIGHT-package ordered set: kernel ->
 * evolution -> domain-harmony -> domain-ops -> agent -> web -> cli ->
 * codexhost-bridge. This
 * script verifies everything npm pack/publish would complain about,
 * WITHOUT publishing anything:
 *   0. unit tests + typecheck pass (a compiling-but-broken build used to be
 *      publishable: freshness != correctness)
 *   1. every package builds (dist/ newer than every src file, or bin/ for source-only packages)
 *   2. the main/bin entry exists, bin shebang present where declared
 *   3. workspace deps referenced by shipped packages are declared in
 *      package.json (npm cannot resolve undeclared @hmharness/* on install)
 *   4. npm pack --dry-run succeeds per package (tarball contents sane)
 *   5. no secrets under any dist/ (the repo-publication red line)
 * Exit code 0 = safe to run the real `npm publish -w <pkg>` sequence.
 * (--skip-tests skips step 0 for offline republishing of an unchanged tree.)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORDER = ['kernel', 'observability', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli', 'codexhost-bridge'];
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const packages = requested.length ? requested : ORDER;
let failures = 0;
const fail = (msg) => { console.error('  FAIL ' + msg); failures++; };

// 0. tests + typecheck once, before any per-package checks
if (!process.argv.includes('--skip-tests')) {
  console.log('== unit tests + typecheck');
  for (const cmd of ['npm run typecheck', 'npm test']) {
    try {
      execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000 });
      console.log('  ' + cmd + ': ok');
    } catch (e) {
      fail(cmd + ' failed - refusing to publish a broken build:\n' + String(e.stdout || e.stderr || '').slice(-800));
    }
  }
}

for (const name of packages) {
  if (!ORDER.includes(name)) {
    fail('unknown package: ' + name + ' (expected one of ' + ORDER.join(', ') + ')');
    continue;
  }
  console.log('== @hmharness/' + name);
  const dir = path.join(ROOT, 'packages', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.private === true) fail(name + ': package.json must not set private=true for npm publishing');
  const isSourcePackage = name === 'codexhost-bridge';
  const dist = path.join(dir, isSourcePackage ? 'bin' : 'dist');
  const sourceRoot = path.join(dir, isSourcePackage ? 'bin' : 'src');

  // 1. shipped implementation exists and is newer than its source input
  if (!fs.existsSync(dist)) { fail(name + ': no shipped implementation - run the build first'); continue; }
  let newestSrc = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|mts)$/.test(f.name)) newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs);
    }
  };
  walk(sourceRoot);
  const entry = pkg.main || (pkg.bin && Object.values(pkg.bin)[0]);
  const mainFile = path.join(dir, entry || '');
  if (!fs.existsSync(mainFile)) { fail(name + ': declared entry missing (' + entry + ')'); }
  else if (fs.statSync(mainFile).mtimeMs < newestSrc) { fail(name + ': shipped implementation is STALE (source newer) - rebuild before publish'); }

  // 2. bin shebang
  if (pkg.bin) {
    const binPath = path.join(dir, Object.values(pkg.bin)[0]);
    const head = fs.readFileSync(binPath, 'utf8').slice(0, 30);
    if (!head.startsWith('#!')) fail(name + ': bin ' + binPath + ' lacks a shebang');
  }

  // 3. workspace deps declared
  const deps = { ...pkg.dependencies };
  const shippedFiles = [];
  const collectFiles = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) collectFiles(p);
      else if (/\.(js|mjs|cjs)$/.test(f.name)) shippedFiles.push(p);
    }
  };
  collectFiles(dist);
  const shippedDeps = shippedFiles
    .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/['"](@hmharness\/[a-z-]+)['"]/g)].map((m) => m[1]));
  for (const d of new Set(shippedDeps)) {
    if (!deps[d]) fail(name + ': dist imports ' + d + ' but package.json does not declare it');
  }

  // 4. npm pack --dry-run
  try {
    const out = execSync('npm pack --dry-run', { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
    const m = out.match(/package size:\s*(.+)/);
    console.log('  pack: ' + (m ? m[1].trim() : 'ok'));
  } catch (e) { fail(name + ': npm pack --dry-run failed: ' + String(e.stderr || '').slice(0, 200)); }

  // 5. secret scan on dist (coarse)
  const secretRe = /(?:sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9]{20,}|freellmapi-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,})/;
  let leaked = false;
  const scan = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) scan(p);
      else if (/\.(js|mjs|cjs)$/.test(f.name) && secretRe.test(fs.readFileSync(p, 'utf8'))) { leaked = true; console.error('  LEAK in ' + p); }
    }
  };
  scan(dist);
  if (leaked) fail(name + ': secret-looking string in dist');
}

console.log(failures === 0 ? '\nPREFLIGHT OK - safe to publish in order: ' + packages.map((o) => '@hmharness/' + o).join(' -> ') : '\nPREFLIGHT FAILED: ' + failures + ' issue(s)');
process.exit(failures ? 1 : 0);
