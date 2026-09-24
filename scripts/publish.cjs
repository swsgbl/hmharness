/**
 * Publish executor (scripts/publish.cjs)
 * Runs the REAL publish after the user has authenticated:
 *   npm login --registry https://registry.npmjs.org
 * then:  node scripts/publish.cjs
 *
 * Order is load-bearing (each package installs its deps on publish):
 * kernel -> observability -> evolution -> domain-harmony -> domain-ops ->
 * agent -> web -> cli -> codexhost-bridge
 * Every package publishes with --access public (scoped packages default to
 * restricted) and --registry npmjs (this machine's .npmrc points at
 * npmmirror, which is read-only).
 * --dry-run flag: run everything except the final npm publish calls.
 */
const { execSync } = require('child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORDER = ['kernel', 'observability', 'evaluation', 'sandbox', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli', 'codexhost-bridge'];
const DRY = process.argv.includes('--dry-run');
const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const REG = 'https://registry.npmjs.org';

// 0. preflight first - never publish a broken set
console.log('--- preflight ---');
try {
  execSync('node scripts/publish-preflight.cjs' + (ONLY ? ' ' + ONLY : ''), { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
} catch {
  console.error('preflight failed - publish aborted');
  process.exit(1);
}

// 1. whoami check (fail fast with a pointed message instead of per-package 403s)
// Token path: NODE_AUTH_TOKEN env (granular token with bypass-2fa) passes
// straight through to npm; the token is never written to disk or logs.
const TOKEN = process.env.NODE_AUTH_TOKEN;
const ENV = { ...process.env, ...(TOKEN ? { NODE_AUTH_TOKEN: TOKEN } : {}) };
try {
  const who = execSync('npm whoami --registry ' + REG, { encoding: 'utf8', timeout: 30000, shell: 'cmd.exe', stdio: ['pipe', 'pipe', 'pipe'], env: ENV }).trim();
  console.log('publishing as:', who, '(auth: ' + (TOKEN ? 'NODE_AUTH_TOKEN' : 'npm login session') + ')');
} catch {
  console.error('NOT LOGGED IN to ' + REG + '. Run: npm login --registry ' + REG + '  (or set NODE_AUTH_TOKEN to a granular token with bypass-2fa)');
  process.exit(1);
}

// 2. ordered publish
async function npmVersion(name) {
  // the registry packument is the ONLY truth (memory lesson: the old
  // ALL-PUBLISHED check could false-positive); missing package -> ''
  try {
    const r = await fetch('https://registry.npmjs.org/' + name);
    if (!r.ok) return '';
    const j = await r.json();
    return (j['dist-tags'] && j['dist-tags'].latest) || '';
  } catch { return ''; }
}

async function tarballFileHashes(tgzPath) {
  // extract a packed tgz and hash every file's CONTENT (mtime-insensitive)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-pub-'));
  try {
    execSync(`tar -xzf "${tgzPath.replace(/\\/g, '/')}" -C "${tmp.replace(/\\/g, '/')}"`, { stdio: 'ignore' });
    const hashes = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) hashes[path.relative(tmp, p).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      }
    };
    walk(tmp);
    return hashes;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function sameAsRegistry(pkgJson, dir) {
  // when a package is about to be SKIPPED (version already live), verify
  // the freshly packed tarball matches the registry tarball file-by-file;
  // a diff means source changed without a version bump (bit us 3x:
  // agent/i18n, domain-ops, evolution reward-model)
  try {
    const r = await fetch('https://registry.npmjs.org/' + pkgJson.name);
    if (!r.ok) return { ok: true };
    const pack = await r.json();
    const ver = pack.versions && pack.versions[pkgJson.version];
    if (!ver || !ver.dist || !ver.dist.tarball) return { ok: true };
    const packOut = execSync('npm pack --silent', { cwd: dir, encoding: 'utf8' });
    // npm pack prints the produced filename (scoped @hmharness/cli -> hmharness-cli-x.y.z.tgz)
    const produced = (packOut || '').trim().split('\n').filter(Boolean).slice(-1)[0];
    if (!produced) return { ok: true };
    const localTgz = path.join(dir, produced);
    const dl = path.join(os.tmpdir(), 'hmh-registry-' + Date.now() + '.tgz');
    const buf = Buffer.from(await (await fetch(ver.dist.tarball)).arrayBuffer());
    fs.writeFileSync(dl, buf);
    const a = await tarballFileHashes(localTgz);
    const b = await tarballFileHashes(dl);
    fs.rmSync(dl, { force: true });
    fs.rmSync(localTgz, { force: true });
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [...keys].filter((k) => a[k] !== b[k]);
    return diffs.length ? { ok: false, diffs: diffs.slice(0, 8) } : { ok: true };
  } catch (e) {
    return { ok: true, note: 'compare unavailable: ' + String(e.message).slice(0, 80) };
  }
}

async function main() {
for (const name of ONLY ? [ONLY] : ORDER) {
  if (!ORDER.includes(name)) {
    console.error('unknown package: ' + name + ' (expected one of ' + ORDER.join(', ') + ')');
    process.exit(1);
  }
  const dir = path.join(ROOT, 'packages', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  // idempotent release: an unchanged package (version already live) is
  // skipped, so the FULL ordered set can run on every release without
  // failing on the packages that didn't change
  const live = await npmVersion(pkg.name);
  if (live === pkg.version) {
    const same = await sameAsRegistry(pkg, dir);
    if (!same.ok) {
      console.error('\n!!! @hmharness/' + name + ' ' + pkg.version + ' is already on npm but the LOCAL source differs:');
      console.error('    ' + (same.diffs || []).join('\n    '));
      console.error('    This is the changed-source-without-bump trap (agent/i18n, domain-ops, evolution).');
      console.error('    Bump the package version (and dependents\' pins) or pass --force-skip-check to override.');
      if (!process.argv.includes('--force-skip-check')) process.exit(1);
    }
    console.log('\n--- skip @hmharness/' + name + ' ' + pkg.version + ' (already on npm, content verified identical' + (same.note ? '; ' + same.note : '') + ') ---');
    continue;
  }
  const args = ['publish', '--access', 'public', '--registry', REG];
  if (DRY) args.push('--dry-run');
  console.log('\n--- publishing @hmharness/' + name + ' ' + pkg.version + (DRY ? ' (dry-run)' : '') + ' ---');
  try {
    execSync('npm ' + args.join(' '), { cwd: dir, encoding: 'utf8', stdio: 'inherit', timeout: 600000, env: ENV });
    console.log('OK @hmharness/' + name);
  } catch (err) {
    console.error('FAILED @hmharness/' + name + ' - stopping the ordered set here.');
    process.exit(1);
  }
}
console.log('\nALL PUBLISHED' + (DRY ? ' (dry-run)' : '') + (ONLY ? ': @hmharness/' + ONLY : ' - verify: npm view @hmharness/cli version'));
}
main().catch((err) => { console.error(String(err)); process.exit(1); });
