import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetHash, canonicalTaskSet, seededOrder, seedFromString, splitSet, holdoutDisciplineOK, buildRunReport, reportsComparable, pairedSignificance, type EvalTaskSet } from '../evalset.ts';

function mkSet(revision = 1): EvalTaskSet {
  return {
    kind: 'hmharness-eval-taskset',
    version: 1,
    id: 'generalbench-core',
    revision,
    createdAt: new Date().toISOString(),
    tasks: [
      { id: 't2', prompt: 'count files', assertion: { kind: 'expect-exact', expect: '9' } },
      { id: 't1', prompt: 'write config', assertion: { kind: 'expect-regex', expect: '^ok$' }, holdout: true },
      { id: 't3', prompt: 'read version', assertion: { kind: 'expect-exact', expect: '0-23-21' } },
    ],
  };
}

test('evalset: dataset hash is order-independent and content-sensitive', () => {
  const a = mkSet();
  const b = mkSet();
  b.tasks = [b.tasks[2]!, b.tasks[0]!, b.tasks[1]!]; // same content, different array order
  assert.equal(datasetHash(a), datasetHash(b), 'reordering tasks must not change the hash (canonical form sorts by id)');
  const c = mkSet();
  c.tasks[0]!.prompt = 'count files carefully'; // content change
  assert.notEqual(datasetHash(a), datasetHash(c));
  const d = mkSet(2); // revision bump
  assert.notEqual(datasetHash(a), datasetHash(d), 'revision is part of identity');
});

test('evalset: seeded order is deterministic across runs and differs across seeds', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const s1 = seedFromString('generalbench-core/run-1');
  const first = seededOrder(items, s1);
  const second = seededOrder(items, s1);
  assert.deepEqual(first, second, 'same seed -> identical order');
  const other = seededOrder(items, seedFromString('generalbench-core/run-2'));
  assert.notDeepEqual(first, other, 'different seed -> different order (overwhelmingly)');
  assert.deepEqual([...first].sort(), items, 'shuffle is a permutation, nothing lost');
});

test('evalset: holdout split + discipline gate', () => {
  const set = mkSet();
  const split = splitSet(set);
  assert.equal(split.train.length, 2);
  assert.equal(split.holdout.length, 1);
  assert.equal(split.holdout[0]!.id, 't1');
  // clean train arm
  const clean = holdoutDisciplineOK(['t2', 't3'], split);
  assert.equal(clean.ok, true);
  // contaminated arm names a holdout task
  const dirty = holdoutDisciplineOK(['t2', 't1'], split);
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.violations, ['t1']);
});

test('evalset: run report carries datasetHash+seed+split; mislabeled reports are refused', () => {
  const set = mkSet();
  const seed = seedFromString('generalbench-core/run-1');
  const trainReport = buildRunReport(set, {
    seed, split: 'train', arm: 'model+cogOS',
    perTask: [{ id: 't2', pass: true }, { id: 't3', pass: false }],
  });
  assert.equal(trainReport.total, 2);
  assert.equal(trainReport.passed, 1);
  assert.equal(trainReport.datasetHash, datasetHash(set));
  assert.equal(trainReport.split, 'train');
  // a report sneaking a holdout task into a train split is REFUSED at build time
  assert.throws(
    () => buildRunReport(set, { seed, split: 'train', arm: 'x', perTask: [{ id: 't1', pass: true }] }),
    /outside the declared 'train' split/,
  );
  // comparability: same dataset+seed+split -> comparable; anything differs -> not
  const trainReport2 = buildRunReport(set, { seed, split: 'train', arm: 'model-only', perTask: [{ id: 't2', pass: false }, { id: 't3', pass: false }] });
  assert.equal(reportsComparable(trainReport, trainReport2), true, 'same hash/seed/split arms are comparable');
  const holdoutReport = buildRunReport(set, { seed, split: 'holdout', arm: 'model+cogOS', perTask: [{ id: 't1', pass: true }] });
  assert.equal(reportsComparable(trainReport, holdoutReport), false, 'train vs holdout are never comparable');
  const otherSeed = buildRunReport(set, { seed: seed + 1, split: 'train', arm: 'model+cogOS', perTask: trainReport.perTask });
  assert.equal(reportsComparable(trainReport, otherSeed), false, 'different seed -> not comparable');
  const revised = mkSet(2);
  const revisedReport = buildRunReport(revised, { seed, split: 'train', arm: 'model+cogOS', perTask: trainReport.perTask });
  assert.equal(reportsComparable(trainReport, revisedReport), false, 'dataset revision change -> not comparable');
});

test('evalset: paired McNemar significance — refuses non-comparable, reads discordant pairs correctly', () => {
  const set = mkSet();
  const seed = seedFromString('sig-test');
  // 8-task train arm shape for a decisive and an ambiguous comparison
  const big = mkSet();
  big.tasks = [
    { id: 'a1', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a2', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a3', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a4', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a5', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a6', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a7', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
    { id: 'a8', prompt: 'p', assertion: { kind: 'expect-none', expect: '' } },
  ];
  const ids = big.tasks.map((t) => t.id);
  const armA = buildRunReport(big, { seed, split: 'train', arm: 'A', perTask: ids.map((id) => ({ id, pass: true })) });
  // arm B fails a1..a6 (6 discordant, all one way) — decisive
  const armB = buildRunReport(big, { seed, split: 'train', arm: 'B', perTask: ids.map((id, i) => ({ id, pass: i >= 6 })) });
  const decisive = pairedSignificance(armA, armB);
  assert.equal(decisive.comparable, true);
  assert.equal(decisive.discordant.armOnlyPassed, 6);
  assert.equal(decisive.discordant.armBPassed, 0);
  assert.equal(decisive.discordant.agreed, 2);
  assert.ok(decisive.pValue! < 0.05, `6:0 discordant must be significant, got p=${decisive.pValue}`);
  assert.equal(decisive.significant, true);
  // ambiguous: each arm fails ONE DIFFERENT task (1:1 discordant) — a fair coin explains it
  const armX = buildRunReport(big, { seed, split: 'train', arm: 'X', perTask: ids.map((id, i) => ({ id, pass: i !== 0 })) });
  const armY = buildRunReport(big, { seed, split: 'train', arm: 'Y', perTask: ids.map((id, i) => ({ id, pass: i !== 1 })) });
  const ambiguous = pairedSignificance(armX, armY);
  assert.equal(ambiguous.discordant.armOnlyPassed + ambiguous.discordant.armBPassed, 2);
  assert.ok(ambiguous.pValue! >= 0.05, '1:1 discordant must NOT be significant');
  assert.equal(ambiguous.significant, false);
  // identical reports: zero discordant -> p=1, not significant
  const same = pairedSignificance(armA, armA);
  assert.equal(same.pValue, 1);
  assert.equal(same.significant, false);
  // non-comparable is REFUSED with a reason and no verdict fields used
  const otherSeed = buildRunReport(big, { seed: seed + 99, split: 'train', arm: 'A', perTask: armA.perTask });
  const refused = pairedSignificance(armA, otherSeed);
  assert.equal(refused.comparable, false);
  assert.match(refused.refusalReason ?? '', /not comparable/);
  assert.equal(refused.significant, undefined, 'no significance claim on refused comparisons');
  void set;
});
