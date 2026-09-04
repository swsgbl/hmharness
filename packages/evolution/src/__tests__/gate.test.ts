import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchCase, listCases } from '../bench.ts';
import { latestRadarBrief } from '../radar.ts';

/* -------- structured assertions (gate methodology upgrade) -------- */

const base = { expect: [] as string[] };

test('expect-exact: trimmed equality, no extra prose tolerated', () => {
  const c = { ...base, expectExact: 'HMH-OK' };
  assert.equal(matchCase('HMH-OK', c).pass, true);
  assert.equal(matchCase('  HMH-OK  ', c).pass, true);      // trim on both sides
  assert.equal(matchCase('HMH-OK!', c).pass, false);        // extra char fails
  assert.equal(matchCase('sure, HMH-OK', c).pass, false);   // prose fails
});

test('expect-regex: pattern match; invalid regex is a case error, not a pass', () => {
  const c = { ...base, expectRegex: 'ohpm (OK|MISSING)' };
  assert.equal(matchCase('status: ohpm OK', c).pass, true);
  assert.equal(matchCase('status: ohpm BROKEN', c).pass, false);
  const bad = { ...base, expectRegex: '([unclosed' };
  const r = matchCase('anything', bad);
  assert.equal(r.pass, false);
  assert.match(r.detail, /invalid regex/);
});

test('expect-none: failure markers veto verbose-but-wrong outputs', () => {
  const c = { ...base, expect: ['OK'], expectNone: ['error', 'failed'] };
  assert.equal(matchCase('ohpm OK', c).pass, true);
  assert.equal(matchCase('ohpm OK (error ignored)', c).pass, false);
});

test('expect-any: at least one alternative must appear', () => {
  const c = { ...base, expectAny: ['OK', 'MISSING'] };
  assert.equal(matchCase('result: MISSING', c).pass, true);
  assert.equal(matchCase('result: unknown', c).pass, false);
});

test('legacy expect: substring semantics unchanged (back-compat)', () => {
  const c = { ...base, expect: ['hdc', 'ohpm'] };
  assert.equal(matchCase('found HDC and OHPM', c).pass, true);
  assert.equal(matchCase('found hdc only', c).pass, false);
});

test('case files: new modes parse; cost-cap parses; old files still load', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-'));
  const dir = join(home, 'bench', 'cases');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'legacy.task'), 'reply HMH-OK\nexpect: HMH-OK\n', 'utf8');
  await writeFile(join(dir, 'structured.task'), 'reply the version\nexpect-exact: "5.1.2"\nexpect-none: error\ncost-cap: 1.5\n', 'utf8');
  const cases = await listCases(home);
  const legacy = cases.find((c) => c.name === 'legacy')!;
  const structured = cases.find((c) => c.name === 'structured')!;
  assert.deepEqual(legacy.expect, ['HMH-OK']);
  assert.equal(legacy.tools, false);
  assert.equal(structured.expectExact, '5.1.2');
  assert.deepEqual(structured.expectNone, ['error']);
  assert.equal(structured.costCap, 1.5);
  await rm(home, { recursive: true, force: true });
});

/* ---------------- radar feed ---------------- */

test('latestRadarBrief: newest brief within 14 days; absent/stale/empty all null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-radar-'));
  const dir = join(home, 'ops', 'briefs');
  // absent
  assert.equal(await latestRadarBrief(home), null);
  await mkdir(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  // stale brief ignored
  await writeFile(join(dir, '2020-01-01.md'), '## old\nstale news', 'utf8');
  assert.equal(await latestRadarBrief(home), null);
  // fresh brief wins
  await writeFile(join(dir, today + '.md'), '## 摘要\n\nArkUI 5.1.2 released with new flags.', 'utf8');
  const brief = await latestRadarBrief(home);
  assert.match(brief ?? '', /ArkUI 5\.1\.2/);
  await rm(home, { recursive: true, force: true });
});
