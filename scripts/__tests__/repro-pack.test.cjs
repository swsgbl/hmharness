'use strict';
/** Unit tests for the repro-pack machinery (audit 03 / P2-1).
 *  Fixtures are small fake data: these tests cover (a) the comparator's
 *  judgment semantics — volatile-field pruning, field-by-field deep diff,
 *  EOL-normalized text compare — and (b) manifest integrity — index build /
 *  verify roundtrip plus tamper / missing / unlisted detection.  They also
 *  gate the integrity of the packs committed under website/repro-packs/. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sha256Normalized, buildFileIndex, verifyFileIndex,
  deleteAtPath, deepDiff, compareJsonPair, compareTextPair,
} = require('../repro-pack-core.cjs');

function fixturePack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-repro-pack-'));
  const write = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ---------------- comparator: volatile pruning + deep diff ---------------- */

test('deleteAtPath prunes exact dotted paths at any depth', () => {
  const o = { a: { b: { generatedAt: 'x', keep: 1 } }, generatedAt: 'y', arr: [{ wallclockMs: 1 }, 2] };
  deleteAtPath(o, 'a.b.generatedAt');
  deleteAtPath(o, 'generatedAt');
  deleteAtPath(o, 'arr[0].wallclockMs'); // dotted-only grammar: array paths are not dotted — must NOT throw
  assert.equal(o.a.b.keep, 1);
  assert.equal(o.a.b.generatedAt, undefined);
  assert.equal(o.generatedAt, undefined);
});

test('deepDiff reports leaf changes with precise paths, in both directions', () => {
  const pub = { verdict: 'POSITIVE', families: [{ name: 't', rate: 0.5 }, { name: 'h', rate: 0.1 }], note: null };
  const same = JSON.parse(JSON.stringify(pub));
  assert.deepEqual(deepDiff(pub, same), []);
  const fresh = JSON.parse(JSON.stringify(pub));
  fresh.verdict = 'NEGATIVE';
  fresh.families[1].rate = 0.9;
  delete fresh.note;
  fresh.extra = 1;
  const paths = deepDiff(pub, fresh).map((d) => d.path).sort();
  assert.deepEqual(paths, ['$.extra', '$.families[1].rate', '$.note', '$.verdict']);
});

test('deepDiff type mismatches are single-leaf diffs, not traversal crashes', () => {
  const d = deepDiff({ x: { y: 1 } }, { x: [1, 2] });
  assert.equal(d.length, 1);
  assert.equal(d[0].path, '$.x');
});

test('compareJsonPair: IDENTICAL iff only volatile fields differ', () => {
  const pub = Buffer.from(JSON.stringify({ generatedAt: '2026-10-28T11:07:57Z', wallclockMs: 320, verdict: 'WEAK-POSITIVE' }));
  const freshSame = Buffer.from(JSON.stringify({ generatedAt: '2030-01-01T00:00:00Z', wallclockMs: 5, verdict: 'WEAK-POSITIVE' }));
  const r1 = compareJsonPair(freshSame, pub, ['generatedAt', 'wallclockMs']);
  assert.equal(r1.status, 'IDENTICAL');
  assert.deepEqual(r1.diffs, []);
  const freshDiff = Buffer.from(JSON.stringify({ generatedAt: '2030-01-01T00:00:00Z', wallclockMs: 5, verdict: 'POSITIVE' }));
  const r2 = compareJsonPair(freshDiff, pub, ['generatedAt', 'wallclockMs']);
  assert.equal(r2.status, 'DIFF');
  assert.deepEqual(r2.diffs.map((d) => d.path), ['$.verdict']);
  assert.equal(r2.diffs[0].expected, '"WEAK-POSITIVE"');
  assert.equal(r2.diffs[0].actual, '"POSITIVE"');
});

test('compareJsonPair: without pruning, timestamp drift is a real DIFF', () => {
  const pub = Buffer.from(JSON.stringify({ generatedAt: 'a' }));
  const fresh = Buffer.from(JSON.stringify({ generatedAt: 'b' }));
  assert.equal(compareJsonPair(fresh, pub, []).status, 'DIFF');
});

test('compareTextPair: EOL-normalized identity, real diffs surface with context', () => {
  const pub = Buffer.from('VERDICT: WEAK-POSITIVE\r\nsecondary: effective\r\n');
  const freshLf = Buffer.from('VERDICT: WEAK-POSITIVE\nsecondary: effective\n');
  assert.equal(compareTextPair(freshLf, pub).status, 'IDENTICAL');
  const freshDiff = Buffer.from('VERDICT: POSITIVE\nsecondary: effective\n');
  const r = compareTextPair(freshDiff, pub);
  assert.equal(r.status, 'DIFF');
  assert.match(r.diffs[0].expected, /WEAK-POSITIVE/);
  assert.match(r.diffs[0].actual, /POSITIVE/);
});

/* ---------------- manifest integrity: build/verify roundtrip ---------------- */

test('buildFileIndex + verifyFileIndex roundtrip on an unchanged tree', () => {
  const f = fixturePack();
  try {
    f.write('README.md', 'hello');
    f.write('scripts/a.mts', 'export {}');
    f.write('hmh-home/cognitive/trajectories/corpus.jsonl', '{"id":1}\n{"id":2}\n');
    const idx = buildFileIndex(f.root, { skip: ['README.md'] });
    assert.deepEqual(idx.map((e) => e.path), ['hmh-home/cognitive/trajectories/corpus.jsonl', 'scripts/a.mts']);
    const v = verifyFileIndex(f.root, idx, { skip: ['README.md'] });
    assert.equal(v.ok, true, JSON.stringify(v.problems));
  } finally { f.cleanup(); }
});

test('verifyFileIndex catches modified / missing / unlisted files', () => {
  const f = fixturePack();
  try {
    f.write('a.json', '{"v":1}');
    f.write('b/c.txt', 'line1\n');
    const idx = buildFileIndex(f.root);
    f.write('b/c.txt', 'line1 TAMPERED\n');           // modified
    f.write('a.json', '{"v":1,"x":2}');                // modified
    f.write('sneak.txt', 'not in index');              // unlisted
    let v = verifyFileIndex(f.root, idx, { skip: [] });
    assert.equal(v.ok, false);
    const sorted = [...v.problems].sort();
    assert.ok(sorted.some((p) => p.startsWith('modified: a.json')), sorted.join('|'));
    assert.ok(sorted.some((p) => p.startsWith('modified: b/c.txt')), sorted.join('|'));
    assert.ok(sorted.some((p) => p.startsWith('unlisted: sneak.txt')), sorted.join('|'));
    fs.rmSync(path.join(f.root, 'a.json'));
    v = verifyFileIndex(f.root, idx, { skip: [] });
    assert.ok(v.problems.some((p) => p.startsWith('missing: a.json')), v.problems.join('|'));
  } finally { f.cleanup(); }
});

test('sha256Normalized is EOL-insensitive (cross-checkout verifiable)', () => {
  const lf = Buffer.from('a\nb\n');
  const crlf = Buffer.from('a\r\nb\r\n');
  assert.equal(sha256Normalized(lf), sha256Normalized(crlf));
  assert.notEqual(sha256Normalized(lf), sha256Normalized(Buffer.from('a\nb\nc\n')));
});

test('verifyFileIndex: a CRLF re-checkout of the same content still verifies (regression: git archive/autocrlf)', () => {
  const f = fixturePack();
  try {
    f.write('data/corpus.jsonl', '{"id":1}\n{"id":2}\n');
    f.write('docs/rules.md', '# rules\nline2\n');
    const idx = buildFileIndex(f.root);
    // simulate what git archive / a Windows checkout does to LF text files
    for (const e of idx) {
      const p = path.join(f.root, e.path);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
    }
    const v = verifyFileIndex(f.root, idx);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    // but real content tampering under any EOL is still caught
    fs.writeFileSync(path.join(f.root, 'data/corpus.jsonl'), '{"id":1}\r\n{"id":3}\r\n');
    const v2 = verifyFileIndex(f.root, idx);
    assert.equal(v2.ok, false);
    assert.ok(v2.problems.some((p) => p.startsWith('modified: data/corpus.jsonl')), v2.problems.join('|'));
  } finally { f.cleanup(); }
});

/* ---------------- committed packs under website/repro-packs/ ---------------- */

const PUBLISHED_ROOT = path.join(__dirname, '..', '..', 'website', 'repro-packs');
const PUBLISHED_PACKS = ['skill-gen-p1-2-2026-10-28', 'three-arm-v2-2026-10-28'];

for (const id of PUBLISHED_PACKS) {
  test(`committed pack ${id}: manifest file index verifies on disk`, { skip: !fs.existsSync(path.join(PUBLISHED_ROOT, id)) ? 'pack not committed yet' : false }, () => {
    const packDir = path.join(PUBLISHED_ROOT, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'hmharness-repro-pack');
    assert.ok(Array.isArray(manifest.outputs) && manifest.outputs.length > 0, 'outputs listed');
    assert.ok(manifest.fileIndex.length > 0, 'file index present');
    const v = verifyFileIndex(packDir, manifest.fileIndex, {
      skip: ['manifest.json', ...manifest.outputs.map((o) => o.path), ...(manifest.extraOutputs ?? []).map((o) => o.path)],
    });
    assert.equal(v.ok, true, v.problems.join('\n'));
    // every published/ frozen copy the comparator diffs against must exist
    for (const o of manifest.outputs) {
      assert.ok(fs.existsSync(path.join(packDir, o.published)), `published copy missing: ${o.published}`);
    }
  });
}

test('packager recipe surface: known experiment ids are the audited pair', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'make-repro-pack.mts'), 'utf8');
  for (const id of PUBLISHED_PACKS) assert.ok(src.includes(`'${id}'`), `recipe for ${id} missing`);
  assert.ok(src.includes('RESULT: IDENTICAL'), 'self-test gate present');
  assert.ok(src.includes('SELF-TEST FAILED'), 'refusal path present');
});
