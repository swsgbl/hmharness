#!/usr/bin/env node
/**
 * Crowd pack builder (scripts/crowd-merge.cjs)
 * Aggregates N anonymous experience summaries into ONE pack per fingerprint
 * class — what the community ships as crowd/<os>-<arch>.json:
 *
 *   node scripts/crowd-merge.cjs summary1.json summary2.json -o crowd/win32-x64.json
 *
 * Refuses to mix incompatible fingerprint classes (a linux/arm64 stat must
 * never ride inside a win32/x64 pack). The output uses the crowd-summary
 * format so end users absorb it unchanged: hmh cognitive absorb <pack>.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const inputs = args.filter((a, i) => a !== '-o' && args[i - 1] !== '-o');

if (inputs.length === 0) {
  console.error('usage: node scripts/crowd-merge.cjs <summary.json> [...] -o <pack.json>');
  process.exit(1);
}

const summaries = [];
for (const f of inputs) {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.kind !== 'hmharness-crowd-summary') { console.error(`SKIP ${f}: not a crowd summary`); continue; }
    summaries.push(j);
    console.error(`+ ${f}: ${j.stats.length} stats, fingerprint ${j.fingerprint.os}/${j.fingerprint.arch}`);
  } catch (e) {
    console.error(`SKIP ${f}: ${String(e).slice(0, 60)}`);
  }
}

// merge logic mirrors cognitive/src/crowd.ts (kept dependency-free here so
// the script runs from any checkout without a build)
const compat = (a, b) => a.os === b.os && a.arch === b.arch && a.shell === b.shell;
if (summaries.length === 0) { console.error('no valid summaries'); process.exit(1); }
const base = summaries[0].fingerprint;
for (const s of summaries) {
  if (!compat(base, s.fingerprint)) {
    console.error(`REFUSED: fingerprint class mismatch (${s.fingerprint.os}/${s.fingerprint.arch} into ${base.os}/${base.arch}) — split by class`);
    process.exit(1);
  }
}
const table = new Map();
for (const s of summaries) {
  for (const st of s.stats) {
    const key = `${st.environmentId}|${st.actionType}`;
    const agg = table.get(key) ?? { n: 0, ok: 0, ms: 0 };
    agg.n += st.n; agg.ok += st.successRate * st.n; agg.ms += st.meanDurationMs * st.n;
    table.set(key, agg);
  }
}
const stats = [...table.entries()]
  .map(([key, v]) => {
    const [environmentId, actionType] = key.split('|');
    return { environmentId, actionType, n: v.n, successRate: Number((v.ok / v.n).toFixed(3)), meanDurationMs: Math.round(v.ms / v.n) };
  })
  .sort((a, b) => b.n - a.n);
const pack = {
  kind: 'hmharness-crowd-summary',
  version: 1,
  fingerprint: base,
  generatedAt: `pack-${new Date().toISOString()}`,
  trajectoryCount: summaries.reduce((s, x) => s + x.trajectoryCount, 0),
  stats,
};
const dest = outFile ?? `crowd-pack-${base.os}-${base.arch}.json`;
fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(pack, null, 1) + '\n', 'utf8');
console.error(`pack written → ${dest}: ${stats.length} action stats from ${summaries.length} summaries (${pack.trajectoryCount} trajectories, class ${base.os}/${base.arch})`);
