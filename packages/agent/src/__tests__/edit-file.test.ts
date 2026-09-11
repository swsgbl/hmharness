import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../tools.ts';

const ctx = { cwd: '.', home: '/tmp/x' };

test('edit_file approval gate: workspace-write tiers (audit fix)', async () => {
  const gate = editFileTool.needsApproval!;
  const ws = await mkdtemp(join(tmpdir(), 'hmh-ws-'));
  const home = await mkdtemp(join(tmpdir(), 'hmh-home-'));
  const inCtx = { cwd: ws, home };
  try {
    // inside the workspace: silent (Codex workspace-write tier)
    assert.equal(gate({ path: join(ws, 'src/app.ts') }, inCtx), false, 'cwd file: no card');
    assert.equal(gate({ path: 'src/app.ts' }, inCtx), false, 'relative-to-cwd file: no card');
    // HMH_HOME is the agent's own state (config.json can rewrite approval
    // policy): ALWAYS a card, even though it may also be inside cwd
    assert.equal(gate({ path: join(home, 'config.json') }, inCtx), true, 'HMH_HOME config: card');
    // outside both: a card
    assert.equal(gate({ path: 'C:/Windows/system32/hosts' }, inCtx), true, 'outside: card');
    // no context to bound the blast radius: a card (fail closed)
    assert.equal(gate({ path: 'x.ts' }, undefined), true, 'no ctx: card');
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

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
