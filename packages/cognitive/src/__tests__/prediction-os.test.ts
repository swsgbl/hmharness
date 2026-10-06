import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PredictionOS,
  fromOutcome,
  fromDelta,
  fromEditResolution,
  ingestAdapted,
  CONFIRM_THRESHOLD,
} from '../prediction-os.ts';
import { CognitiveLedger } from '../ledger.ts';

test('prediction-os: record + write-once resolve + verdict threshold', () => {
  const pos = new PredictionOS();
  const a = pos.record({ domain: 'outcome', subject: 'act:build', predicted: 'success', confidence: 0.8 });
  const b = pos.record({ domain: 'outcome', subject: 'act:sign', predicted: 'failure', confidence: 0.3 });
  assert.ok(Object.isFrozen(a));
  const ra = pos.resolve(a.id, 'success', 0.2);
  assert.equal(ra.verdict, 'confirmed');
  assert.throws(() => pos.resolve(a.id, 'success', 0.1), 'second resolve refuses (write-once)');
  const rb = pos.resolve(b.id, 'success', 0.7);
  assert.equal(rb.verdict, 'failed');
  assert.equal(pos.unresolved().length, 0);
  assert.throws(() => pos.record({ domain: 'outcome', subject: 'x', predicted: 'y', confidence: 0.5, id: a.id }), 'ids are write-once');
  assert.ok(CONFIRM_THRESHOLD === 0.5);
});

test('prediction-os: summary math per domain - counts, mean error, generalized brier', () => {
  const pos = new PredictionOS();
  const p1 = pos.record({ domain: 'outcome', subject: 'act:a', predicted: 'success', confidence: 0.9 });
  pos.resolve(p1.id, 'success', 0.1); // confirmed
  const p2 = pos.record({ domain: 'outcome', subject: 'act:b', predicted: 'success', confidence: 0.9 });
  pos.resolve(p2.id, 'failure', 0.9); // failed
  pos.record({ domain: 'state-delta', subject: 'act:c', predicted: 'shape:x', confidence: 0.7 }); // unresolved
  const p4 = pos.record({ domain: 'edit', subject: 'file#Foo', predicted: 'rename(3e/2r)', confidence: 0.6 });
  pos.resolve(p4.id, 'jaccard 1.000', 0.0); // confirmed
  const s = pos.summary();
  assert.equal(s.total, 4);
  assert.equal(s.unresolved, 1);
  assert.deepEqual(
    [s.byDomain['outcome'].n, s.byDomain['outcome'].confirmed, s.byDomain['outcome'].resolved],
    [2, 1, 2],
  );
  // brier = mean(e^2) = (0.01 + 0.81) / 2 = 0.41
  assert.equal(s.byDomain['outcome'].brier, 0.41);
  assert.equal(s.byDomain['edit'].confirmed, 1);
  assert.equal(s.byDomain['state-delta'].resolved, 0);
});

test('prediction-os: worstErrors ranks the learning-signal feed', () => {
  const pos = new PredictionOS();
  const ids = ['p1', 'p2', 'p3'].map((id, i) => pos.record({ domain: 'outcome', subject: `act:${i}`, predicted: 'success', confidence: 0.6, id }));
  pos.resolve('p1', 'failure', 0.9);
  pos.resolve('p2', 'success', 0.1);
  pos.resolve('p3', 'failure', 0.6);
  const worst = pos.worstErrors(2);
  assert.deepEqual(worst.map((p) => p.id), ['p1', 'p3']);
  assert.equal(pos.worstErrors(10, 'edit').length, 0, 'domain filter works');
});

test('prediction-os: ledger mirroring chains resolved events to their made events', () => {
  const ledger = new CognitiveLedger();
  const pos = new PredictionOS();
  pos.ledger = ledger;
  const p = pos.record({ domain: 'state-delta', subject: 'act:build', predicted: 'shape:same', confidence: 0.8, runId: 'run-9' });
  pos.resolve(p.id, 'other-shape', 1.0);
  const evts = ledger.events();
  assert.equal(evts.length, 2);
  assert.equal(evts[0].kind, 'prediction.made');
  assert.equal(evts[1].kind, 'prediction.failed');
  assert.equal(evts[1].parentSeq, evts[0].seq, 'failed chains to its made event');
  const chain = ledger.chain(evts[1].seq);
  assert.deepEqual(chain.map((e) => e.kind), ['prediction.made', 'prediction.failed']);
});

test('prediction-os: domain adapters land the three families in one store', () => {
  const pos = new PredictionOS();
  // outcome: resolved success
  ingestAdapted(pos, fromOutcome({
    id: 'wm-1', claim: 'build usually succeeds', confidence: 0.85, actionType: 'act:build',
    createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
    actual: 'success', error: 0.15,
  }, 'run-1'));
  // delta: miss
  ingestAdapted(pos, fromDelta('act:write', 'shape:changed', 0.6, false));
  // edit: half-right blast radius
  ingestAdapted(pos, fromEditResolution(
    { editKind: 'rename', target: 'file:///w/x.ts#Foo', touchedEntities: ['a', 'b'], touchedRelations: ['a->b:defines'], newDiagnosticEstimate: 0.2 },
    { jaccard: 0.5, precision: 0.5, recall: 0.5, missed: ['c'], spurious: ['a'] },
  ));
  const s = pos.summary();
  assert.equal(s.total, 3);
  assert.equal(s.unresolved, 0);
  assert.equal(s.byDomain['outcome'].confirmed, 1);
  assert.equal(s.byDomain['state-delta'].confirmed, 0);
  assert.equal(s.byDomain['edit'].confirmed, 1, 'jaccard 0.5 -> error 0.5 <= threshold -> confirmed');
  const worst = pos.worstErrors(1)[0];
  assert.equal(worst.domain, 'state-delta', 'the missed shape prediction is the worst error');
});
