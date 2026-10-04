import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetHash, canonicalTaskSet, seededOrder, seedFromString, splitSet, holdoutDisciplineOK, buildRunReport, reportsComparable, type EvalTaskSet } from '../evalset.ts';

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
