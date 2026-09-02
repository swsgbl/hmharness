import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPatchableFile, applyPatch } from '../patches.ts';

test('isPatchableFile: allows tool/domain sources, blocks kernel loop/config/security', () => {
  assert.ok(isPatchableFile('packages/agent/src/tools.ts'));
  assert.ok(isPatchableFile('packages/domain-harmony/src/devices.ts'));
  assert.ok(isPatchableFile('packages/evolution/src/skills.ts'));
  // blocked: kernel internals
  assert.ok(!isPatchableFile('packages/kernel/src/loop.ts'));
  assert.ok(!isPatchableFile('packages/kernel/src/provider.ts'));
  // blocked: config/security
  assert.ok(!isPatchableFile('packages/agent/src/config.ts'));
  assert.ok(!isPatchableFile('packages/kernel/src/mcp.ts'));
  // blocked: not a .ts source
  assert.ok(!isPatchableFile('packages/web/src/page.ts'.replace('.ts', '.html')));
  assert.ok(!isPatchableFile('README.md'));
  assert.ok(!isPatchableFile('packages/agent/dist/tools.js'));
});

test('applyPatch: find-and-replace works on a real file; refuses non-unique/malformed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-patch-'));
  const file = join(dir, 'packages/agent/src/test-tool.ts');
  const dir2 = join(file, '..');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir2, { recursive: true });
  await writeFile(file, 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n', 'utf8');

  const repoRoot = dir;
  // valid patch
  const ok = await applyPatch(repoRoot, {
    name: 'greet-uppercase',
    description: 'uppercase the greeting',
    file: 'packages/agent/src/test-tool.ts',
    find: 'return `hello ${name}`;',
    replace: 'return `HELLO ${name.toUpperCase()}`;',
    reason: 'test',
  });
  assert.equal(ok, 'applied');
  const after = await readFile(file, 'utf8');
  assert.ok(after.includes('HELLO'));

  // find-string not found
  const miss = await applyPatch(repoRoot, {
    name: 'nope', description: '', file: 'packages/agent/src/test-tool.ts',
    find: 'this string does not exist', replace: 'x', reason: '',
  });
  assert.ok(miss.startsWith('find-string not found'));

  // non-patchable file
  const blocked = await applyPatch(repoRoot, {
    name: 'evil', description: '', file: 'packages/kernel/src/loop.ts',
    find: 'x', replace: 'y', reason: '',
  });
  assert.ok(blocked.startsWith('refused'));

  await rm(dir, { recursive: true, force: true });
});
