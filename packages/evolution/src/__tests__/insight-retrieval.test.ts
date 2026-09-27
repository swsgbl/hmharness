import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bigrams, jaccard, retrieveInsights, INSIGHT_SIM_FLOOR } from '../insights.ts';

test('bigrams/jaccard: identical > similar > disjoint; CJK-friendly', () => {
  const a = bigrams('fix the hdc connection');
  const b = bigrams('fix the hdc connection');
  const c = bigrams('fix the hdc timeout');
  const d = bigrams('zzz yyy xxx www');
  assert.equal(jaccard(a, b), 1);
  assert.ok(jaccard(a, c) > jaccard(a, d), 'similar beats unrelated');
  assert.equal(jaccard(a, d), 0);
  assert.ok(jaccard(bigrams('修复鸿蒙工具链'), bigrams('修复鸿蒙工具链超时')) > 0.4, 'Chinese bigrams overlap');
  assert.equal(bigrams('').size, 0);
});

test('retrieveInsights: the RELEVANT old lesson wins over unrelated recent ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-ret-'));
  try {
    await mkdir(join(home, 'insights'), { recursive: true });
    const mk = (task: string, session: string) => JSON.stringify({ time: 't', session, task, outcome: 'ok', turns: 3, toolUses: 2, toolsUsed: ['hdc'] });
    const rows = [
      mk('deploy hap to the connected HarmonyOS device via hdc', 's-old'),
      mk('write a haiku about autumn leaves', 's-1'),
      mk('summarize the git log for the release', 's-2'),
      mk('refactor the css of the settings page', 's-3'),
      mk('translate the readme to japanese', 's-4'),
      mk('list all npm scripts in this repo', 's-5'),
    ];
    await writeFile(join(home, 'insights', 'insights.jsonl'), rows.join('\n') + '\n', 'utf8');
    const out = await retrieveInsights(home, 'deploy the app to the connected HarmonyOS device through hdc');
    assert.ok(out.includes('s-1') === false, 'irrelevant rows not selected by session');
    // the old hdc lesson must be FIRST even though it is the oldest row
    const first = out.split('\n')[0];
    assert.ok(first.includes('deploy hap'), 'relevant old lesson ranked first: ' + first);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('retrieveInsights: nothing relevant -> graceful fallback to recency (same as before)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-ret2-'));
  try {
    await mkdir(join(home, 'insights'), { recursive: true });
    const mk = (task: string) => JSON.stringify({ time: 't', session: 's', task, outcome: 'ok', turns: 1, toolUses: 0, toolsUsed: [] });
    await writeFile(join(home, 'insights', 'insights.jsonl'), [mk('zzz qqq'), mk('xxx yyy'), mk('kkk jjj')].join('\n') + '\n', 'utf8');
    const out = await retrieveInsights(home, 'deploy hdc harmonyos');
    assert.ok(out.length > 0, 'still injects the most recent rows');
    assert.ok(out.includes('kkk jjj'), 'newest present in fallback');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('retrieveInsights: empty/missing archive -> empty string, no crash', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-ret3-'));
  try {
    assert.equal(await retrieveInsights(home, 'anything'), '');
    await mkdir(join(home, 'insights'), { recursive: true });
    await writeFile(join(home, 'insights', 'insights.jsonl'), '\n\n', 'utf8');
    assert.equal(await retrieveInsights(home, 'anything'), '');
    // blank query degrades to recency over whatever exists
    await writeFile(join(home, 'insights', 'insights.jsonl'), JSON.stringify({ time: 't', session: 's', task: 'a task', outcome: 'ok', turns: 1, toolUses: 0, toolsUsed: [] }) + '\n', 'utf8');
    assert.ok((await retrieveInsights(home, '   ')).includes('a task'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('noise floor keeps unrelated natural-language experience out', () => {
  // natural tasks sharing at most an accidental bigram score ~0.025; the
  // 0.03 floor filters exactly that coincidence class
  const q = bigrams('deploy the hap package to the device with hdc');
  const r = bigrams('write a haiku about autumn leaves and rain');
  assert.ok(jaccard(q, r) < INSIGHT_SIM_FLOOR, 'unrelated tasks stay under the floor');
  assert.ok(jaccard(bigrams('deploy hap via hdc'), bigrams('deploy hap through hdc')) > INSIGHT_SIM_FLOOR, 'related tasks clear it');
});
