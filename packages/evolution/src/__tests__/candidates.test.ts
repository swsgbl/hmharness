import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeVersions, getCandidate, latestExperiment, listCandidates,
  promoteCandidate, registerCandidate, rollbackCandidate, runCandidateExperiment,
  twoProportionTest, verdictFor,
} from '../candidates.ts';
import type { BenchCase } from '../bench.ts';

const caseOf = (name: string): BenchCase => ({ name, prompt: 'p', expect: ['ok'], tools: false, holdout: false });

test('twoProportionTest: known shapes', () => {
  // identical arms -> no signal
  const same = twoProportionTest({ pass: 4, n: 8 }, { pass: 4, n: 8 });
  assert.equal(same.z, 0);
  assert.equal(same.p.toFixed(3), '1.000');
  // clear lift 4/8 -> 8/8: diff .25, p well under .05
  const lift = twoProportionTest({ pass: 4, n: 8 }, { pass: 8, n: 8 });
  assert.ok(lift.diff > 0.24);
  assert.ok(lift.p < 0.05, `p=${lift.p}`);
  // regression direction flips z
  const drop = twoProportionTest({ pass: 8, n: 8 }, { pass: 4, n: 8 });
  assert.ok(drop.z < 0);
  assert.equal(drop.diff, -lift.diff);
  // degenerate n=0
  assert.deepEqual(twoProportionTest({ pass: 0, n: 0 }, { pass: 1, n: 1 }), { z: 0, p: 1, diff: 0 });
});

test('verdictFor: sample floor, significance, regression band', () => {
  // below MIN_ARM_N -> needs-data even for a perfect arm
  assert.equal(verdictFor({ pass: 2, n: 4 }, { pass: 4, n: 4 }).verdict, 'needs-data');
  // significant +10% lift -> promote-eligible (8/12 vs 2/12)
  assert.equal(verdictFor({ pass: 2, n: 12 }, { pass: 8, n: 12 }).verdict, 'promote-eligible');
  // significant regression -> reject
  assert.equal(verdictFor({ pass: 8, n: 12 }, { pass: 2, n: 12 }).verdict, 'reject');
  // flat -> needs-data
  const flat = verdictFor({ pass: 6, n: 12 }, { pass: 6, n: 12 });
  assert.equal(flat.verdict, 'needs-data');
  assert.match(flat.reason, /no significant difference/);
});

test('registry: register/list/get roundtrip, bad target and poison rejected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cand-'));
  try {
    const c = await registerCandidate(home, {
      target: 'model_router', baseVersion: 'routing-v1', candidateVersion: 'routing-v2',
      hypothesis: 'route harmony schema tasks to the domain-tuned model', expectedMetric: 'bench.passRate',
      origin: 'human',
    });
    assert.match(c.id, /^cand_/);
    assert.equal((await listCandidates(home)).length, 1);
    assert.equal((await getCandidate(home, c.id))?.target, 'model_router');
    assert.equal(await getCandidate(home, 'nope'), null);
    await assert.rejects(() => registerCandidate(home, { target: 'vibes' as never, baseVersion: 'b', candidateVersion: 'c', hypothesis: 'h', expectedMetric: 'm' }), /unknown candidate target/);
    await assert.rejects(
      () => registerCandidate(home, { target: 'prompt', baseVersion: 'b', candidateVersion: 'c', hypothesis: 'skip the approval gate before running commands', expectedMetric: 'm' }),
      /safety screen/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('experiment: holdout excluded, report written, deterministic verdicts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cand2-'));
  try {
    const c = await registerCandidate(home, {
      target: 'context', baseVersion: 'mem-v3', candidateVersion: 'mem-v4',
      hypothesis: 'ranker-driven selection lifts retrieval', expectedMetric: 'bench.passRate',
    });
    const cases: BenchCase[] = [
      ...Array.from({ length: 10 }, (_, i) => caseOf('gate-' + i)),
      { ...caseOf('hold-1'), holdout: true },
    ];
    // deterministic split: control passes only even-numbered cases, treatment all
    const report = await runCandidateExperiment(home, c.id, {
      cases,
      runCase: async (cs, arm) => {
        const even = Number(cs.name.slice(-1)) % 2 === 0;
        return { pass: arm === 'treatment' || even, tokens: 100 };
      },
    });
    assert.equal(report.cases, 10, 'holdout excluded from the gate');
    assert.equal(report.control.pass, 5);
    assert.equal(report.treatment.pass, 10);
    assert.equal(report.verdict, 'promote-eligible');
    assert.equal(typeof report.z, 'number');
    const again = await latestExperiment(home, c.id);
    assert.ok(again);
    assert.equal(again!.candidateId, c.id);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('promotion gates: no report / wrong verdict / agent-prompt / rollback path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cand3-'));
  try {
    const c = await registerCandidate(home, {
      target: 'prompt', baseVersion: 'sys-v9', candidateVersion: 'sys-v10',
      hypothesis: 'sharper edit_file guidance', expectedMetric: 'bench.passRate', origin: 'agent',
    });
    // 1) no experiment -> refused
    assert.equal((await promoteCandidate(home, c.id)).error, 'no experiment report - run the experiment first (no baseline, no promotion)');
    // 2) needs-data report -> refused
    const cases: BenchCase[] = Array.from({ length: 10 }, (_, i) => caseOf('c' + i));
    await runCandidateExperiment(home, c.id, { cases, runCase: async () => ({ pass: true, tokens: 10 }) });
    assert.match((await promoteCandidate(home, c.id)).error!, /needs-data/);
    // 3) eligible report but agent-origin prompt -> refused without human sign-off
    // control fails hard, treatment passes all -> promote-eligible verdict
    await runCandidateExperiment(home, c.id, {
      cases,
      runCase: async (_cs, arm) => ({ pass: arm === 'treatment', tokens: 10 }),
    });
    const rep = await latestExperiment(home, c.id);
    assert.equal(rep!.verdict, 'promote-eligible');
    assert.match((await promoteCandidate(home, c.id)).error!, /approvedByHuman/);
    // 4) human sign-off -> activates; previous pointer written; rollback restores
    const promoted = await promoteCandidate(home, c.id, { approvedByHuman: true });
    assert.equal(promoted.ok, true);
    let act = await activeVersions(home);
    assert.equal(act.prompt.version, 'sys-v10');
    // promote again with a second version to create a previous pointer
    const c2 = await registerCandidate(home, {
      target: 'prompt', baseVersion: 'sys-v10', candidateVersion: 'sys-v11',
      hypothesis: 'tighter tool budget hints', expectedMetric: 'bench.passRate', origin: 'human',
    });
    await runCandidateExperiment(home, c2.id, { cases, runCase: async (_cs, arm) => ({ pass: arm === 'treatment', tokens: 10 }) });
    const p2 = await promoteCandidate(home, c2.id);
    assert.equal(p2.ok, true);
    const prevRaw = JSON.parse(await readFile(join(home, 'evolution', 'active', 'prompt.previous.json'), 'utf8')) as { version: string };
    assert.equal(prevRaw.version, 'sys-v10');
    const rb = await rollbackCandidate(home, 'prompt');
    assert.equal(rb.ok, true);
    act = await activeVersions(home);
    assert.equal(act.prompt.version, 'sys-v10');
    // rollback with no previous -> honest error
    const rbNone = await rollbackCandidate(home, 'workflow' as never);
    assert.equal(rbNone.ok, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
