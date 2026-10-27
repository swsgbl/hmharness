'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { eventTimeOf, auditEvidenceRoot, writeManifests, INTEGRITY_FAILURES } = require('../audit-evidence-provenance.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-evidence-'));
  return {
    root,
    write(dir, file, rows) {
      const p = path.join(root, dir, 'raw', file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, rows.join('\n') + '\n');
      return p;
    },
    writeText(dir, file, text) {
      const p = path.join(root, dir, file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
// deterministic provenance injection - tests never shell out to git
const prov = (exportedAtUtc) => () => ({
  exportedAtUtc, exportedAtSource: 'test', sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceCommitSource: 'test', firstCommittedAtUtc: '2026-09-24T18:38:47.000Z',
});
const audit = (root, now, exportedAtUtc) => auditEvidenceRoot(root, { now: new Date(now), resolveProvenance: prov(exportedAtUtc) });

test('recognizes ISO, epoch and at-key event times only', () => {
  assert.equal(eventTimeOf({ time: '2026-10-12T11:30:00Z' }), '2026-10-12T11:30:00.000Z');
  assert.equal(eventTimeOf({ timestamp: 1791804600 }), new Date(1791804600 * 1000).toISOString());
  // pareto-entries.jsonl rejection records carry their time under 'at'
  assert.equal(eventTimeOf({ at: '2026-09-15T09:27:45.461Z' }), '2026-09-15T09:27:45.461Z');
  assert.equal(eventTimeOf({ at: 'not a date' }), null);
  assert.equal(eventTimeOf({ label: '2026-10-12' }), null);
});

test('current-month snapshot stays OK with reproducible hash and time range', () => {
  const f = fixture();
  try {
    const file = f.write('evidence-ds-2026-10', 'log.jsonl',
      [JSON.stringify({ time: '2026-09-29T23:00:00Z' }), JSON.stringify({ time: '2026-10-01T00:01:00Z' })]);
    const r = audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0];
    assert.equal(r.status, 'OK');
    assert.equal(r.freshness, 'CURRENT');
    assert.equal(r.eventRange.recordsWithEventTime, 2);
    assert.equal(r.files[0].sha256.length, 64);
    assert.equal(r.periodStart, '2026-09-29T23:00:00.000Z');
    assert.equal(r.periodEnd, '2026-10-01T00:01:00.000Z');
    assert.equal(r.files[0].path, path.relative(f.root, file).split(path.sep).join('/'));
    assert.equal(r.sourceCommit, '0123456789abcdef0123456789abcdef01234567');
  } finally { f.cleanup(); }
});

test('missing raw files are explicit', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'evidence-ds-2026-08'), { recursive: true });
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-08-05T00:00:00Z').datasets[0].status, 'NO_RAW_JSONL');
  } finally { f.cleanup(); }
});

test('malformed JSONL does not become zeroes', () => {
  const f = fixture();
  try {
    f.write('evidence-ds-2026-10', 'bad.jsonl', ['{bad json']);
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'MALFORMED_JSONL');
  } finally { f.cleanup(); }
});

test('records without timestamps report absent, not zero', () => {
  const f = fixture();
  try {
    f.write('evidence-ds-2026-10', 'no-time.jsonl', [JSON.stringify({ description: 'no date' })]);
    const d = audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0];
    assert.equal(d.status, 'NO_EVENT_TIMESTAMPS');
    assert.equal(d.eventRange.max, null);
  } finally { f.cleanup(); }
});

test('events beyond the labelled month are cross-period data', () => {
  const f = fixture();
  try {
    // physically consistent (event < export time < audit clock) yet the
    // directory label contradicts its content
    f.write('evidence-ds-2026-09', 'log.jsonl', [JSON.stringify({ occurredAt: '2026-10-02T10:00:00Z' })]);
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'CROSS_PERIOD_DATA');
  } finally { f.cleanup(); }
});

test('events after the audit clock are future-dated', () => {
  const f = fixture();
  try {
    f.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-12-01T00:00:00Z' })]);
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-12-05T00:00:00Z').datasets[0].status, 'FUTURE_DATED');
  } finally { f.cleanup(); }
});

test('events after the export time are backfilled', () => {
  const f = fixture();
  try {
    // exported 10-05 but carries a 10-20 event: data changed after export
    f.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-10-20T00:00:00Z' })]);
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'BACKFILLED');
  } finally { f.cleanup(); }
});

test('snapshot exported before its label month is PRELABELLED, not stale-failed', () => {
  // reproduces the real repo layout: ds-2026-11 was exported 2026-09-15
  // with data ending 2026-09-15 - the old --strict wrongly demanded that
  // the latest event month equal the directory label and failed the branch
  const f = fixture();
  try {
    f.write('evidence-ds-2026-11', 'log.jsonl', [JSON.stringify({ time: '2026-09-15T09:26:28.528Z' })]);
    const d = audit(f.root, '2026-10-27T00:00:00Z', '2026-09-15T16:17:33.677Z').datasets[0];
    assert.equal(d.status, 'OK');
    assert.equal(d.freshness, 'PRELABELLED');
    assert.equal(d.periodEnd, '2026-09-15T09:26:28.528Z');
    assert.ok(!INTEGRITY_FAILURES.has(d.status));
  } finally { f.cleanup(); }
});

test('elapsed label month without its events is STALE', () => {
  const f = fixture();
  try {
    // exported inside the label month, observation ends in August; by
    // 2026-10-27 the 2026-09 month is over with no September events
    f.write('evidence-ds-2026-09', 'log.jsonl', [JSON.stringify({ time: '2026-08-30T10:00:00Z' })]);
    const d = audit(f.root, '2026-10-27T00:00:00Z', '2026-09-01T10:00:00Z').datasets[0];
    assert.equal(d.status, 'OK');
    assert.equal(d.freshness, 'STALE');
  } finally { f.cleanup(); }
});

test('byte-identical re-export is NO_NEW_DATA', () => {
  const f = fixture();
  try {
    const rows = [JSON.stringify({ time: '2026-08-30T10:00:00Z' })];
    f.write('evidence-ds-2026-09', 'log.jsonl', rows);
    f.write('evidence-ds-2026-10', 'log.jsonl', rows);
    const ds = audit(f.root, '2026-12-01T00:00:00Z', '2026-10-05T00:00:00Z').datasets;
    assert.equal(ds[0].freshness, 'STALE');            // first snapshot, no predecessor
    assert.equal(ds[1].freshness, 'NO_NEW_DATA');      // identical bytes to ds-2026-09
    assert.equal(ds[1].status, 'OK');                  // honesty, not an integrity failure
  } finally { f.cleanup(); }
});

test('open label month without its events is NEEDS-DATA', () => {
  const f = fixture();
  try {
    f.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-09-15T10:00:00Z' })]);
    const d = audit(f.root, '2026-10-15T00:00:00Z', '2026-10-03T00:00:00Z').datasets[0];
    assert.equal(d.status, 'OK');
    assert.equal(d.freshness, 'NEEDS-DATA');
  } finally { f.cleanup(); }
});

test('--write pins hashes; re-audit verifies them and flags drift', () => {
  const f = fixture();
  try {
    const file = f.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-10-01T00:00:00Z' })]);
    const first = audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z');
    writeManifests(first);
    const again = audit(f.root, '2026-10-28T00:00:00Z', '2026-10-05T00:00:00Z');
    assert.equal(again.datasets[0].status, 'OK');
    assert.equal(again.datasets[0].manifestPresent, true);
    // tamper with the pinned raw file (pre-export event, so only the hash
    // check can catch it - BACKFILLED has its own dedicated test)
    fs.appendFileSync(file, JSON.stringify({ time: '2026-10-03T00:00:00Z' }) + '\n');
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'HASH_MISMATCH');
    // restore the pinned bytes; a diverging export-time attestation under an
    // unchanged manifest is then the only remaining discrepancy
    fs.writeFileSync(file, JSON.stringify({ time: '2026-10-01T00:00:00Z' }) + '\n');
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-04T00:00:00Z').datasets[0].status, 'MANIFEST_INVALID');
  } finally { f.cleanup(); }
});

test('manifest corruption is explicit', () => {
  const f = fixture();
  try {
    f.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-10-01T00:00:00Z' })]);
    f.writeText('evidence-ds-2026-10', 'provenance-manifest.json', '{oops');
    assert.equal(audit(f.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'MANIFEST_INVALID');
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-10-01T00:00:00Z' })]);
    g.writeText('evidence-ds-2026-10', 'provenance-manifest.json', JSON.stringify({ schemaVersion: 99 }));
    assert.equal(audit(g.root, '2026-10-27T00:00:00Z', '2026-10-05T00:00:00Z').datasets[0].status, 'MANIFEST_INVALID');
  } finally { g.cleanup(); }
});

test('CLI --strict fails on integrity only (end-to-end)', () => {
  const script = path.join(__dirname, '..', 'audit-evidence-provenance.cjs');
  const f = fixture();
  try {
    // honest-but-prelabelled snapshot: strict must pass (old semantics failed here)
    f.write('evidence-ds-2026-11', 'log.jsonl', [JSON.stringify({ time: '2026-09-15T09:26:28.528Z' })]);
    execFileSync(process.execPath, [script, f.root, '--strict'], { stdio: 'ignore' });
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.write('evidence-ds-2026-10', 'log.jsonl', [JSON.stringify({ time: '2026-12-01T00:00:00Z' })]);
    let code = 0;
    try { execFileSync(process.execPath, [script, g.root, '--strict'], { stdio: 'ignore' }); }
    catch (e) { code = e.status; }
    assert.equal(code, 1);
  } finally { g.cleanup(); }
});
