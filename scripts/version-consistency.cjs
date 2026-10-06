/**
 * version-consistency.cjs - P0-Hygiene guard (2026-10-05 upgrade pack)
 *
 * The pack's finding: code at 0.23.x while CHANGELOG head sat at 0.14.9 and
 * git tags stopped at v0.18.12 - release-documentation drift that makes
 * external users/researchers misjudge project state. This check makes the
 * whole version surface machine-verifiable, wired into publish-preflight
 * (fail on divergence, same posture as the manifest TRAP GUARD).
 *
 * Hard checks (exit 1 on divergence):
 *   1. root package.json version == every workspace package.json version
 *   2. CHANGELOG.md's first version heading == that version
 *   3. packages/cli/release-notes.json has a briefing entry for it
 *   4. website/llms.txt, llms-full.txt, index.html, faq.html all carry it
 * Warn-only (printed, never fails):
 *   5. git tag v<version> exists (tag discipline is still becoming habit;
 *      enforcement flips once every release carries a tag)
 *   6. --npm: registry latest for @hmharness/cli (network-gated, opt-in)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SET = ['kernel', 'observability', 'evaluation', 'sandbox', 'cognitive', 'environments', 'browser', 'extension',
  'evolution', 'domain-harmony', 'domain-ops', 'lsp', 'agent', 'web', 'cli', 'codexhost-bridge'];
const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const problems = [];
const warnings = [];

for (const p of SET) {
  const pv = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', p, 'package.json'), 'utf8')).version;
  if (pv !== v) problems.push(`packages/${p} at ${pv}, root at ${v}`);
}

const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const head = cl.match(/^## \[(0\.\d+\.\d+)\]/m);
if (!head) problems.push('CHANGELOG.md has no "## [version]" heading');
else if (head[1] !== v) problems.push(`CHANGELOG head is ${head[1]}, packages at ${v}`);

const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'release-notes.json'), 'utf8')).notes;
if (!notes.some((n) => n.v === v)) problems.push(`release-notes.json has no briefing entry for ${v}`);

const sites = [
  ['website/llms.txt', new RegExp('@hmharness/cli ' + v.replace(/\./g, '\\.'))],
  ['website/llms-full.txt', new RegExp('当前 ' + v.replace(/\./g, '\\.'))],
  ['website/index.html', new RegExp('softwareVersion":"' + v.replace(/\./g, '\\.'))],
  ['website/faq.html', new RegExp('softwareVersion": "' + v.replace(/\./g, '\\.'))],
];
for (const [f, re] of sites) {
  if (!re.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) problems.push(`${f} does not carry ${v}`);
}

try {
  const tags = execSync('git tag --list', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!tags.includes('v' + v)) warnings.push(`no git tag v${v} (tag the release commit and push tags)`);
} catch { /* tag listing is advisory */ }

if (process.argv.includes('--npm')) {
  try {
    const latest = execSync('npm view @hmharness/cli version --registry https://registry.npmjs.org', { encoding: 'utf8', timeout: 30_000 }).trim();
    if (latest !== v) warnings.push(`npm latest is ${latest}, packages at ${v} (expected DURING a release, fatal after)`);
  } catch { warnings.push('npm registry unreachable - latest-version check skipped'); }
}

for (const w of warnings) console.log('WARN ' + w);
if (problems.length) {
  for (const p of problems) console.log('FAIL ' + p);
  console.log(`VERSION CONSISTENCY FAILED at ${v}`);
  process.exit(1);
}
console.log(`VERSION CONSISTENCY OK at ${v} (${SET.length} packages, CHANGELOG head, briefing note, 4 website files${warnings.length ? ', ' + warnings.length + ' warning(s)' : ''})`);
