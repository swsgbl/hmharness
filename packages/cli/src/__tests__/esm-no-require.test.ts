/**
 * Every package here is ESM ("type": "module"), where `require` does not exist.
 * A bare `require('node:…')` in a .ts file therefore throws ReferenceError at
 * RUNTIME only - the compiler is fine with it, and under a `try { … } catch {}`
 * it dies silently. It bit three times in packages/cli by 0.23.53: the
 * evolution daemon never closed its log fd and never removed its pid file, and
 * `hmh reward train-prep <dir>` crashed outright. This parse-level check (not a
 * grep: the evolution runner is a CJS template literal that legitimately
 * contains `require`) keeps the fourth one out of a release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** <repo>/packages/cli/src/__tests__/ -> <repo>/ */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') sources(p, out);
    } else if (/\.(ts|mts)$/.test(name) && !/\.(v2bak|opsbak)/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

/** Line numbers of bare `require(...)` CALLS in a TypeScript file (template text is not code). */
function bareRequires(file: string): number[] {
  const text = readFileSync(file, 'utf8');
  if (!/\brequire\s*\(/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

test('no bare require() call in any ESM source file (it throws ReferenceError at runtime, and a swallow-catch hides it)', () => {
  const packagesDir = join(REPO, 'packages');
  const offenders: string[] = [];
  let scanned = 0;
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const file of sources(src)) {
      scanned++;
      for (const line of bareRequires(file)) offenders.push(`${file}:${line}`);
    }
  }
  assert.ok(scanned > 100, `the scan really ran over the tree (saw ${scanned} files)`);
  assert.deepEqual(offenders, []);
});

test('the check itself catches a bare require (a guard that cannot fail protects nothing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmh-req-'));
  try {
    const bad = join(dir, 'bad.ts');
    writeFileSync(bad, [
      "import { join } from 'node:path';",
      "try {",
      "  const x = require('node:path').resolve('a');",
      '  void x;',
      '} catch { /* swallowed in production */ }',
      'export { join };',
    ].join('\n'), 'utf8');
    assert.deepEqual(bareRequires(bad), [3], 'the call is reported with its line - even inside a swallow-catch');

    const good = join(dir, 'good.ts');
    writeFileSync(good, [
      "import { createRequire } from 'node:module';",
      'const cr = createRequire(import.meta.url);',
      "export const runner = `const fs = require('node:fs')`;",
      "export const v = cr('../package.json');",
      'export const w = require.length;',
    ].join('\n'), 'utf8');
    assert.deepEqual(bareRequires(good), [], 'createRequire, a require inside a template literal and the bare identifier are all fine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
