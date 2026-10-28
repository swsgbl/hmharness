/**
 * sanitize tests — the export pipeline's publish-hook fix. The username is
 * parameterized everywhere (a fake one here); the REAL one must never appear
 * in any pushed source file, these tests included.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeText, sanitizeBuffer, isProbablyText, containsUsername,
  sanitizeTree, sanitizeFileTo, sanitizedFileName, PLACEHOLDER,
} from '../sanitize.ts';

const NAME = 'testpersona'; // fake, never a real account

test('sanitizeText: covers every path spelling + bare mention', () => {
  const cases = [
    [`Read C:\\Users\\${NAME}\\x.txt`, `Read C:\\Users\\${PLACEHOLDER}\\x.txt`],
    [`Read C:/Users/${NAME}/x.txt`, `Read C:/Users/${PLACEHOLDER}/x.txt`],
    [`JSON: "source": "C:\\\\Users\\\\${NAME}\\\\.hmharness/bench"`, `JSON: "source": "C:\\\\Users\\\\${PLACEHOLDER}\\\\.hmharness/bench"`],
    [`owned by ${NAME} today`, `owned by ${PLACEHOLDER} today`],
    [`mixed case ${NAME.toUpperCase()} and ${NAME[0]!.toUpperCase()}${NAME.slice(1)}`, `mixed case ${PLACEHOLDER} and ${PLACEHOLDER}`],
  ] as const;
  for (const [input, want] of cases) assert.equal(sanitizeText(input, NAME), want);
});

test('sanitizeText: idempotent on already-sanitized text', () => {
  const once = sanitizeText(`path C:\\Users\\${NAME}\\a`, NAME);
  assert.equal(sanitizeText(once, NAME), once);
});

test('sanitizeText: refuses too-short names (no accidental nuking)', () => {
  assert.equal(sanitizeText('abracadabra', 'a'), 'abracadabra');
  assert.equal(sanitizeText('abracadabra', ''), 'abracadabra');
});

test('isProbablyText: text vs binary', () => {
  assert.equal(isProbablyText(Buffer.from('plain utf8 text\nwith lines\n')), true);
  assert.equal(isProbablyText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), false); // png-ish with NUL
  const ctrl = Buffer.alloc(100, 0x01);
  assert.equal(isProbablyText(ctrl), false);
});

test('sanitizeBuffer: binary passes through untouched', () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, ...(NAME.split('').map((c) => c.charCodeAt(0)))]);
  assert.equal(sanitizeBuffer(bin, NAME).equals(bin), true);
});

test('containsUsername: detects, case-insensitive, ignores binary', () => {
  assert.equal(containsUsername(Buffer.from(`x ${NAME} y`), NAME), true);
  assert.equal(containsUsername(Buffer.from(`x ${NAME.toUpperCase()} y`), NAME), true);
  assert.equal(containsUsername(Buffer.from('clean'), NAME), false);
  assert.equal(containsUsername(Buffer.from([0x00, ...Buffer.from(NAME)]), NAME), false);
});

test('sanitizeTree: recursive copy with in-flight replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'san-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.md'), `path C:\\Users\\${NAME}\\ok`);
  writeFileSync(join(root, 'sub', 'b.json'), JSON.stringify({ src: `C:/Users/${NAME}/z` }));
  writeFileSync(join(root, 'sub', 'bin'), Buffer.from([0x00, 0x01, 0x02]));
  const res = sanitizeTree(root, join(root, '..', 'san-out'), NAME);
  assert.equal(res.filesScanned, 3);
  assert.equal(res.filesReplaced, 2);
  assert.equal(res.binaryCopied, 1);
  assert.equal(readFileSync(join(root, '..', 'san-out', 'a.md'), 'utf8'), `path C:\\Users\\${PLACEHOLDER}\\ok`);
  const j = JSON.parse(readFileSync(join(root, '..', 'san-out', 'sub', 'b.json'), 'utf8'));
  assert.equal(j.src, `C:/Users/${PLACEHOLDER}/z`);
  assert.deepEqual([...readFileSync(join(root, '..', 'san-out', 'sub', 'bin'))], [0x00, 0x01, 0x02]);
});

test('sanitizeFileTo + sanitizedFileName: sidecar naming', () => {
  const root = mkdtempSync(join(tmpdir(), 'san2-'));
  const src = join(root, 'manifest.json');
  writeFileSync(src, JSON.stringify({ source: `C:\\Users\\${NAME}\\bench` }));
  const dst = join(root, sanitizedFileName('manifest.json'));
  const { replaced } = sanitizeFileTo(src, dst, NAME);
  assert.equal(replaced, true);
  assert.equal(dst.endsWith('manifest.sanitized.json'), true);
  assert.equal(JSON.parse(readFileSync(dst, 'utf8')).source, `C:\\Users\\${PLACEHOLDER}\\bench`);
});
