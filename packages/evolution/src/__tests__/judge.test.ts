import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeVerdict, judgeSystemPrompt, judgeUserPrompt, judgeBucketMeans } from '../judge.ts';
import { exportDpoPairs, splitDpoPairs, auditDpoPairs, dedupeDpoPairs, type DpoPair } from '../reward-model.ts';

test('parseJudgeVerdict: clean, fenced, prose-wrapped, garbage', () => {
  assert.deepEqual(parseJudgeVerdict('{"score":4,"rationale":"correct but padded"}'), { score: 4, rationale: 'correct but padded' });
  assert.deepEqual(parseJudgeVerdict('```json\n{"score":5,"rationale":"exact answer"}\n```'), { score: 5, rationale: 'exact answer' });
  assert.deepEqual(parseJudgeVerdict('verdict follows: {"score":"2","rationale":"fabricated a file path"}'), { score: 2, rationale: 'fabricated a file path' });
  assert.deepEqual(parseJudgeVerdict('{"score":9,"rationale":"clamp"}'), { score: 5, rationale: 'clamp' });
  assert.equal(parseJudgeVerdict('no json here'), null);
  assert.equal(parseJudgeVerdict('{"rationale":"missing score"}'), null);
  assert.equal(parseJudgeVerdict(''), null);
});

test('judge prompts carry the rubric anchors and the transcript digest', () => {
  const sys = judgeSystemPrompt();
  assert.ok(/Score anchors/.test(sys) && /STRICT JSON/.test(sys));
  const u = judgeUserPrompt('do X', 'done: X', { outcome: 'ok', turns: 3, toolUses: 5, toolFailures: 1 });
  assert.ok(u.includes('TASK (verbatim)') && u.includes('outcome=ok turns=3') && u.includes('FINAL ANSWER'));
});

test('exportDpoPairs tags pair source from the label provenance map (J1)', () => {
  const labels = [
    { session: '2026-09-20T10-00-00-aaaaaa', score: 5, time: 't' },
    { session: '2026-09-20T10-05-00-bbbbbb', score: 2, time: 't' },
    { session: '2026-09-20T10-10-00-cccccc', score: 5, time: 't' },
    { session: '2026-09-20T10-15-00-dddddd', score: 2, time: 't' },
  ] as Array<{ session: string; score: number; time: string }>;
  const task = 'reply with exactly: HMH-OK (template prefix shared across bench sessions for cross-bucket pairing tests) ';
  const insights = labels.map((l, i) => ({ session: l.session, outcome: i < 2 ? 'ok' : 'timeout', turns: 1, toolUses: 0 }));
  const pairs = exportDpoPairs(labels, insights, () => task, () => 'answer', {
    sources: new Map([['2026-09-20T10-00-00-aaaaaa', 'human'], ['2026-09-20T10-05-00-bbbbbb', 'human'], ['2026-09-20T10-10-00-cccccc', 'judge'], ['2026-09-20T10-15-00-dddddd', 'judge']]),
  });
  assert.ok(pairs.length >= 2, 'judged variance produces pairs');
  for (const p of pairs) assert.ok(p.source === 'human' || p.source === 'judge' || p.source === 'mixed');
});

test('judgeBucketMeans separates ok from degraded when the judge is sane', () => {
  const judge = [
    { session: 'a', score: 5, note: '', model: 'm', time: 't' },
    { session: 'b', score: 4, note: '', model: 'm', time: 't' },
    { session: 'c', score: 2, note: '', model: 'm', time: 't' },
    { session: 'd', score: 1, note: '', model: 'm', time: 't' },
  ];
  const insights = [
    { session: 'a', outcome: 'ok' }, { session: 'b', outcome: 'ok' },
    { session: 'c', outcome: 'timeout' }, { session: 'd', outcome: 'error' },
  ];
  const m = judgeBucketMeans(judge, insights as never);
  assert.equal(m.ok, 4.5);
  assert.equal(m.degraded, 1.5);
});

test('in-bucket pairs survive label-file order and float epsilon (regression: gap sign + 3/5-1/5)', () => {
  // judge labels append low scores AFTER the 5-star human run: the lower
  // row iterates first, a.y - b.y was negative, and (1/5 - 3/5) floats to
  // 0.39999999999999997 - both silently dropped every star1-vs-star3 pair
  const labels = [
    { session: '2026-09-20T10-00-00-aaaaaa', score: 1, time: 't' },
    { session: '2026-09-20T10-05-00-bbbbbb', score: 3, time: 't' },
  ] as Array<{ session: string; score: number; time: string }>;
  const insights = [
    { session: '2026-09-20T10-00-00-aaaaaa', outcome: 'turn-budget', turns: 25, toolUses: 60 },
    { session: '2026-09-20T10-05-00-bbbbbb', outcome: 'turn-budget', turns: 25, toolUses: 60 },
  ];
  const pairs = exportDpoPairs(labels, insights, () => 'task', () => 'answer', {
    sources: new Map([['2026-09-20T10-00-00-aaaaaa', 'judge'], ['2026-09-20T10-05-00-bbbbbb', 'judge']]),
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].source, 'judge');
  assert.equal(pairs[0].gap, 0.4);
});

test('splitDpoPairs is deterministic and audit flags leakage (J1 dataset form)', () => {
  const mk = (i: number): DpoPair => ({ prompt: 'task ' + i, chosen: 'good ' + i, rejected: 'bad ' + i, chosenSession: 's' + i, rejectedSession: 'r' + i, gap: 0.4 });
  const pairs = Array.from({ length: 50 }, (_, i) => mk(i));
  const a = splitDpoPairs(pairs);
  const b = splitDpoPairs(pairs);
  assert.equal(a.train.length, b.train.length, 'deterministic');
  assert.equal(a.eval.length, b.eval.length);
  assert.equal(a.train.length + a.eval.length, 50);
  assert.ok(a.eval.length > 0 && a.eval.length < 50, 'roughly 80/20');
  // leakage: same prompt on both sides + a duplicate pair
  const leaked: DpoPair[] = [...a.eval, { ...mk(999), prompt: a.train[0].prompt }];
  const aud = auditDpoPairs([...a.train, ...a.train.slice(0, 1)], leaked);
  assert.equal(aud.evalPromptsLeakedIntoTrain >= 1, true);
  assert.equal(aud.duplicatePairs >= 1, true);
  const clean = auditDpoPairs(a.train, a.eval);
  assert.equal(clean.duplicatePairs, 0);
});

test('prompt-group split keeps one prompt on one side, and dedupe drops exact copies', () => {
  const mk = (i: number, chosenSession: string): DpoPair => ({ prompt: 'shared template ' + (i % 2), chosen: 'good ' + chosenSession, rejected: 'bad', chosenSession, rejectedSession: 'r' + chosenSession, gap: 0.4 });
  // 10 pairs over 2 prompts (5 pairs each) - all pairs of a prompt must land together
  const pairs = Array.from({ length: 10 }, (_, i) => mk(i % 2, 's' + i));
  const a = splitDpoPairs(pairs);
  const b = splitDpoPairs(pairs);
  assert.deepEqual(a.train.map((p) => p.chosenSession).sort(), b.train.map((p) => p.chosenSession).sort(), 'deterministic');
  const promptsInTrain = new Set(a.train.map((p) => p.prompt));
  for (const p of a.eval) assert.equal(promptsInTrain.has(p.prompt), false, 'no prompt on both sides');
  assert.equal(a.train.length + a.eval.length, 10);
  // dedupe: exact copies collapse, first wins
  const dup = [...pairs, { ...pairs[0] }];
  assert.equal(dedupeDpoPairs(dup).length, pairs.length);
});
