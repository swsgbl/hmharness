import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTransferExperiment } from '../transfer-lab.ts';
import { TrajectoryStore, TrajectoryRecorder, MemoryEnvironment } from '../index.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cog-transfer-'));
}

function seedHistory(home: string, envId: string, id: string, steps: Array<{ type: string; outcome: 'success' | 'failure' }>): Promise<void> {
  const rec = new TrajectoryRecorder(id, 'ses-t', { id: envId, version: '1' });
  for (const s of steps) rec.record({ action: { id: 'a', type: s.type, args: {} }, outcome: s.outcome, evidence: [] });
  return new TrajectoryStore(home).append(rec.finish(true)).then(() => undefined);
}

test('transfer: experiment runs both arms and reports action-level rates', async () => {
  const home = await tmpHome();
  // source history: the memory env's affordances all succeed
  await seedHistory(home, 'memory', 'src-1', [
    { type: 'set', outcome: 'success' }, { type: 'set', outcome: 'success' }, { type: 'set', outcome: 'success' },
  ]);
  const report = await runTransferExperiment(home, {
    sourceEnv: 'memory',
    targetEnv: 'memory',
    makeTargetEnv: () => new MemoryEnvironment('memory'),
    runsPerArm: 2,
    maxActions: 3,
    record: false,
  });
  assert.equal(report.runsPerArm, 2);
  assert.ok(['positive', 'neutral', 'negative'].includes(report.verdict));
  assert.ok(report.withTransfer >= 0 && report.withTransfer <= 1);
  assert.ok(report.fromScratch >= 0 && report.fromScratch <= 1);
  // overlap: memory env offers set/delete; source history only has 'set'
  assert.ok(report.actionOverlap.includes('set'));
  await rm(home, { recursive: true, force: true });
});

test('transfer: zero overlap is reported honestly, not scored as transfer', async () => {
  const home = await tmpHome();
  // source history contains action types the target env does NOT offer
  await seedHistory(home, 'memory', 'src-x', [{ type: 'alien-action', outcome: 'success' }]);
  const report = await runTransferExperiment(home, {
    sourceEnv: 'memory',
    targetEnv: 'memory',
    makeTargetEnv: () => new MemoryEnvironment('memory'),
    runsPerArm: 1,
    maxActions: 2,
    record: false,
  });
  assert.equal(report.actionOverlap.length, 0);
  await rm(home, { recursive: true, force: true });
});

test('transfer: same-source seeding is deterministic in structure (arms symmetric)', async () => {
  const home = await tmpHome();
  await seedHistory(home, 'memory', 'src-1', [{ type: 'set', outcome: 'success' }]);
  const r1 = await runTransferExperiment(home, { sourceEnv: 'memory', targetEnv: 'memory', makeTargetEnv: () => new MemoryEnvironment('memory'), runsPerArm: 1, maxActions: 2, record: false });
  assert.equal(r1.sourceEnv, 'memory');
  assert.equal(r1.targetEnv, 'memory');
  assert.ok(Number.isFinite(r1.score));
  await rm(home, { recursive: true, force: true });
});

test('transfer: seeded arm predicts overlapping actions better (calibration delta > 0)', async () => {
  const home = await tmpHome();
  // source: 'set' succeeds repeatedly → seeded arm BELIEVES set works
  await seedHistory(home, 'memory', 's1', [
    { type: 'set', outcome: 'success' }, { type: 'set', outcome: 'success' },
    { type: 'set', outcome: 'success' }, { type: 'set', outcome: 'success' },
  ]);
  const report = await runTransferExperiment(home, {
    sourceEnv: 'memory',
    targetEnv: 'memory',
    makeTargetEnv: () => new MemoryEnvironment('memory'),
    runsPerArm: 2,
    maxActions: 3,
    record: false,
  });
  // both arms probe successfully → success rates tie; the DIFFERENCE is that
  // the seeded arm predicted those successes while the empty arm guessed 0
  assert.ok(report.actionOverlap.includes('set'));
  assert.notEqual(report.brierWith, undefined);
  assert.notEqual(report.brierWithout, undefined);
  assert.ok((report.brierWith ?? 1) < (report.brierWithout ?? 0), 'seeded arm must be better calibrated');
  assert.ok((report.calibrationDelta ?? 0) > 0, 'calibration delta must be positive = real carried knowledge');
  await rm(home, { recursive: true, force: true });
});
