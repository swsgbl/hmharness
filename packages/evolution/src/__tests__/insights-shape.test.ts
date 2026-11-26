/**
 * The insight feed is read from disk on every evolution cycle. A line that
 * parses but is not a well-formed record - an older schema written before
 * `toolsUsed` existed, a torn write, a stray array - used to pass through as
 * typed, and one such line crashed every later cycle with a TypeError
 * (2026-11-26, found while reproducing why the evolution daemon logged
 * "Command failed" on every cycle).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInsights } from '../insights.ts';
import { runEvolution } from '../evolve.ts';

async function withInsights(lines: string[], fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-insight-shape-'));
  try {
    await mkdir(join(home, 'insights'), { recursive: true });
    await writeFile(join(home, 'insights', 'insights.jsonl'), lines.join('\n') + '\n', 'utf8');
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const good = JSON.stringify({ time: '2026-11-26T01:00:00.000Z', session: 's-abcdef123456', task: 'a real task', outcome: 'ok', turns: 3, toolUses: 2, toolsUsed: ['read_file', 'run_command'] });

test('readInsights puts an old or torn record into shape instead of passing it through as typed', async () => {
  await withInsights([
    good,
    JSON.stringify({ task: 'written before toolsUsed existed', outcome: 'ok', turns: 2, toolUses: 1 }),
    JSON.stringify({ time: 12345, session: null, task: { nested: true }, outcome: 'weird', turns: 'x', toolUses: 'y', toolsUsed: 'read_file' }),
    JSON.stringify({ toolsUsed: ['read_file', 42, null, { no: 1 }] }),
    '[1,2,3]',
    '"a bare string"',
    'null',
    '{ not json at all',
  ], async (home) => {
    const rows = await readInsights(home);
    assert.equal(rows.length, 4, 'the four objects; the array, the string, null and the broken line are dropped');
    const [a, b, c, d] = rows as unknown as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    assert.deepEqual(a.toolsUsed, ['read_file', 'run_command'], 'a good record is untouched');
    assert.deepEqual([b.toolsUsed, b.time, b.session], [[], '', ''], 'the old schema: no tools used, empty ids - not undefined');
    assert.deepEqual([c.time, c.session, c.task, c.turns, c.toolUses, c.toolsUsed], ['', '', '', 0, 0, []], 'wrong-typed fields become their zero values');
    assert.deepEqual(d.toolsUsed, ['read_file'], 'and only the strings survive in the tool list');
  });
});

test('one old-schema line does not crash the evolution cycle', async () => {
  await withInsights([
    good,
    JSON.stringify({ task: 'written before toolsUsed existed', outcome: 'ok', turns: 2, toolUses: 1 }),
  ], async (home) => {
    const report = await runEvolution({
      home,
      provider: { name: 'unused', baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never,
      runCase: async (c) => (c.name === 'reply-determinism' ? 'HMH-OK' : 'hdc hvigorw ohpm'),
      presetProposals: [],
      log: () => undefined,
    });
    assert.equal(report.insightCount, 2, 'both records fed the cycle');
    const log = JSON.parse((await readFile(join(home, 'evolution', 'log.jsonl'), 'utf8')).trim().split('\n').pop() ?? '{}');
    assert.equal(log.insightCount, 2, 'and the cycle was logged');
  });
});
