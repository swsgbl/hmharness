import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingRows, fitRewardModel, scoreFeatures, exportDpoPairs, type HumanLabel, type InsightLike } from '../reward-model.ts';

/* -------- trainingRows join -------- */

const mkIns = (session: string, outcome: string, turns = 3, toolUses = 4): InsightLike => ({ session, outcome, turns, toolUses });
const mkLbl = (session: string, score: number): HumanLabel => ({ session, score, time: '2026-09-18T00:00:00Z' });

test('trainingRows: joins labels to insights, maps outcome to bucket, score to [0,1]', () => {
  const labels = [mkLbl('s1', 5), mkLbl('s2', 3), mkLbl('missing', 4)];
  const insights = [mkIns('s1', 'ok'), mkIns('s2', 'turn-budget')];
  const rows = trainingRows(labels, insights);
  assert.equal(rows.length, 2, 'unmatched label dropped');
  assert.deepEqual(
    rows.map((r) => r.f.outcome).sort(),
    [1, 2],
    'ok->2, turn-budget->1',
  );
  assert.equal(rows.find((r) => r.session === 's1')?.y, 1);
  assert.equal(rows.find((r) => r.session === 's2')?.y, 0.6);
});

/* -------- fit: learns the outcome direction from human labels -------- */

test('fitRewardModel: deterministic, learns outcome direction, reports RMSE', () => {
  // humans score ok runs 5, error runs 1 -> the fitted model must rank
  // ok-features above error-features
  const labels: HumanLabel[] = [];
  const insights: InsightLike[] = [];
  for (let i = 0; i < 30; i++) {
    const okS = `ok-${i}`;
    const errS = `err-${i}`;
    insights.push(mkIns(okS, 'ok', 3 + (i % 4), 4 + (i % 5)));
    insights.push(mkIns(errS, 'error', 8 + (i % 4), 6 + (i % 5)));
    labels.push(mkLbl(okS, 5));
    labels.push(mkLbl(errS, 1));
  }
  const m1 = fitRewardModel(labels, insights);
  const m2 = fitRewardModel(labels, insights);
  assert.deepEqual(m1.w, m2.w, 'fit is deterministic');
  assert.equal(m1.nSamples, 60);
  const okScore = scoreFeatures(m1.w, { outcome: 2, toolFailRate: 0, turns: 3, toolUses: 4 });
  const errScore = scoreFeatures(m1.w, { outcome: 0, toolFailRate: 0, turns: 8, toolUses: 6 });
  assert.ok(okScore > errScore, `ok (${okScore.toFixed(2)}) must outrank error (${errScore.toFixed(2)})`);
  assert.ok(okScore > 0.6, 'ok runs score high');
  assert.ok(errScore < 0.4, 'error runs score low');
  assert.ok(m1.trainRmse < 0.35, `train RMSE sane (${m1.trainRmse})`);
  assert.ok(m1.holdoutRmse !== undefined && m1.holdoutRmse! < 0.4, `holdout RMSE sane (${m1.holdoutRmse})`);
});

test('fitRewardModel: empty input yields zero weights without throwing', () => {
  const m = fitRewardModel([], []);
  assert.equal(m.nSamples, 0);
  assert.equal(m.holdoutRmse, undefined);
});

/* -------- scoring scale -------- */

test('scoreFeatures: output bounded in [0,1], monotone in outcome', () => {
  const w: [number, number, number, number, number] = [2, -1, 0.1, 0.1, -0.5];
  const s0 = scoreFeatures(w, { outcome: 0, toolFailRate: 0, turns: 1, toolUses: 1 });
  const s2 = scoreFeatures(w, { outcome: 2, toolFailRate: 0, turns: 1, toolUses: 1 });
  assert.ok(s0 >= 0 && s2 <= 1);
  assert.ok(s2 > s0);
});

/* -------- DPO export -------- */

test('exportDpoPairs: in-bucket gold pairs + cross-bucket same-template pairs; unrelated cross-bucket excluded', () => {
  const labels = [mkLbl('a', 5), mkLbl('b', 5), mkLbl('c', 3), mkLbl('d', 1), mkLbl('e', 1)];
  // a,b,c ok (5/5/3 stars); d error on the SAME bench template as a;
  // e error on a DIFFERENT task entirely
  const insights = [
    mkIns('a', 'ok'), mkIns('b', 'ok'), mkIns('c', 'ok'), mkIns('d', 'error'), mkIns('e', 'error'),
  ];
  const sameTask = 'Read C:/x/behave-target1.txt with read_file, then reply ONLY the line count';
  const otherTask = 'Completely different mission statement about something else entirely here';
  const tasks: Record<string, string> = { a: sameTask, b: sameTask, c: sameTask, d: sameTask, e: otherTask };
  const pairs = exportDpoPairs(
    labels,
    insights,
    (s) => tasks[s] ?? '',
    (s) => 'answer of ' + s,
  );
  const inBucket = pairs.filter((p) => p.rejectedSession === 'c');
  const crossOk = pairs.filter((p) => p.rejectedSession === 'd');
  const crossBad = pairs.filter((p) => p.rejectedSession === 'e');
  assert.ok(inBucket.length >= 2, `in-bucket a/b-vs-c pairs, got ${inBucket.length}`);
  assert.ok(crossOk.length >= 1, `same-template cross-bucket a/b-vs-d, got ${crossOk.length}`);
  assert.equal(crossBad.length, 0, 'unrelated-task cross-bucket pairs excluded');
  for (const p of pairs) assert.ok(p.gap >= 0.4);
});
