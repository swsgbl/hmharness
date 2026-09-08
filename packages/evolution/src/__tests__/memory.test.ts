import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMemory, readNotes, retrieveMemory, scoreNotes, workspaceForCwd } from '../memory.ts';

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

/* -------- workspace scoping -------- */

test('workspaceForCwd: longest prefix wins, separators/case tolerant, null outside', async () => {
  const wsHome = await mkdtemp(join(tmpdir(), 'hmh-ws-'));
  try {
    await writeFile(join(wsHome, 'workspaces.json'), JSON.stringify({ workspaces: [
      { id: '1', name: 'main-proj', path: 'G:\\Projects\\Main' },
      { id: '2', name: 'sub-proj', path: 'G:/Projects/Main/Deep' },
      { id: '3', name: 'other', path: 'G:\\Elsewhere' },
    ] }), 'utf8');
    assert.equal(await workspaceForCwd(wsHome, 'G:\\Projects\\Main'), 'main-proj');
    assert.equal(await workspaceForCwd(wsHome, 'g:/projects/main/deep/src'), 'sub-proj', 'nested + case + slash mix, longest wins');
    assert.equal(await workspaceForCwd(wsHome, 'g:\\projects\\mainfile'), null, 'prefix without separator is NOT a match');
    assert.equal(await workspaceForCwd(wsHome, 'C:\\Users'), null);
    assert.equal(await workspaceForCwd(wsHome + '-none', 'G:\\Projects\\Main'), null, 'missing registry = global');
  } finally {
    await rm(wsHome, { recursive: true, force: true });
  }
});

test('workspace tags: boost at home, dampen abroad, untagged untouched', async () => {
  const notes = [
    { time: 't1', text: 'build flag X for this repo [ws:projA]' },
    { time: 't2', text: 'build flag X for that repo [ws:projB]' },
    { time: 't3', text: 'build flag X general rule' },
  ];
  const atHome = scoreNotes(notes, 'build flag X', 'projA');
  assert.match(atHome[0].note.text, /projA/);
  const order = atHome.map((r) => r.note.text);
  assert.ok(order.indexOf('build flag X for this repo [ws:projA]') < order.indexOf('build flag X general rule'), 'home note beats global');
  assert.ok(order.indexOf('build flag X general rule') < order.indexOf('build flag X for that repo [ws:projB]'), 'global beats foreign');
  // no workspace context = legacy behaviour (tag-free ranking by overlap only, all equal-ish, no boost/dampen)
  const neutral = scoreNotes(notes, 'build flag X');
  assert.equal(neutral.length, 3);
});

test('appendMemory tags the workspace; tag survives readNotes', async () => {
  await appendMemory(home, 'project-local fact', 'projA');
  const notes = await readNotes(home);
  const tagged = notes.find((n) => n.text.includes('project-local fact'));
  assert.match(tagged?.text ?? '', /\[ws:projA\]$/);
});

/* -------- optional embedding hybrid -------- */

test('embedding hybrid: vector relevance outranks lexical miss; cache reused; failure falls back to lexical', async () => {
  const eHome = await mkdtemp(join(tmpdir(), 'hmh-emb-'));
  const P = { baseUrl: 'http://emb.test/v1', apiKey: 'k', model: 'e' };
  try {
    await appendMemory(eHome, 'arkts strict mode pitfalls');
    await appendMemory(eHome, 'completely different cooking recipe note');
    // vectors: dim-2, axis-aligned - the query aligns with note 1
    const vecFor = (s: string): number[] => (s.includes('pitfalls') || s.includes('hvigor') ? [1, 0] : [0, 1]);
    let embedCalls = 0;
    const fetchImpl = (async (url: unknown, init?: { body?: string }) => {
      embedCalls++;
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as { input?: string[] };
      const data = (body.input ?? []).map((s) => ({ embedding: vecFor(s) }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const query = 'hvigor pitfalls'; // lexical miss on note1? 'pitfalls' overlaps; recipe note has zero overlap
    const out = await retrieveMemory(eHome, query, { embedding: P, fetchImpl, topK: 1, newest: 0 });
    assert.match(out, /arkts strict mode pitfalls/);
    assert.ok(!out.includes('cooking recipe'), 'lexically-irrelevant note excluded by hybrid ranking');
    // cache: second retrieval must not re-embed the NOTES (only the query)
    const callsAfterFirst = embedCalls;
    await retrieveMemory(eHome, query, { embedding: P, fetchImpl, topK: 1, newest: 0 });
    assert.equal(embedCalls, callsAfterFirst + 1, 'only the query embeds on cache hit');
    assert.equal(Object.keys(JSON.parse(await readFile(join(eHome, 'memory', 'embeddings.json'), 'utf8'))).length, 2, 'note vectors cached');
    // endpoint down -> pure lexical output (still works, no throw)
    const badFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const fallback = await retrieveMemory(eHome, query, { embedding: P, fetchImpl: badFetch });
    assert.ok(fallback.includes('arkts strict mode pitfalls'), 'lexical fallback still retrieves');
  } finally {
    await rm(eHome, { recursive: true, force: true });
  }
});
