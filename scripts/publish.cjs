/**
 * Publish executor (scripts/publish.cjs)
 * Runs the REAL publish after the user has authenticated:
 *   npm login --registry https://registry.npmjs.org
 * then:  node scripts/publish.cjs
 *
 * Order is load-bearing (each package installs its deps on publish):
 * kernel -> evolution -> domain-harmony -> domain-ops -> agent -> web -> cli
 * Every package publishes with --access public (scoped packages default to
 * restricted) and --registry npmjs (this machine's .npmrc points at
 * npmmirror, which is read-only).
 * --dry-run flag: run everything except the final npm publish calls.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORDER = ['kernel', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli'];
const DRY = process.argv.includes('--dry-run');
const REG = 'https://registry.npmjs.org';

// 0. preflight first - never publish a broken set
console.log('--- preflight ---');
try {
  execSync('node scripts/publish-preflight.cjs', { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
} catch {
  console.error('preflight failed - publish aborted');
  process.exit(1);
}

// 1. whoami check (fail fast with a pointed message instead of per-package 403s)
try {
  const who = execSync('npm whoami --registry ' + REG, { encoding: 'utf8', timeout: 30000, shell: 'cmd.exe', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  console.log('publishing as:', who);
} catch {
  console.error('NOT LOGGED IN to ' + REG + '. Run: npm login --registry ' + REG);
  process.exit(1);
}

// 2. ordered publish
for (const name of ORDER) {
  const dir = path.join(ROOT, 'packages', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const args = ['publish', '--access', 'public', '--registry', REG];
  if (DRY) args.push('--dry-run');
  console.log('\n--- publishing @hmh/' + name + ' ' + pkg.version + (DRY ? ' (dry-run)' : '') + ' ---');
  try {
    execSync('npm ' + args.join(' '), { cwd: dir, encoding: 'utf8', stdio: 'inherit', timeout: 600000 });
    console.log('OK @hmh/' + name);
  } catch (err) {
    console.error('FAILED @hmh/' + name + ' - stopping the ordered set here.');
    process.exit(1);
  }
}
console.log('\nALL SEVEN PUBLISHED' + (DRY ? ' (dry-run)' : '') + ' - verify: npm view @hmh/cli version');
