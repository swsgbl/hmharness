import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-evidence-archives.mjs');

function gitBlobSha1(bytes) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hmh-evidence-fixture-'));
  const months = [
    { month: '2026-09', status: 'historical-snapshot', generatedAt: '2026-09-12T10:00:00.000Z', windowEnd: '2026-09-10T10:00:00.000Z', timestamp: '2026-09-10T10:00:00.000Z' },
    { month: '2026-10', status: 'historical-archive-copy', generatedAt: '2026-09-15T05:00:00.000Z', windowEnd: '2026-09-14T18:00:00.000Z', timestamp: '2026-09-14T18:00:00.000Z' },
    { month: '2026-11', status: 'historical-archive-copy', generatedAt: '2026-09-15T16:00:00.000Z', windowEnd: '2026-09-15T09:00:00.000Z', timestamp: '2026-09-15T09:00:00.000Z' },
  ];
  for (const snapshot of months) {
    const base = join(root, `website/evidence-ds-${snapshot.month}`);
    mkdirSync(join(base, 'raw'), { recursive: true });
    const archiveMarker = snapshot.status === 'historical-archive-copy'
      ? '<p>历史归档副本（非当月新数据）</p>\n'
      : '';
    const files = {
      'index.html': `<!doctype html>\n<h1>Evidence</h1>\n${archiveMarker}`,
      'raw/log.jsonl': JSON.stringify({ time: snapshot.timestamp, event: 'trajectory' }) + '\n',
      'raw/insights.jsonl': JSON.stringify({ time: snapshot.timestamp, event: 'insight' }) + '\n',
      'raw/pareto-entries.jsonl': JSON.stringify({ time: snapshot.timestamp, event: 'pareto' }) + '\n',
    };
    const entries = {};
    for (const [rel, content] of Object.entries(files)) {
      const bytes = Buffer.from(content, 'utf8');
      writeFileSync(join(base, rel), bytes);
      entries[rel] = {
        gitBlobSha1: gitBlobSha1(bytes),
        nonblankLines: content.split(/\r?\n/).filter((line) => line.trim()).length,
      };
      if (rel.endsWith('.jsonl')) {
        entries[rel].firstTime = snapshot.timestamp;
        entries[rel].lastTime = snapshot.timestamp;
      }
      if (rel === 'index.html' && snapshot.status === 'historical-archive-copy') {
        entries[rel].requiredMarker = '历史归档副本（非当月新数据）';
      }
    }
    writeFileSync(join(base, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      snapshotId: `evidence-ds-${snapshot.month}`,
      status: snapshot.status,
      directoryMonth: snapshot.month,
      generatedAt: snapshot.generatedAt,
      dataWindow: { start: '2026-09-01T00:00:00.000Z', end: snapshot.windowEnd },
      provenance: snapshot.status === 'historical-archive-copy'
        ? 'Historical archive. Do not cite this as current-month data.'
        : 'Frozen historical snapshot.',
      files: entries,
    }, null, 2));
  }
  return root;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HMH_EVIDENCE_ROOT: root },
  });
}

test('accepts a valid three-snapshot fixture', (t) => {
  const root = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runVerifier(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Evidence provenance gate PASS/);
});

test('rejects changed raw bytes even if JSON remains parseable', (t) => {
  const root = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'website/evidence-ds-2026-10/raw/log.jsonl');
  writeFileSync(target, JSON.stringify({ time: '2026-09-14T18:00:00.000Z', event: 'tampered' }) + '\n');
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git blob SHA-1 mismatch/);
});

test('rejects an archive page whose disclosure marker was removed', (t) => {
  const root = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'website/evidence-ds-2026-10');
  const indexPath = join(base, 'index.html');
  const withoutMarker = '<!doctype html>\n<h1>Evidence</h1>\n';
  writeFileSync(indexPath, withoutMarker);
  const manifestPath = join(base, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = Buffer.from(withoutMarker, 'utf8');
  manifest.files['index.html'].gitBlobSha1 = gitBlobSha1(bytes);
  manifest.files['index.html'].nonblankLines = 2;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required disclosure missing/);
});

test('rejects malformed JSONL even with an updated file hash', (t) => {
  const root = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'website/evidence-ds-2026-11');
  const path = join(base, 'raw/log.jsonl');
  const malformed = '{not-json}\n';
  writeFileSync(path, malformed);
  const manifestPath = join(base, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = Buffer.from(malformed, 'utf8');
  manifest.files['raw/log.jsonl'].gitBlobSha1 = gitBlobSha1(bytes);
  manifest.files['raw/log.jsonl'].nonblankLines = 1;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const result = runVerifier(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid JSON/);
});
