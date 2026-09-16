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
    console.log('\n--- skip @hmharness/' + name + ' ' + pkg.version + ' (already on npm) ---');
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
