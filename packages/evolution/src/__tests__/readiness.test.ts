import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rlReadiness } from '../readiness.ts';
import { rewardFor } from '../dataset.ts';

async function seed(home: string, opts: { runs: number; cases: number; holdout: number; humanLabels?: number; benchRecords?: number[]; skills?: boolean; workflows?: boolean }) {
  // trajectories: reward >= 0.5 => ok runs with low tool failure
  for (let i = 0; i < opts.runs; i++) {
    const dir = join(home, 'runs', `r${String(i).padStart(5, '0')}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      task: `task ${i}`, outcome: 'ok', turns: 2, toolUses: 2, toolFailures: 0, toolsUsed: ['list_dir'], model: 'm',
    }), 'utf8');
  }
  // bench cases
  const casesDir = join(home, 'bench', 'cases');
  await mkdir(casesDir, { recursive: true });
  for (let i = 0; i < opts.cases; i++) {
    await writeFile(join(casesDir, `c${i}.task`), `case ${i}\nexpect: ok\nholdout: ${i < opts.holdout ? 'true' : 'false'}\n`, 'utf8');
  }
  if (opts.humanLabels) {
    const dir = join(home, 'evolution');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'reward-human-labels.jsonl'), Array.from({ length: opts.humanLabels }, (_, i) => `{"sample":${i}}`).join('\n') + '\n', 'utf8');
  }
  if (opts.benchRecords?.length) {
    const dir = join(home, 'evolution', 'benches');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < opts.benchRecords.length; i++) {
      await writeFile(join(dir, `b${i}.json`), JSON.stringify({ passRate: opts.benchRecords[i] }), 'utf8');
    }
  }
  if (opts.skills) {
    await mkdir(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'skills', 's.md'), '# s\n', 'utf8');
  }
  if (opts.workflows) {
    await mkdir(join(home, 'evolution', 'workflows'), { recursive: true });
    await writeFile(join(home, 'evolution', 'workflows', 'w.json'), '{}\n', 'utf8');
  }
}

test('readiness: empty home -> optimize-first with data-collection lever', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-rl-'));
  try {
    const r = await rlReadiness(home);
    assert.equal(r.verdict, 'optimize-first');
    assert.equal(r.recommendedLever, 'data-collection');
    const traj = r.conditions.find((c) => c.id === 'high-quality-trajectories');
    assert.equal(traj!.met, false);
    assert.equal(traj!.current, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('readiness: every condition reported, weakest lever changes with data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-rl2-'));
  try {
    await seed(home, { runs: 1000, cases: 100, holdout: 23, humanLabels: 100, benchRecords: [0.8, 0.82], skills: true, workflows: true });
    const r = await rlReadiness(home);
    assert.equal(r.verdict, 'rl-eligible', 'all six conditions satisfied');
    assert.equal(r.conditions.length, 6);
    assert.equal(r.recommendedLever, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('readiness: regression in bench suite blocks; missing human labels block', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-rl3-'));
  try {
    await seed(home, { runs: 1000, cases: 100, holdout: 5, benchRecords: [0.9, 0.7], skills: true, workflows: true });
    const r = await rlReadiness(home);
    assert.equal(r.verdict, 'optimize-first');
    const suite = r.conditions.find((c) => c.id === 'eval-regression-stable');
    assert.equal(suite!.met, false, '20% passRate drop > 5% tolerance');
    // weakest = FIRST unmet condition in report order (reward-human precedes eval-regression)
    assert.equal(r.recommendedLever, 'reward-calibration');
    // now fix the suite but human labels still missing
    const dir = join(home, 'evolution', 'benches');
    await writeFile(join(dir, 'b1.json'), JSON.stringify({ passRate: 0.88 }), 'utf8');
    const r2 = await rlReadiness(home);
    assert.equal(r2.conditions.find((c) => c.id === 'eval-regression-stable')!.met, true);
    assert.equal(r2.verdict, 'optimize-first');
    assert.equal(r2.recommendedLever, 'reward-calibration');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('readiness: reward floor consistent with dataset reward mapping', async () => {
  // a run with 40% tool failures rewards 0.6 (>= floor), 60% -> 0.4 (< floor)
  assert.ok(rewardFor('ok', 0.4) >= 0.5);
  assert.ok(rewardFor('ok', 0.6) < 0.5);
});
