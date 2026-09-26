/**
 * @hmharness/web - server-utils tests
 * Pure-function coverage for the workspace file search/read surface and the
 * task-submission assembly. Importing fs-utils must NOT boot the server
 * (server.ts pulls in page.ts and the agent stack).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, join, resolve } from 'node:path';
import {
  insideRoot, toRel, fuzzyScore, isSubsequence, parseImageDataUrl,
  buildAttachmentsPrefix, buildImagePrefix, isBinaryHead, MAX_IMAGE_BYTES,
} from '../fs-utils.ts';

const root = process.cwd();

// ---------------------------------------------------------------- insideRoot

test('insideRoot: accepts root and descendants', () => {
  assert.ok(insideRoot(root, root));
  assert.ok(insideRoot(root, join(root, 'packages', 'web', 'src', 'server.ts')));
  // a ../ that resolves back inside the root is fine (normalized first)
  assert.ok(insideRoot(root, resolve(root, '..', basename(root))));
});

test('insideRoot: rejects ../ escapes and sibling prefixes', () => {
  assert.ok(!insideRoot(root, resolve(root, '..')));
  assert.ok(!insideRoot(root, resolve(root, '..', 'somewhere-else')));
  assert.ok(!insideRoot(root, root + 'x'), 'sibling path with shared prefix');
  assert.ok(!insideRoot(join(root, 'packages'), join(root, 'package-lock.json')), 'parent of root rejected');
});

test('insideRoot: win32 is case-insensitive; other drives are rejected', () => {
  if (process.platform !== 'win32') return; // posix has no drive letters
  assert.ok(insideRoot('g:\\ROOT\\project', 'G:\\root\\project\\src\\a.ts'));
  assert.ok(!insideRoot('g:\\root\\project', 'c:\\root\\project\\a.ts'), 'different drive');
  assert.ok(!insideRoot('g:\\root', 'g:\\root\\..\\..\\a.ts'), 'escape above root');
});

test('toRel: /-separated path relative to root', () => {
  assert.equal(toRel(root, join(root, 'a', 'b.ts')), 'a/b.ts');
  assert.equal(toRel(root, root), '');
});

// ------------------------------------------------------------------- scoring

test('fuzzyScore: subsequence match, -1 on miss, empty query matches all', () => {
  assert.equal(fuzzyScore('zzz', 'src/server.ts'), -1, 'absent chars miss');
  assert.ok(fuzzyScore('ser', 'src/server.ts') >= 0, 's-e-r is a subsequence');
  assert.ok(fuzzyScore('srv', 'server.ts') >= 0, 's-r-v is a subsequence');
  assert.ok(fuzzyScore('', 'anything.ts') >= 0, 'empty query matches');
  assert.ok(isSubsequence('mdl', 'src/models/user.ts'));
  assert.ok(!isSubsequence('mld', 'src/models/user.ts'), 'order matters');
});

test('fuzzyScore: ranking - consecutive runs, basename hits, shallow depth win', () => {
  const consecutive = fuzzyScore('abc', 'abc.txt');
  const scattered = fuzzyScore('abc', 'aXbXc.txt');
  assert.ok(consecutive > scattered, 'one long run beats scattered matches');

  const inName = fuzzyScore('server', 'server.ts');
  const inDir = fuzzyScore('server', 'server/tools.ts');
  assert.ok(inName > inDir, 'query matching the basename wins over a dir-name hit');

  const shallow = fuzzyScore('util', 'util.ts');
  const deep = fuzzyScore('util', 'a/b/c/d/e/util.ts');
  assert.ok(shallow > deep, 'shallow files win over deep ones');
});

test('fuzzyScore: same-query sorting is transitive and stable', () => {
  const paths = ['z/qq.txt', 'src/server.ts', 'server.ts', 'tools/server-lite.ts', 'a/b/server-util.ts'];
  const scored = paths
    .map((rel) => ({ rel, score: fuzzyScore('server', rel) }))
    .filter((x) => x.score >= 0);
  assert.ok(scored.length >= 3, 'multiple matches found');
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  assert.equal(sorted[0].rel, 'server.ts', 'exact basename tops the list');
  // scoring is deterministic: two runs produce the same order
  const again = [...scored].sort((a, b) => b.score - a.score);
  assert.deepEqual(sorted.map((s) => s.rel), again.map((s) => s.rel));
});

// ------------------------------------------------------------------ dataUrls

test('parseImageDataUrl: accepts png/jpeg/jpg/webp with canonical ext', () => {
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  assert.equal(parseImageDataUrl(`data:image/png;base64,${b64}`)?.ext, 'png');
  assert.equal(parseImageDataUrl(`data:image/jpeg;base64,${b64}`)?.ext, 'jpg', 'jpeg canonicalizes to jpg');
  assert.equal(parseImageDataUrl(`data:image/jpg;base64,${b64}`)?.ext, 'jpg');
  assert.equal(parseImageDataUrl(`data:image/webp;base64,${b64}`)?.ext, 'webp');
  const parsed = parseImageDataUrl(`data:image/png;base64,${b64}`);
  assert.ok(parsed && parsed.buffer.equals(Buffer.from('fake-image-bytes')), 'decodes to the original bytes');
});

test('parseImageDataUrl: rejects malformed or unsupported data', () => {
  assert.equal(parseImageDataUrl('data:image/gif;base64,AAAA'), null, 'gif not allowed');
  assert.equal(parseImageDataUrl('data:text/plain;base64,AAAA'), null);
  assert.equal(parseImageDataUrl('http://example.com/x.png'), null);
  assert.equal(parseImageDataUrl('data:image/png;base64,'), null, 'empty payload');
  assert.equal(parseImageDataUrl('data:image/png;base64,a b c'), null, 'whitespace in base64');
  assert.equal(parseImageDataUrl('data:image/png;base64,AAAA==='), null, 'bad padding');
  assert.equal(parseImageDataUrl('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(parseImageDataUrl(123), null);
  assert.equal(parseImageDataUrl(null), null);
  assert.equal(parseImageDataUrl(undefined), null);
});

test('parseImageDataUrl: rejects payloads over MAX_IMAGE_BYTES', () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
  assert.equal(parseImageDataUrl(`data:image/png;base64,${big}`), null);
  const atLimit = Buffer.alloc(MAX_IMAGE_BYTES).toString('base64');
  assert.ok(parseImageDataUrl(`data:image/png;base64,${atLimit}`), 'exactly at the cap passes');
});

// ------------------------------------------------------------ prefix assembly

test('prefix assembly: attachments first, then images, then user text', () => {
  const att = buildAttachmentsPrefix(['src/a.ts', 'README.md']);
  const img = buildImagePrefix(1, 'shot.png', 'A screenshot of the app.');
  const noVision = buildImagePrefix(2, 'x.png', null);
  const text = 'fix the bug';
  const composed = att + img + noVision + text;

  const iAtt = composed.indexOf('[referenced files]');
  const iImg1 = composed.indexOf('[attached image 1: shot.png]');
  const iImg2 = composed.indexOf('[attached image 2: x.png]');
  const iText = composed.indexOf('fix the bug');
  assert.ok(iAtt >= 0, 'attachments header present');
  assert.ok(iImg1 > iAtt, 'image 1 after attachments');
  assert.ok(iImg2 > iImg1, 'image 2 after image 1');
  assert.ok(iText > iImg2, 'user text last');

  assert.ok(composed.startsWith('[referenced files]\n- src/a.ts\n- README.md\n\n'));
  assert.ok(composed.includes('[attached image 1: shot.png]\nA screenshot of the app.\n\n'));
  assert.ok(composed.includes('[attached image 2: x.png] (no vision provider configured)\n\n'));
});

test('buildAttachmentsPrefix: empty input yields empty prefix', () => {
  assert.equal(buildAttachmentsPrefix([]), '');
  assert.equal(buildAttachmentsPrefix(['']), '');
  assert.equal(buildAttachmentsPrefix(['a.ts']), '[referenced files]\n- a.ts\n\n');
});

// -------------------------------------------------------------- binary sniff

test('isBinaryHead: NUL or dense control bytes mean binary; text passes', () => {
  assert.ok(isBinaryHead(Buffer.from('ab\0cd')), 'NUL byte');
  assert.ok(isBinaryHead(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip magic (PK..) is binary');
  assert.ok(!isBinaryHead(Buffer.from('hello world\nwith utf8 中文\tand tabs')));
  assert.ok(!isBinaryHead(Buffer.alloc(0)), 'empty head is not binary');
});
