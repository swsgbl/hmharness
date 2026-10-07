import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitiveLedger } from '../ledger.ts';

test('ledger 2.0: the DAG vocabulary - supersession chains and belief versions', () => {
  const l = new CognitiveLedger();
  const v1 = l.append('belief.created', 'act:build', { beliefVersion: 1, confidence: 0.8 });
  const contra = l.append('belief.contradicted', 'act:build', { parentSeq: v1.seq, detail: 'observed failure cluster', beliefVersion: 1 });
  const v2 = l.append('belief.superseded', 'act:build', { parentSeq: contra.seq, detail: 'replaced by corrected confidence', beliefVersion: 2, confidence: 0.55 });
  const strategy = l.append('strategy.changed', 'planner', { parentSeq: v2.seq, detail: 'gate act:build behind verification' });
  const attribution = l.append('credit.attribution', 'world_model', { parentSeq: strategy.seq, detail: 'recovery avoided via gate' });
  // the replay path: cause -> effect, root to leaf
  assert.deepEqual(l.chain(attribution.seq).map((e) => e.kind), [
    'belief.created', 'belief.contradicted', 'belief.superseded', 'strategy.changed', 'credit.attribution',
  ]);
  assert.equal(l.events()[1].beliefVersion, 1);
  assert.equal(l.events()[2].beliefVersion, 2);
  // causal hypotheses join the same graph
  const hyp = l.append('causal.hypothesis', 'act:build', { parentSeq: v2.seq, detail: 'failure conditional on clean flag' });
  assert.deepEqual(l.descendants(v2.seq).map((e) => e.kind), ['strategy.changed', 'causal.hypothesis', 'credit.attribution'], 'BFS level order, both branches');
});

test('ledger 2.0: descendants walk branches breadth-first and stop at leaves', () => {
  const l = new CognitiveLedger();
  const root = l.append('belief.revised', 'act:x', {});
  const a = l.append('prediction.made', 'act:x', { parentSeq: root.seq });
  const b = l.append('prediction.made', 'act:y', { parentSeq: root.seq });
  const a1 = l.append('prediction.failed', 'act:x', { parentSeq: a.seq });
  const kids = l.descendants(root.seq);
  assert.deepEqual(kids.map((e) => e.seq), [a.seq, b.seq, a1.seq], 'both branches, then the grandchild');
  assert.deepEqual(l.descendants(a1.seq), [], 'a leaf has no descendants');
});
