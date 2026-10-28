'use strict';
/**
 * Pure core of the clean-room release verify (audit 03 / P0-2 gate).
 *
 * Everything here is dependency-free and side-effect-free so the unit tests
 * (scripts/__tests__/cleanroom-verify.test.cjs) can inject fixture package
 * graphs without touching the network. The IO driver lives in
 * scripts/cleanroom-verify.cjs.
 */

/** The 16 first-party packages that make up a release. `cli` ships a bin and
 *  depends on 15 of them; `codexhost-bridge` is published alongside but not
 *  wired into the CLI dependency graph, so it is verified against registry
 *  metadata instead of the installed tree. */
const EXPECTED_PACKAGES = [
  'kernel', 'observability', 'evaluation', 'sandbox', 'cognitive', 'environments',
  'browser', 'extension', 'evolution', 'domain-harmony', 'domain-ops', 'lsp',
  'agent', 'web', 'cli', 'codexhost-bridge',
];

/** Packages whose absence from the installed tree is BY DESIGN (they ship
 *  outside the CLI dep graph) — their release proof comes from registry
 *  metadata, so MISSING is expected, not fatal. Any other expected package
 *  going missing means npm resolved a broken graph and IS fatal. */
const REGISTRY_FALLBACK_PACKAGES = ['codexhost-bridge'];

const PKG_PREFIX = '@hmharness/';

/** Parse CLI args. `--version=X` and `--version X` both work; `--keep`
 *  preserves the temp dir. Unknown flags are ignored (forward compat), not
 *  fatal. Falls back to `fallbackVersion` (the repo root package.json) when
 *  no --version is given — running right after `npm version bump` verifies
 *  the version you are about to publish. */
function parseArgs(argv, { fallbackVersion = '' } = {}) {
  const out = { version: '', keep: false, registry: 'https://registry.npmjs.org', unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') { out.keep = true; continue; }
    if (a.startsWith('--version=')) { out.version = a.slice('--version='.length).trim(); continue; }
    if (a === '--version') { out.version = String(argv[++i] ?? '').trim(); continue; }
    if (a.startsWith('--registry=')) { out.registry = a.slice('--registry='.length).trim(); continue; }
    out.unknown.push(a);
  }
  if (!out.version) out.version = String(fallbackVersion).trim();
  return out;
}

/** Verify the installed package graph against one expected version.
 *
 *  Three failure families, each a distinct code so the report reads like an
 *  audit trail instead of one blurry "mismatch":
 *  - PIN_MISMATCH   the CLI's dependencies don't pin every @hmharness/* dep
 *                   at exactly X (e.g. `^0.23.44` or a stale pin).
 *  - VERSION_MISMATCH an installed @hmharness/* package's own version != X.
 *  - MISSING        either a pinned dep npm failed to materialize into the
 *                   tree (broken install — always fatal), or an expected
 *                   package outside the dep graph entirely — the caller is
 *                   expected to fall back to registry metadata for those
 *                   (codexhost-bridge) and only pass if that check confirms.
 *  Extra packages outside EXPECTED_PACKAGES are reported, never fatal —
 *  "以实际为准打印": the report shows what is actually there. */
function verifyPinnedGraph({
  cliDependencies, installed, expectedVersion,
  expectedPackages = EXPECTED_PACKAGES, registryFallbackPackages = REGISTRY_FALLBACK_PACKAGES,
}) {
  const problems = [];
  const pins = {};
  for (const [name, spec] of Object.entries(cliDependencies ?? {})) {
    if (!name.startsWith(PKG_PREFIX)) continue;
    const short = name.slice(PKG_PREFIX.length);
    pins[short] = spec;
    if (spec !== expectedVersion) {
      problems.push({ code: 'PIN_MISMATCH', package: short, detail: `cli pins ${spec}, expected ${expectedVersion}` });
    }
  }
  const versions = {};
  for (const [short, version] of Object.entries(installed ?? {})) {
    versions[short] = version;
    if (version !== expectedVersion) {
      problems.push({ code: 'VERSION_MISMATCH', package: short, detail: `installed ${version}, expected ${expectedVersion}` });
    }
  }
  const unexpected = Object.keys(versions).filter((p) => !expectedPackages.includes(p));
  // pinned-but-not-installed: npm must materialize every pinned dep into the
  // tree — a pin without a package means the install resolved a broken graph
  for (const short of Object.keys(pins)) {
    if (!(short in versions)) {
      problems.push({ code: 'MISSING', package: short, detail: 'pinned by cli but absent from the installed tree' });
    }
  }
  // expected-but-nowhere: outside the dep graph entirely — by design for the
  // registry-fallback packages, a release inconsistency for anything else
  const missing = expectedPackages.filter((p) => !(p in versions) && !(p in pins));
  for (const p of missing) {
    problems.push({ code: 'MISSING', package: p, detail: 'outside the dep graph — registry fallback required' });
  }
  return {
    // ok = the installed tree is internally consistent and complete. A MISSING
    // row only stays non-fatal for the by-design registry-fallback packages
    // (codexhost-bridge); a core package going missing means npm resolved a
    // broken graph and fails the gate.
    ok: problems.every((p) => p.code === 'MISSING' && registryFallbackPackages.includes(p.package)),
    problems,
    installedCount: Object.keys(versions).length,
    pinnedCount: Object.keys(pins).length,
    installed: versions,
    pins,
    missing,
    unexpected,
  };
}

/** One PASS/FAIL/SKIPPED row per verified surface. Hard checks (download /
 *  install / pins / versions) decide the exit code; live-path rows are
 *  recorded honestly per the task's own standard — a surface the CLI cannot
 *  reach today is SKIPPED with a reason, never faked as PASS. */
function summarizeRows(rows) {
  const W = { step: 34, status: 9 };
  const head = `STEP`.padEnd(W.step) + 'STATUS'.padEnd(W.status) + 'DETAIL';
  const line = '-'.repeat(head.length);
  const body = rows.map((r) =>
    String(r.step).padEnd(W.step) + String(r.status).padEnd(W.status) + String(r.detail ?? '')
  );
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const verdict = counts.FAIL ? 'FAIL' : 'PASS';
  const tail = `${verdict} — ` + ['PASS', 'FAIL', 'SKIPPED']
    .filter((s) => counts[s]).map((s) => `${s}:${counts[s]}`).join(' ');
  return [head, line, ...body, '', tail].join('\n');
}

/** Evidence dir name: `v<version>/<UTC timestamp>` with a `-2` suffix on a
 *  same-second collision so the append-only tree never rewrites a dir. */
function evidenceDirName(version, isoNow, existingNames = []) {
  const stamp = isoNow.replace(/[-:.]/g, '').replace(/^(\d{8})T(\d{6}).*/, '$1T$2Z');
  const base = `v${version}/${stamp}`;
  if (!existingNames.includes(stamp)) return base;
  for (let n = 2; ; n++) {
    const cand = `${stamp}-${n}`;
    if (!existingNames.includes(cand)) return `v${version}/${cand}`;
  }
}

module.exports = { EXPECTED_PACKAGES, REGISTRY_FALLBACK_PACKAGES, PKG_PREFIX, parseArgs, verifyPinnedGraph, summarizeRows, evidenceDirName };
