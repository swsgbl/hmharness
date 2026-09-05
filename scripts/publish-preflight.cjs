/**
 * Publish preflight (scripts/publish-preflight.cjs)
 * npm publish in this repo is a SEVEN-package ordered set: kernel ->
 * evolution -> domain-harmony -> domain-ops -> agent -> web -> cli. This
 * script verifies everything npm pack/publish would complain about,
 * WITHOUT publishing anything:
 *   1. every package builds (dist/ newer than every src file)
 *   2. dist main entry exists, bin shebang present where declared
 *   3. workspace deps referenced by shipped packages are declared in
 *      package.json (npm cannot resolve undeclared @hmh/* on install)
 *   4. npm pack --dry-run succeeds per package (tarball contents sane)
 *   5. no secrets under any dist/ (the repo-publication red line)
 * Exit code 0 = safe to run the real `npm publish -w <pkg>` sequence.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORDER = ['kernel', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli'];
let failures = 0;
const fail = (msg) => { console.error('  FAIL ' + msg); failures++; };

for (const name of ORDER) {
  console.log('== @hmh/' + name);
  const dir = path.join(ROOT, 'packages', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const dist = path.join(dir, 'dist');

  // 1. dist exists and is newer than every src file
  if (!fs.existsSync(dist)) { fail(name + ': no dist/ - run the build first'); continue; }
  let newestSrc = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|mts)$/.test(f.name)) newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(dir, 'src'));
  const mainFile = path.join(dist, (pkg.main || '').replace(/^dist[\\/]/, ''));
  if (!fs.existsSync(mainFile)) { fail(name + ': declared main missing in dist (' + pkg.main + ')'); }
  else if (fs.statSync(mainFile).mtimeMs < newestSrc) { fail(name + ': dist is STALE (src newer) - rebuild before publish'); }

  // 2. bin shebang
  if (pkg.bin) {
    const binPath = path.join(dir, Object.values(pkg.bin)[0]);
    const head = fs.readFileSync(binPath, 'utf8').slice(0, 30);
    if (!head.startsWith('#!')) fail(name + ': bin ' + binPath + ' lacks a shebang');
  }

  // 3. workspace deps declared
  const deps = { ...pkg.dependencies };
  const shippedDeps = fs.readdirSync(dist)
    .filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...fs.readFileSync(path.join(dist, f), 'utf8').matchAll(/['"](@hmh\/[a-z-]+)['"]/g)].map((m) => m[1]));
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
      else if (f.name.endsWith('.js') && secretRe.test(fs.readFileSync(p, 'utf8'))) { leaked = true; console.error('  LEAK in ' + p); }
    }
  };
  scan(dist);
  if (leaked) fail(name + ': secret-looking string in dist');
}

console.log(failures === 0 ? '\nPREFLIGHT OK - safe to publish in order: ' + ORDER.map((o) => '@hmh/' + o).join(' -> ') : '\nPREFLIGHT FAILED: ' + failures + ' issue(s)');
process.exit(failures ? 1 : 0);
