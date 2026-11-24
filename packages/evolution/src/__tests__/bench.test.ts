import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { listCases, matchCase, matchExpect, normalizeRegex, seedCases } from '../bench.ts';

// 2026-11-25 根因回归测试(三臂 v1/v2 NEEDS-DATA 的真凶):
// .task 数据文件用斜杠定界写正则(expect-regex: /^\d+$/),而所有单元测试
// 用裸正则('^\d+$')——两种格式从未在同一个测试里相遇,于是解析器不去
// 定界符的缺陷让 train 门控集 13/35 题永远判错(原始输出字节 "50" 被判
// regex mismatch),基线被压到 54% < 质量地板 60%,任何候选数学上必死。
test('normalizeRegex strips JS-literal delimiters and flags', () => {
  assert.equal(normalizeRegex('/^\\d+$/'), '^\\d+$');
  assert.equal(normalizeRegex('/^\\d+$/i'), '^\\d+$');
  assert.equal(normalizeRegex('/foo\\/bar/'), 'foo\\/bar', 'escaped slash inside must survive');
  assert.equal(normalizeRegex('^[0-9a-f]{4}$'), '^[0-9a-f]{4}$', 'bare pattern untouched');
  assert.equal(normalizeRegex('a/b'), 'a/b', 'unterminated slash is literal, not a delimiter');
});

test('matchCase judges a slash-delimited .task regex against the real answer', () => {
  // 字节级复现 three-arm-v2 phase0: 输出 0x35 0x30 = "50", 原判定 regex mismatch
  assert.equal(matchCase('50', { expect: ['50'], expectRegex: '/^\\d+$/' }).pass, true);
  assert.equal(matchCase('50', { expect: [], expectRegex: '/^\\d+$/' }).pass, true);
  assert.equal(matchCase(' padded-start', { expect: [], expectRegex: '/^ padded-start$/' }).pass, true);
  // 仍然要能判错
  assert.equal(matchCase('The answer is 50', { expect: [], expectRegex: '/^\\d+$/' }).pass, false);
  assert.equal(matchCase('72', { expect: [], expectRegex: '/^\\d+$/' }).pass, true);
});

test('listCases parses a slash-delimited expect-regex line so the case is passable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-bench-rx-'));
  try {
    await mkdir(join(home, 'bench', 'cases'), { recursive: true });
    await writeFile(join(home, 'bench', 'cases', 'slash-rx.task'),
      'Compute 7*8 + 12/4 - 3^2. Reply with ONLY the result (a single integer).\nexpect-regex: /^\\d+$/\nexpect: 50\n', 'utf8');
    const c = (await listCases(home)).find((x) => x.name === 'slash-rx');
    assert.ok(c, 'case parsed');
    assert.equal(matchCase('50', c!).pass, true, 'the real answer must pass the real data format');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('matchExpect requires every && part, case-insensitive', () => {
  assert.equal(matchExpect('hdc hvigorw ohpm all OK', ['hdc', 'hvigorw', 'ohpm']), true);
  assert.equal(matchExpect('hdc ok but no build tool', ['hdc', 'hvigorw']), false);
  assert.equal(matchExpect('HDC uppercase', ['hdc']), true);
  assert.equal(matchExpect('anything', []), true);
});

test('seedCases is idempotent and cases parse with holdout/tools flags', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-bench-'));
  try {
    const first = await seedCases(home);
    assert.ok(first.length >= 2, 'seeds on fresh home');
    const again = await seedCases(home);
    assert.equal(again.length, 0, 'second seed writes nothing');
    const cases = await listCases(home);
    const tc = cases.find((c) => c.name.includes('toolchain-report'));
    assert.ok(tc?.tools, 'toolchain case runs through the loop');
    assert.ok(!tc?.holdout);
    const ho = cases.find((c) => c.holdout);
    assert.ok(ho, 'a holdout case exists');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
