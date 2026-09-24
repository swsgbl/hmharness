import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolution, type ProposalOutcome } from '../evolve.ts';
import type { BenchCase } from '../bench.ts';

async function seed(home: string, config?: object): Promise<void> {
  await mkdir(join(home, 'bench', 'cases'), { recursive: true });
  await writeFile(join(home, 'bench', 'cases', 't1.task'), 'say OK1\nexpect: OK1\n', 'utf8');
  await writeFile(join(home, 'bench', 'cases', 't2.task'), 'say OK2\nexpect: OK2\n', 'utf8');
  await mkdir(join(home, 'insights'), { recursive: true });
  await writeFile(join(home, 'insights', 'insights.jsonl'), '', 'utf8');
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8');
}

const neverProvider = { name: 'unused', baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never;
const noopLog = () => {};

test('promotion quality floor: non-regression vs a weak baseline is not good enough (day-16 audit)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-floor-'));
  try {
    await seed(home);
    // seedCases adds 3 default cases (2 train + 1 holdout) -> train = 4.
    // Candidate passes only t1+t2 (0.5); baseline (same runner) is also 0.5.
    // Old gate: 0.5 >= 0.5, no regression -> PROMOTED (the audit's hole).
    // New gate: 0.5 < 0.6 default floor -> rejected.
    const report = await runEvolution({
      home,
      provider: neverProvider,
      runCase: async (c: BenchCase) => (c.name === 't1' || c.name === 't2' ? `OK${c.name.slice(1)}` : 'nope'),
      presetProposals: [{ name: 'half-good', description: 'd', skill_md: '# half\nreferences not rules' }],
      log: noopLog,
    });
    const outcomes = (report as { outcomes: ProposalOutcome[] }).outcomes;
    const o = outcomes.find((x) => x.name === 'half-good');
    assert.ok(o, 'outcome recorded');
    assert.equal(o!.action, 'rejected');
    assert.match(o!.reason, /below quality floor/);
    assert.match(o!.reason, /weak baseline/);
    const drafts = await readFile(join(home, 'skills', 'drafts', 'half-good.md'), 'utf8').catch(() => '');
    assert.equal(drafts, '', 'rejected draft deleted');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('promotion quality floor: above-floor candidate promotes; config override respected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-floor2-'));
  try {
    await seed(home, { evolution: { minPassRate: 0.4 } });
    // candidate passes 3/4 train (0.75): below the 0.6 default would reject,
    // but the config floor 0.4 admits it; holdout passes too -> no rollback.
    const report = await runEvolution({
      home,
      provider: neverProvider,
      runCase: async (c: BenchCase) => {
        if (c.name === 'reply-determinism') return 'HMH-OK';
        if (c.name === 'toolchain-ohpm-status') return 'OK';
        return c.name === 'toolchain-report' ? 'nope' : `OK${c.name.slice(1)}`;
      },
      presetProposals: [{ name: 'cfg-floor', description: 'd', skill_md: '# ok\nreferences not rules' }],
      log: noopLog,
    });
    const outcomes = (report as { outcomes: ProposalOutcome[] }).outcomes;
    const o = outcomes.find((x) => x.name === 'cfg-floor');
    assert.ok(o);
    assert.equal(o!.action, 'promoted', 'config floor 0.4 admits 75%: ' + o!.reason);
    assert.match(o!.reason, /floor ≥40%/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
