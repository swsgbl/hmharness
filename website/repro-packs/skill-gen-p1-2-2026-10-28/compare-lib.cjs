/**
 * Repro-pack core (audit 03 / P2-1): the pure functions both sides share —
 * the packager freezes a pack with them, the generated pack's compare.mjs
 * vendors this file verbatim as compare-lib.cjs, and the unit tests
 * (scripts/__tests__/repro-pack.test.cjs) exercise them on small fixtures.
 *
 * Two responsibilities:
 *  - integrity: build/verify a sha256 file index over a pack directory.
 *    Hashes are computed over CRLF-normalized bytes so a pack stays
 *    verifiable on any checkout EOL policy (repo has autocrlf=true).
 *  - verdict comparison: field-by-field deep diff of a freshly reproduced
 *    artifact against the frozen published copy, with per-artifact volatile
 *    fields (timestamps / wallclock) pruned before comparison.
 */
'use strict';
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

/** Canonical text form: LF endings (the pack's hashing/compare basis). */
function normalizeText(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function sha256Normalized(buf) {
  return createHash('sha256').update(normalizeText(buf), 'utf8').digest('hex');
}

/** All files under root as repo-relative POSIX paths, sorted. */
function walkFiles(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(root, p, out);
    else out.push(relative(root, p).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * Freeze the content-addressable index of a pack: every file except the
 * skipped ones (pack manifest itself, analyzer outputs the reproducer
 * regenerates). `skip` matches exact paths, `skipPrefixes` directory prefixes.
 */
function buildFileIndex(root, opts = {}) {
  const skip = new Set(opts.skip ?? []);
  const prefixes = opts.skipPrefixes ?? [];
  const keep = (rel) => !skip.has(rel) && !prefixes.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/'));
  return walkFiles(root)
    .filter(keep)
    .map((rel) => {
      const buf = readFileSync(join(root, rel));
      return { path: rel, sha256: sha256Normalized(buf), bytes: buf.length };
    });
}

/** Verify a directory against its frozen index: missing / modified /
 *  unlisted files are all reported (never guessed away). Integrity basis is
 *  the CRLF-normalized sha256 ONLY — raw byte length legitimately differs
 *  across checkout EOL policies (autocrlf), so `bytes` stays informational. */
function verifyFileIndex(root, index, opts = {}) {
  const problems = [];
  const listed = new Map(index.map((e) => [e.path, e]));
  for (const e of index) {
    let buf;
    try {
      buf = readFileSync(join(root, e.path));
    } catch {
      problems.push(`missing: ${e.path}`);
      continue;
    }
    const h = sha256Normalized(buf);
    if (h !== e.sha256) problems.push(`modified: ${e.path} (index ${e.sha256.slice(0, 12)}…, on disk ${h.slice(0, 12)}…)`);
  }
  const skip = new Set([...(opts.skip ?? []), ...index.map((e) => e.path)]);
  for (const rel of walkFiles(root)) {
    if (skip.has(rel)) continue;
    if (!listed.has(rel)) problems.push(`unlisted: ${rel}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Delete a dotted path ('generatedAt', 'a.b.c') from a parsed object. */
function deleteAtPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur !== null && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function safeJson(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : (s.length > 160 ? s.slice(0, 160) + '…' : s);
}

/** Leaf-level deep diff; `a` is expected (published), `b` actual (fresh). */
function deepDiff(a, b, path = '$', out = []) {
  if (Object.is(a, b)) return out;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    out.push({ path, expected: safeJson(a), actual: safeJson(b) });
    return out;
  }
  if (ta === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ path: `${path}[${i}]`, expected: '<absent>', actual: safeJson(b[i]) });
      else if (i >= b.length) out.push({ path: `${path}[${i}]`, expected: safeJson(a[i]), actual: '<absent>' });
      else deepDiff(a[i], b[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, expected: '<absent>', actual: safeJson(b[k]) });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, expected: safeJson(a[k]), actual: '<absent>' });
      else deepDiff(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push({ path, expected: safeJson(a), actual: safeJson(b) });
  return out;
}

/** Compare a freshly generated JSON artifact against the frozen published
 *  copy. Volatile dotted paths are pruned from BOTH sides first. */
function compareJsonPair(freshBuf, publishedBuf, volatile = []) {
  const fresh = JSON.parse(normalizeText(freshBuf));
  const published = JSON.parse(normalizeText(publishedBuf));
  for (const v of volatile) {
    deleteAtPath(fresh, v);
    deleteAtPath(published, v);
  }
  const diffs = deepDiff(published, fresh);
  return { kind: 'json', status: diffs.length === 0 ? 'IDENTICAL' : 'DIFF', diffs, volatile };
}

/** Compare a text artifact with EOL normalization (cross-checkout safe). */
function compareTextPair(freshBuf, publishedBuf) {
  const a = normalizeText(publishedBuf);
  const b = normalizeText(freshBuf);
  if (a === b) return { kind: 'text', status: 'IDENTICAL', diffs: [], volatile: [] };
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = 60;
  return {
    kind: 'text',
    status: 'DIFF',
    diffs: [{
      path: '$<text>',
      expected: a.slice(Math.max(0, i - ctx), i + ctx).replace(/\n/g, '⏎'),
      actual: b.slice(Math.max(0, i - ctx), i + ctx).replace(/\n/g, '⏎'),
    }],
    volatile: [],
  };
}

module.exports = {
  normalizeText,
  sha256Normalized,
  walkFiles,
  buildFileIndex,
  verifyFileIndex,
  deleteAtPath,
  deepDiff,
  compareJsonPair,
  compareTextPair,
};
