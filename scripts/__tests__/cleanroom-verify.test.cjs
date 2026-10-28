'use strict';
/**
 * Unit tests for the clean-room verify machinery (audit 03 / P0-2 gate) —
 * network-free: they exercise the injectable pure core only
 * (scripts/cleanroom-verify-core.cjs). The graph fixtures encode the three
 * states the release gate must tell apart: a clean pinned graph, a graph with
 * wrong pins/versions, and one that is missing packages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPECTED_PACKAGES, PKG_PREFIX, parseArgs, verifyPinnedGraph, summarizeRows, evidenceDirName,
} = require('../cleanroom-verify-core.cjs');

const X = '0.23.44';

/** The graph a healthy install produces: CLI pins its 15 runtime deps exactly
 *  at X and 15 packages land in node_modules (codexhost-bridge ships outside
 *  the dep graph — MISSING is expected and resolved via registry metadata). */
function healthyGraph() {
  const cliDependencies = {};
  const installed = {};
  for (const p of EXPECTED_PACKAGES) {
    if (p === 'codexhost-bridge') continue;
    if (p !== 'cli') cliDependencies[`${PKG_PREFIX}${p}`] = X;
    installed[p] = X;
  }
  return { cliDependencies, installed };
}

/* ------------------------------ parseArgs ------------------------------ */

test('parseArgs: --version=X, --version X and --keep in both spellings', () => {
  assert.equal(parseArgs(['--version=1.2.3']).version, '1.2.3');
  assert.equal(parseArgs(['--version', '1.2.3']).version, '1.2.3');
  assert.equal(parseArgs(['--keep']).keep, true);
  assert.equal(parseArgs(['--version=1.2.3', '--keep']).keep, true);
  assert.equal(parseArgs(['--version=1.2.3']).keep, false);
});

test('parseArgs: falls back to the repo version when no --version is given', () => {
  assert.equal(parseArgs([], { fallbackVersion: X }).version, X);
  assert.equal(parseArgs(['--keep'], { fallbackVersion: ` ${X} ` }).version, X); // trimmed
  assert.equal(parseArgs([]).version, ''); // no fallback available -> caller must refuse
});

test('parseArgs: --registry override, unknown flags tolerated and reported', () => {
  const a = parseArgs(['--registry=https://registry.example.com', '--future-flag', '--version=1.0.0']);
  assert.equal(a.registry, 'https://registry.example.com');
  assert.deepEqual(a.unknown, ['--future-flag']);
  assert.equal(parseArgs(['--version=1.0.0']).registry, 'https://registry.npmjs.org'); // official registry by default (mirror lag trap)
});

/* --------------------------- verifyPinnedGraph --------------------------- */

test('verifyPinnedGraph: clean graph is ok; codexhost-bridge surfaces as MISSING-for-registry-fallback, not a failure', () => {
  const g = verifyPinnedGraph({ ...healthyGraph(), expectedVersion: X });
  assert.equal(g.ok, true);
  assert.deepEqual(g.problems.map((p) => p.code), ['MISSING']);
  assert.deepEqual(g.missing, ['codexhost-bridge']);
  assert.equal(g.installedCount, 15);
  assert.equal(g.pinnedCount, 14);
  assert.deepEqual(g.unexpected, []);
});

test('verifyPinnedGraph: wrong installed version is a VERSION_MISMATCH failure naming the package', () => {
  const { cliDependencies, installed } = healthyGraph();
  installed.web = '0.23.43';
  const g = verifyPinnedGraph({ cliDependencies, installed, expectedVersion: X });
  assert.equal(g.ok, false);
  const fatal = g.problems.filter((p) => p.code !== 'MISSING'); // codexhost-bridge MISSING rides along by design
  assert.deepEqual(fatal, [{ code: 'VERSION_MISMATCH', package: 'web', detail: `installed 0.23.43, expected ${X}` }]);
});

test('verifyPinnedGraph: non-exact pin (^X, stale X-1) is a PIN_MISMATCH failure', () => {
  const { cliDependencies, installed } = healthyGraph();
  cliDependencies['@hmharness/kernel'] = `^${X}`;
  cliDependencies['@hmharness/agent'] = '0.23.43';
  const g = verifyPinnedGraph({ cliDependencies, installed, expectedVersion: X });
  assert.equal(g.ok, false);
  const pins = g.problems.filter((p) => p.code === 'PIN_MISMATCH').map((p) => p.package).sort();
  assert.deepEqual(pins, ['agent', 'kernel']);
});

test('verifyPinnedGraph: a pinned package npm failed to install is MISSING and fatal', () => {
  const { cliDependencies, installed } = healthyGraph();
  delete installed.lsp; // pin still declares it — npm resolved a broken graph
  const g = verifyPinnedGraph({ cliDependencies, installed, expectedVersion: X });
  assert.equal(g.ok, false);
  assert.ok(g.problems.some((p) => p.code === 'MISSING' && p.package === 'lsp'));
  // `missing` (the registry-fallback list) only tracks packages OUTSIDE the
  // dep graph — lsp is a pinned dep, so it must NOT be silently fallback-able
  assert.ok(!g.missing.includes('lsp'));
});

test('verifyPinnedGraph: an expected package absent from tree AND pins falls to the registry list', () => {
  const { cliDependencies, installed } = healthyGraph();
  delete installed.cognitive;
  delete cliDependencies['@hmharness/cognitive'];
  const g = verifyPinnedGraph({ cliDependencies, installed, expectedVersion: X });
  assert.equal(g.ok, false); // cognitive is not a registry-fallback package
  assert.ok(g.missing.includes('cognitive'));
});

test('verifyPinnedGraph: unexpected extra packages are reported but never fatal (以实际为准打印)', () => {
  const { cliDependencies, installed } = healthyGraph();
  installed['future-package'] = X;
  const g = verifyPinnedGraph({ cliDependencies, installed, expectedVersion: X });
  assert.equal(g.ok, true);
  assert.deepEqual(g.unexpected, ['future-package']);
});

/* ------------------------------ summarizeRows ------------------------------ */

test('summarizeRows: PASS/FAIL/SKIPPED counts drive the verdict line', () => {
  const rows = [
    { step: 'download + fingerprint', status: 'PASS', detail: 'ok' },
    { step: 'clean-room npm install', status: 'PASS', detail: 'ok' },
    { step: 'some surface', status: 'SKIPPED', detail: 'not served today' },
  ];
  const text = summarizeRows(rows);
  assert.match(text, /download \+ fingerprint\s+PASS/);
  assert.match(text, /some surface\s+SKIPPED\s+not served today/);
  assert.match(text, /PASS — PASS:2 SKIPPED:1/);
  assert.match(summarizeRows([...rows, { step: 'x', status: 'FAIL', detail: 'boom' }]), /^FAIL — PASS:2 FAIL:1 SKIPPED:1$/m);
});

/* ----------------------------- evidenceDirName ----------------------------- */

test('evidenceDirName: vX/<UTC stamp>, unique on same-second collisions', () => {
  const iso = '2026-10-29T04:33:21.123Z';
  assert.equal(evidenceDirName(X, iso), `v${X}/20261029T043321Z`);
  assert.equal(evidenceDirName(X, iso, ['20261029T043321Z']), `v${X}/20261029T043321Z-2`);
  assert.equal(evidenceDirName(X, iso, ['20261029T043321Z', '20261029T043321Z-2']), `v${X}/20261029T043321Z-3`);
  assert.equal(evidenceDirName(X, iso, ['other']), `v${X}/20261029T043321Z`); // unrelated dirs don't collide
});
