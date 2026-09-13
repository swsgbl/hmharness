import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolution, type ProposalOutcome } from '../evolve.ts';

test('budget-skipped cycles are durably logged (day-16 audit defect: early return bypassed the log)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-budget-'));
  try {
    await mkdir(join(home, 'evolution'), { recursive: true });
    const cap = { cyclesPerDay: 1, tokensPerCycle: 100000 };
    await writeFile(join(home, 'config.json'), JSON.stringify({ evolutionBudget: cap }), 'utf8');
    const today = new Date().toISOString();
    const prior = { time: today, proposals: [], insightCount: 0, noteCount: 0, outcomes: [{ name: 'cycle', action: 'promoted', reason: 'seed' }], estTokens: 1234 };
    await writeFile(join(home, 'evolution', 'log.jsonl'), JSON.stringify(prior) + '\n', 'utf8');

    // day already at cap: the gate fires BEFORE any provider call. The fake
    // provider throws if the loop ever got that far.
    const report = await runEvolution({
      home,
      provider: { name: 'must-not-be-called', baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never,
      runCase: async () => { throw new Error('bench must not run past the gate'); },
      log: () => {},
    });
    const outcomes = (report as { outcomes: ProposalOutcome[] }).outcomes;
    assert.equal(outcomes.some((o) => o.name === '(budget)'), true, 'skip recorded in the report');

    // THE FIX under test: the skip is durably logged
    const raw = await readFile(join(home, 'evolution', 'log.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { outcomes: ProposalOutcome[] });
    assert.equal(lines.length, 2, 'skip appended to log.jsonl');
    assert.equal(lines[1].outcomes.some((o) => o.name === '(budget)'), true, 'durable skip entry');
  } finally { await rm(home, { recursive: true, force: true }); }
});
