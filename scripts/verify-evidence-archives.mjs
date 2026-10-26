#!/usr/bin/env node
/**
 * Verify frozen self-evolution evidence snapshots.
 *
 * The manifest records Git blob SHA-1 values (not plain-file SHA-1), which are
 * stable object identifiers GitHub already exposes. This checks provenance and
 * integrity; it does not establish that a claimed causal effect is true.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['2026-09', '2026-10', '2026-11'];
const errors = [];
const checks = [];

function fail(where, message) { errors.push(`FAIL ${where}: ${message}`); }
function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}
function nonblankLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}
function readJsonl(path, where) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  const lines = nonblankLines(text);
  for (let i = 0; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      fail(where, `invalid JSONL at nonblank line ${i + 1}: ${String(err)}`);
    }
  }
  return rows;
}
function timestamps(rows) {
  return rows.map((row) => row?.time ?? row?.timestamp ?? row?.createdAt ?? row?.updatedAt ?? row?.decidedAt ?? row?.at ?? row?.date)
    .filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    .sort();
}

for (const month of IDS) {
  const dir = `website/evidence-ds-${month}`;
  const manifestPath = resolve(ROOT, dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(dir, `manifest unreadable: ${String(err)}`);
    continue;
  }
  if (manifest.schemaVersion !== 1) fail(dir, 'unsupported schemaVersion');
  if (manifest.snapshotId !== `evidence-ds-${month}`) fail(dir, 'snapshotId does not match directory');
  if (manifest.directoryMonth !== month) fail(dir, 'directoryMonth does not match directory');

  const archive = month !== '2026-09';
  if (archive && manifest.status !== 'historical-archive-copy') fail(dir, 'October/November snapshots must be marked historical-archive-copy');
  if (!archive && manifest.status !== 'historical-snapshot') fail(dir, 'September snapshot must be marked historical-snapshot');

  const expectedFiles = ['index.html', 'raw/log.jsonl', 'raw/insights.jsonl', 'raw/pareto-entries.jsonl'];
  for (const rel of expectedFiles) {
    const expected = manifest.files?.[rel];
    if (!expected) {
      fail(dir, `manifest missing ${rel}`);
      continue;
    }
    const abs = resolve(ROOT, dir, rel);
    let bytes;
    try { bytes = readFileSync(abs); } catch (err) { fail(rel, `file missing: ${String(err)}`); continue; }
    const actualSha = gitBlobSha1(bytes);
    if (actualSha !== expected.gitBlobSha1) fail(rel, `Git blob SHA-1 mismatch: expected ${expected.gitBlobSha1}, got ${actualSha}`);

    const text = bytes.toString('utf8');
    const lines = nonblankLines(text);
    if (lines.length !== expected.nonblankLines) fail(rel, `line count mismatch: expected ${expected.nonblankLines}, got ${lines.length}`);
    if (rel === 'index.html' && expected.requiredMarker && !text.includes(expected.requiredMarker)) {
      fail(rel, `required transparency marker absent: ${expected.requiredMarker}`);
    }

    if (rel.endsWith('.jsonl')) {
      const rows = readJsonl(abs, rel);
      const sortedTimes = timestamps(rows);
      if (expected.firstTime && sortedTimes[0] !== expected.firstTime) fail(rel, `first timestamp mismatch: expected ${expected.firstTime}, got ${sortedTimes[0] ?? 'absent'}`);
      if (expected.lastTime && sortedTimes.at(-1) !== expected.lastTime) fail(rel, `last timestamp mismatch: expected ${expected.lastTime}, got ${sortedTimes.at(-1) ?? 'absent'}`);
    }
    checks.push(`${dir}/${rel}`);
  }

  const generated = Date.parse(manifest.generatedAt ?? '');
  const dataEnd = Date.parse(manifest.dataWindow?.end ?? '');
  if (!Number.isFinite(generated) || !Number.isFinite(dataEnd)) fail(dir, 'invalid generatedAt/dataWindow timestamps');
  if (Number.isFinite(generated) && Number.isFinite(dataEnd) && generated < dataEnd) fail(dir, 'generatedAt precedes dataWindow.end');
  if (archive && Number.isFinite(generated) && new Date(generated).toISOString().slice(0, 7) === month) {
    fail(dir, 'archive status suspicious: generatedAt month matches the archive directory month');
  }
  if (archive && !String(manifest.provenance ?? '').includes('Do not cite this')) fail(dir, 'archive provenance must explicitly warn against citing this as current-month data');
  console.log(`SNAPSHOT ${month}: status=${manifest.status}, generatedAt=${manifest.generatedAt}, dataEnd=${manifest.dataWindow?.end}`);
}

if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(`Evidence archive verification FAILED: ${errors.length} issue(s), ${checks.length} file(s) inspected.`);
  process.exitCode = 1;
} else {
  console.log(`Evidence archive verification PASS: ${IDS.length} manifests, ${checks.length} frozen files. This is provenance/integrity validation, not a causal or AGI capability claim.`);
}
