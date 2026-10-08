import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchGate } from '../research-gate.ts';

test('research gate: full repo audit - all eight dimensions have data', () => {
  const report = researchGate((p) => {
    // simulate the full repo
    const known = [
      'packages/sandbox/src/broker.ts', 'packages/sandbox/src/redteam.ts', 'packages/sandbox/src/__tests__/broker2.test.ts',
      'packages/observability/src/recorder.ts', 'packages/cognitive/src/evalset.ts', 'packages/lsp/src/__tests__/lsp.test.ts',
      'scripts/skill-generalization-lab.mts', 'scripts/real-cycle-multiseed.mts', 'packages/cognitive/src/skill-compiler.ts',
      'packages/cognitive/src/abstract-actions.ts', 'scripts/prediction-to-action.mts',
      'packages/evaluation/src/metrics.ts',
      'packages/cognitive/src/ledger.ts', 'packages/cognitive/src/credit-assignment.ts',
      'packages/cognitive/src/evidence-ledger.ts', 'packages/cognitive/src/world-model.ts',
      'website/evidence/index.html',
    ];
    return known.includes(p);
  });
  assert.equal(report.summary.total, 8, 'eight dimensions');
  assert.equal(report.summary.hasData, 8, 'all have data in the full repo');
  assert.equal(report.summary.needsData, 0);
  for (const f of report.findings) {
    assert.equal(f.status, 'has-data', `${f.dimension} should have data`);
    assert.ok(f.evidence.length > 0, `${f.dimension} evidence list non-empty`);
  }
});

test('research gate: empty repo - all dimensions report NEEDS-DATA with gaps', () => {
  const report = researchGate(() => false);
  assert.equal(report.summary.hasData, 0);
  assert.equal(report.summary.needsData, 8);
  for (const f of report.findings) {
    assert.equal(f.status, 'needs-data');
    assert.ok(f.gap.length > 0, `${f.dimension} gap is stated`);
    assert.deepEqual(f.evidence, []);
  }
});

test('research gate: partial - mixed verdicts per dimension', () => {
  const report = researchGate((p) => p.includes('sandbox') || p.includes('ledger'));
  const safety = report.findings.find((f) => f.dimension === 'safety');
  assert.equal(safety?.status, 'has-data', 'safety has broker+redteam');
  const transfer = report.findings.find((f) => f.dimension === 'transfer');
  assert.equal(transfer?.status, 'needs-data', 'transfer modules missing');
  assert.match(transfer?.gap ?? '', /Transfer OS 2\.0/);
});
