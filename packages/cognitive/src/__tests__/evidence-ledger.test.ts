import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineageId, comparableLineage, evidenceEnvelope, type EvidenceLineage } from '../evidence-ledger.ts';

function base(over: Partial<EvidenceLineage> = {}): EvidenceLineage {
  return {
    runId: 'run-1',
    modelId: 'glm-5.3',
    promptVersion: 'p-3',
    toolVersions: { kernel: '0.23.26', lsp: '0.23.26' },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

test('lineage: canonical id is order-independent, content-sensitive, createdAt-free', () => {
  const a = lineageId(base({ toolVersions: { kernel: '1', lsp: '2' } }));
  const b = lineageId(base({ toolVersions: { lsp: '2', kernel: '1' } }));
  assert.equal(a, b, 'key order does not change the identity');
  const c = lineageId(base({ toolVersions: { kernel: '1', lsp: '3' } }));
  assert.notEqual(a, c, 'content changes do');
  const d1 = lineageId(base({ createdAt: '2026-10-06T00:00:00Z' }));
  const d2 = lineageId(base({ createdAt: '2026-10-07T00:00:00Z' }));
  assert.equal(d1, d2, 'the same context re-stamped keeps its identity');
});

test('lineage: absent context fields are visible in the identity, not averaged away', () => {
  const withSeed = lineageId(base({ seed: 's-1' }));
  const withoutSeed = lineageId(base());
  assert.notEqual(withSeed, withoutSeed);
});

test('comparability: axis-explicit - named axes must match; unknown is not equal', () => {
  const a = base({ datasetHash: 'ds-1', seed: 'seed-1', split: 'train' });
  const same = base({ datasetHash: 'ds-1', seed: 'seed-1', split: 'train' });
  const otherSeed = base({ datasetHash: 'ds-1', seed: 'seed-2', split: 'train' });
  const noSplit = base({ datasetHash: 'ds-1', seed: 'seed-1' });
  const r1 = comparableLineage(a, same, ['datasetHash', 'seed', 'split']);
  assert.equal(r1.comparable, true);
  const r2 = comparableLineage(a, otherSeed, ['datasetHash', 'seed', 'split']);
  assert.equal(r2.comparable, false);
  assert.deepEqual(r2.mismatches, ['seed']);
  const r3 = comparableLineage(a, noSplit, ['datasetHash', 'seed', 'split']);
  assert.equal(r3.comparable, false, 'absent-on-one-side does not compare');
  assert.deepEqual(r3.mismatches, ['split']);
  const r4 = comparableLineage(a, otherSeed, []);
  assert.equal(r4.comparable, true, 'no axes named = nothing compared (vacuous, caller chose it)');
  // a model difference is invisible when modelId is not named
  const r5 = comparableLineage(a, base({ datasetHash: 'ds-1', seed: 'seed-1', split: 'train', modelId: 'other' }), ['datasetHash', 'seed']);
  assert.equal(r5.comparable, true);
});

test('envelope: lineage + payload + stamp, replayable', () => {
  const lin = base({ worldModelVersion: 7, codeWorldStateHash: 'abc123' });
  const env = evidenceEnvelope(lin, 'metrics', { successRate: 0.8 });
  assert.equal(env.kind, 'metrics');
  assert.equal(env.payload.successRate, 0.8);
  assert.equal(env.lineage.worldModelVersion, 7);
  assert.ok(env.lineageId.startsWith('lin-'));
  assert.ok(env.at);
});
