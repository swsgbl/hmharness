import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignCredit, CONTRIBUTOR_KINDS } from '../credit-assignment.ts';
import { CognitiveLedger } from '../ledger.ts';

/** Build a ledger where `good` always precedes confirmed predictions and
 *  `bad` always precedes failed ones, plus noise events. */
function buildLedger(): CognitiveLedger {
  const l = new CognitiveLedger();
  const at = (i: number) => new Date(1_700_000_000_000 + i * 1_000).toISOString();
  let seq = 0;
  const good = l.append('memory.promoted', 'mem:good', { at: at(seq++) });
  const confirmed1 = l.append('prediction.made', 'act:a', { at: at(seq++), confidence: 0.8 });
  void good;
  void confirmed1;
  return l;
}

test('credit-assignment: lift direction, support honesty, observational label', () => {
  const l = new CognitiveLedger();
  const at = (i: number) => new Date(1_700_000_000_000 + i * 1_000).toISOString();
  // pattern: memory.promoted -> confirmed ; belief.revised -> failed ; skill.promoted (once = below support)
  let i = 0;
  for (let round = 0; round < 4; round++) {
    l.append('memory.promoted', 'mem:' + round, { at: at(i++) });
    const m = l.append('prediction.made', 'act:x', { at: at(i++), confidence: 0.8 });
    l.append('prediction.confirmed', 'act:x', { at: at(i++), parentSeq: m.seq });
    l.append('belief.revised', 'act:y', { at: at(i++) });
    const f = l.append('prediction.made', 'act:y', { at: at(i++), confidence: 0.7 });
    l.append('prediction.failed', 'act:y', { at: at(i++), parentSeq: f.seq });
  }
  l.append('skill.promoted', 'skill:lonely', { at: at(i++) });
  const m = l.append('prediction.made', 'act:z', { at: at(i++), confidence: 0.6 });
  l.append('prediction.confirmed', 'act:z', { at: at(i++), parentSeq: m.seq });

  // windowSize 2 is the discriminating width for this period-6 pattern:
  // [mem, made] CONFIRMED vs [belief, made] FAILED - a wider window would
  // bleed the previous round's tail into both sides (the window IS an
  // analysis hyperparameter, deliberately exposed)
  const r = assignCredit(l, { windowSize: 2, minSupport: 3 });
  assert.equal(r.nature, 'observational', 'the label is by construction');
  assert.equal(r.outcomeEvents, 9);
  assert.ok(r.baselineConfirmedRate > 0);
  const mem = r.ranked.find((x) => x.kind === 'memory.promoted')!;
  assert.ok(mem, 'memory.promoted appears in the ranking');
  assert.ok(mem.association > 0, 'preceding confirmed predictions yields positive lift');
  assert.equal(mem.insufficientEvidence, false);
  const belief = r.ranked.find((x) => x.kind === 'belief.revised')!;
  assert.ok(belief.association < 0, 'preceding failed predictions yields negative lift');
  const skill = r.ranked.find((x) => x.kind === 'skill.promoted')!;
  assert.equal(skill.insufficientEvidence, true, 'single-window support reports insufficient evidence, not a number');
  assert.equal(skill.association, 0);
  // ranking places the strong signals above the insufficient one
  assert.ok(r.ranked.findIndex((x) => x.kind === 'memory.promoted') < r.ranked.findIndex((x) => x.kind === 'skill.promoted'));
});

test('credit-assignment: empty ledger and outcome-less ledger are honest no-ops', () => {
  const empty = assignCredit(new CognitiveLedger());
  assert.equal(empty.outcomeEvents, 0);
  assert.equal(empty.ranked.length, 0);
  assert.equal(empty.baselineConfirmedRate, 0);
  const l = buildLedger(); // one made prediction, no outcomes
  const r = assignCredit(l);
  assert.equal(r.outcomeEvents, 0);
  assert.ok(Array.isArray(CONTRIBUTOR_KINDS) && CONTRIBUTOR_KINDS.length >= 10);
});
