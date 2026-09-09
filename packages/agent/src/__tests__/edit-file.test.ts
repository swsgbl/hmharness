import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../tools.ts';

const ctx = { cwd: '.', home: '/tmp/x' };

test('edit_file: unique match succeeds, file content updated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-edit-'));
  try {
    const p = join(dir, 'code.ts');
    await writeFile(p, 'const x = 1;\nconst y = 2;\n', 'utf8');
    const r = await editFileTool.execute({ path: p, old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx);
    assert.equal(r.isError, undefined, 'no error');
    assert.match(r.output, /edited/);
    const out = await readFile(p, 'utf8');
    assert.ok(out.includes('const x = 42;'));
    assert.ok(out.includes('const y = 2;'), 'other lines preserved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('edit_file: non-unique match is refused with both offsets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-edit-'));
  try {
    const p = join(dir, 'dup.ts');
    await writeFile(p, 'foo()\nfoo()\n', 'utf8');
    const r = await editFileTool.execute({ path: p, old_string: 'foo()', new_string: 'bar()' }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.output, /not unique/);
    assert.match(r.output, /offset/);
    // file unchanged
    assert.equal(await readFile(p, 'utf8'), 'foo()\nfoo()\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('edit_file: old_string not found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-edit-'));
  try {
    const p = join(dir, 'no.ts');
    await writeFile(p, 'hello world\n', 'utf8');
    const r = await editFileTool.execute({ path: p, old_string: 'DOES_NOT_EXIST', new_string: 'x' }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.output, /not found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('edit_file: identical old and new is refused', async () => {
  const r = await editFileTool.execute({ path: 'x', old_string: 'a', new_string: 'a' }, { cwd: '.', home: '/tmp' });
  assert.equal(r.isError, true);
  assert.match(r.output, /identical/);
});

test('edit_file: empty old_string is refused', async () => {
  const r = await editFileTool.execute({ path: 'x', old_string: '', new_string: 'b' }, { cwd: '.', home: '/tmp' });
  assert.equal(r.isError, true);
  assert.match(r.output, /empty/);
});
