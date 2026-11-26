import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileTool } from '../tools.ts';

test('write_file creates the missing parent directories (a new file under a new folder is normal work, not ENOENT)', async () => {
  // Until 0.23.55 this failed with "ENOENT: no such file or directory" and cost
  // a round trip through a shell mkdir - a dead end wherever no shell tool is wired
  const ws = await mkdtemp(join(tmpdir(), 'hmh-wf-'));
  const ctx = { cwd: ws, home: join(ws, 'home') };
  try {
    const target = join('docs', 'guide', 'new.md');
    const first = await writeFileTool.execute({ path: target, content: '# hi' }, ctx);
    assert.notEqual(first.isError, true, first.output);
    assert.equal(await readFile(join(ws, target), 'utf8'), '# hi', 'the file is where it was asked to be');
    assert.match(first.output, /created directory/, 'and the output says a directory had to be made');

    const second = await writeFileTool.execute({ path: target, content: '# again' }, ctx);
    assert.doesNotMatch(second.output, /created directory/, 'an existing directory is not "created"');
    assert.equal(await readFile(join(ws, target), 'utf8'), '# again');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('write_file: a path whose parent is a FILE is still an error - nothing is created over it', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'hmh-wf-'));
  const ctx = { cwd: ws, home: join(ws, 'home') };
  try {
    await writeFile(join(ws, 'blocker'), 'I am a file', 'utf8');
    const r = await writeFileTool.execute({ path: join('blocker', 'x.txt'), content: 'x' }, ctx);
    assert.equal(r.isError, true, 'refused, not silently "repaired"');
    assert.match(r.output, /EEXIST|ENOTDIR|ENOENT/, 'the real filesystem reason: ' + r.output);
    assert.ok((await stat(join(ws, 'blocker'))).isFile(), 'the file is untouched');
    assert.equal(await readFile(join(ws, 'blocker'), 'utf8'), 'I am a file');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
