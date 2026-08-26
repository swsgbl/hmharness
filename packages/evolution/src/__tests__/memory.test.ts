import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMemory, readNotes, retrieveMemory, scoreNotes } from '../memory.ts';

let home: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'hmh-mem-'));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('append + read round trip', async () => {
  await appendMemory(home, 'hmharness kernel is zero-dependency');
  await appendMemory(home, 'hvigor needs modelVersion in root oh-package');
  const notes = await readNotes(home);
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /zero-dependency/);
});

test('CJK bigram scoring ranks the relevant note first', async () => {
  const notes = [
    { time: 't1', text: 'hvigor 构建需要在根 oh-package 配置 modelVersion' },
    { time: 't2', text: '仓颉 cjpm 构建修复流程' },
  ];
  const ranked = scoreNotes(notes, 'hvigor 构建失败怎么办');
  assert.match(ranked[0].note.text, /hvigor/);
});

test('retrieveMemory bounds output and injects newest', async () => {
  const out = await retrieveMemory(home, 'hvigor', { topK: 5, newest: 1, maxChars: 100 });
  assert.ok(out.length <= 130);
  assert.match(out, /modelVersion/);
});
