#!/usr/bin/env node
/**
 * Verify frozen self-evolution evidence snapshots.
 * SHA values are Git blob SHA-1 identifiers, not plain-file digests.
 * This guards provenance/integrity; it does not establish a causal claim.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MONTHS = ['2026-09', '2026-10', '2026-11'];
const failures = [];
let inspected = 0;
function fail(where, reason) { failures.push(`FAIL ${where}: ${reason}`); }
function gitBlobSha1(bytes) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}
function lines(text) { return text.split(/\r?\n/).filter((x) => x.trim().length > 0); }
function parseJsonl(text, where) {
  const parsed = [];
  for (const [index, line] of lines(text).entries()) {
    try { parsed.push(JSON.parse(line)); }
    catch (err) { fail(where, `invalid JSON on nonblank line ${index + 1}: ${String(err)}`); }
  }
  return parsed;
}
function times(records) {
  return records.map((row) => row?.time ?? row?.timestamp ?? row?.createdAt ?? row?.updatedAt ?? row?.decidedAt ?? row?.at ?? row?.date)
    .filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    .sort();
}

for (const month of MONTHS) {
  const dir = `website/evidence-ds-${month}`;
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(ROOT, dir, 'manifest.json'), 'utf8')); }
  catch (err) { fail(dir, `manifest missing/invalid: ${String(err)}`); continue; }
  if (manifest.schemaVersion !== 1) fail(dir, 'unsupported schemaVersion');
  if (manifest.snapshotId !== dir.split('/').at(-1)) fail(dir, 'snapshotId does not match folder');
  if (manifest.directoryMonth !== month) fail(dir, 'directoryMonth does not match folder');

  const isArchiveCopy = month === '2026-10' || month === '2026-11';
  if (isArchiveCopy && manifest.status !== 'historical-archive-copy') fail(dir, 'future-month folder must be explicitly labeled historical-archive-copy');
  if (month === '2026-09' && manifest.status !== 'historical-snapshot') fail(dir, 'September folder must be labeled historical-snapshot');

  const generatedAt = Date.parse(manifest.generatedAt ?? '');
  const windowEnd = Date.parse(manifest.dataWindow?.end ?? '');
  if (!Number.isFinite(generatedAt) || !Number.isFinite(windowEnd)) fail(dir, 'invalid generatedAt/dataWindow.end');
  if (Number.isFinite(generatedAt) && Number.isFinite(windowEnd) && generatedAt < windowEnd) fail(dir, 'generatedAt precedes dataWindow.end');
  if (isArchiveCopy && !String(manifest.provenance ?? '').includes('Do not cite this')) fail(dir, 'archive disclosure must say not to cite as current-month data');

  for (const rel of ['index.html', 'raw/log.jsonl', 'raw/insights.jsonl', 'raw/pareto-entries.jsonl']) {
    const entry = manifest.files?.[rel];
    if (!entry) { fail(dir, `manifest lacks ${rel}`); continue; }
    let bytes;
    try { bytes = readFileSync(resolve(ROOT, dir, rel)); }
    catch (err) { fail(`${dir}/${rel}`, `file missing: ${String(err)}`); continue; }
    inspected++;
    const actualHash = gitBlobSha1(bytes);
    if (actualHash !== entry.gitBlobSha1) fail(`${dir}/${rel}`, `Git blob SHA-1 mismatch (expected ${entry.gitBlobSha1}; actual ${actualHash})`);
    const text = bytes.toString('utf8');
    const rowLines = lines(text);
    if (rowLines.length !== entry.nonblankLines) fail(`${dir}/${rel}`, `nonblank line count expected ${entry.nonblankLines}, got ${rowLines.length}`);
    if (rel === 'index.html' && entry.requiredMarker && !text.includes(entry.requiredMarker)) fail(`${dir}/index.html`, `required disclosure missing: ${entry.requiredMarker}`);

    if (rel.endsWith('.jsonl')) {
      const parsed = parseJsonl(text, `${dir}/${rel}`);
      const ordered = times(parsed);
      if (entry.firstTime && ordered[0] !== entry.firstTime) fail(`${dir}/${rel}`, `first timestamp expected ${entry.firstTime}, got ${ordered[0] ?? 'absent'}`);
      if (entry.lastTime && ordered.at(-1) !== entry.lastTime) fail(`${dir}/${rel}`, `last timestamp expected ${entry.lastTime}, got ${ordered.at(-1) ?? 'absent'}`);
    }
  }
  console.log(`SNAPSHOT ${month}: ${manifest.status}; generatedAt=${manifest.generatedAt}; dataEnd=${manifest.dataWindow?.end}`);
}
if (failures.length) {
  failures.forEach((message) => console.error(message));
  console.error(`Evidence provenance gate FAIL: ${failures.length} issue(s), ${inspected} files inspected.`);
  process.exitCode = 1;
} else {
  console.log(`Evidence provenance gate PASS: ${MONTHS.length} manifests, ${inspected} files. Integrity/provenance only; not a causal or AGI claim.`);
}
