import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTargetRegistry, KNOWN_TARGETS, type TargetRegistration } from '../learning-targets.ts';
import { CognitiveLedger } from '../ledger.ts';
import type { Candidate, EvalResult, LearningDataset, LearningPlan } from '../continual.ts';

function fakeReg(target: LearningPlan['target'], opts: { evidence?: number; pass?: boolean } = {}): TargetRegistration {
  const mkCandidate = (): Candidate => ({ id: `cand-${target}`, plan: planFor(target), createdAt: new Date().toISOString(), status: 'draft' });
  return {
    target,
    trainer: async () => mkCandidate(),
    evaluator: async (c): Promise<EvalResult> => ({ candidateId: c.id, pass: opts.pass ?? true, metrics: { evidence: opts.evidence ?? 0.8 }, holdoutSize: 10 }),
    holdout: async () => ({ trajectories: [] }),
    promotionPolicy: { minEvidence: 0.5, requireHoldout: true, canaryShare: 0.2 },
    rollback: async () => undefined,
    lineage: { registeredAt: new Date().toISOString(), version: 1, source: 'test' },
  };
}

function planFor(target: LearningPlan['target']): LearningPlan {
  return { opportunityId: 'opp-1', target, payload: {} } as unknown as LearningPlan;
}

const TRAIN: LearningDataset = { trajectories: [] };

test('registry: the six-part contract is machine-checked with the field name', () => {
  const r = new LearningTargetRegistry();
  const bad = fakeReg('memory');
  delete (bad as unknown as Record<string, unknown>).rollback;
  assert.throws(() => r.register(bad), /missing 'rollback'/);
  const badCanary = fakeReg('memory');
  badCanary.promotionPolicy.canaryShare = 0;
  assert.throws(() => r.register(badCanary), /canaryShare/);
  r.register(fakeReg('memory'));
  assert.throws(() => r.register(fakeReg('memory')), /already registered/);
});

test('registry: coverage reports the honest gap', () => {
  const r = new LearningTargetRegistry();
  assert.equal(r.coverage().registered, 0);
  assert.equal(r.coverage().missing.length, KNOWN_TARGETS.length);
  r.register(fakeReg('memory'));
  r.register(fakeReg('skill'));
  const cov = r.coverage();
  assert.equal(cov.registered, 2);
  assert.ok(cov.missing.includes('model'));
  assert.deepEqual(r.list().sort(), ['memory', 'skill']);
});

test('registry: runCycle promote path with ledger mirroring (skill has vocabulary kinds)', async () => {
  const ledger = new CognitiveLedger();
  const r = new LearningTargetRegistry();
  r.ledger = ledger;
  r.register(fakeReg('skill', { evidence: 0.8, pass: true }));
  const out = await r.runCycle(planFor('skill'), TRAIN);
  assert.equal(out.decision, 'promote');
  assert.equal(out.bar, 0.6, 'memory/skill-class bar');
  assert.equal(out.candidate.status, 'promoted');
  assert.equal(out.reason, 'evidence 0.8 >= bar 0.6');
  const kinds = ledger.events().map((e) => e.kind);
  assert.deepEqual(kinds, ['skill.candidate', 'skill.promoted']);
});

test('registry: reject path - failed holdout refuses regardless of evidence', async () => {
  const ledger = new CognitiveLedger();
  const r = new LearningTargetRegistry();
  r.ledger = ledger;
  r.register(fakeReg('skill', { evidence: 0.99, pass: false }));
  const out = await r.runCycle(planFor('skill'), TRAIN);
  assert.equal(out.decision, 'reject');
  assert.match(out.reason, /holdout evaluation failed/);
  const kinds = ledger.events().map((e) => e.kind);
  assert.deepEqual(kinds, ['skill.candidate', 'skill.rejected']);
});

test('registry: the model target bar is STRICTLY higher - same evidence, different verdicts', async () => {
  const r = new LearningTargetRegistry();
  r.register(fakeReg('memory', { evidence: 0.8, pass: true }));
  r.register(fakeReg('model', { evidence: 0.8, pass: true }));
  const mem = await r.runCycle(planFor('memory'), TRAIN);
  const model = await r.runCycle(planFor('model'), TRAIN);
  assert.equal(mem.decision, 'promote', '0.8 clears the memory bar (0.6)');
  assert.equal(model.decision, 'reject', '0.8 does NOT clear the model bar (0.95) - weight changes stay last');
  assert.equal(model.bar, 0.95);
});

test('registry: targets without ledger vocabulary mirror nothing (workflow)', async () => {
  const ledger = new CognitiveLedger();
  const r = new LearningTargetRegistry();
  r.ledger = ledger;
  r.register(fakeReg('workflow', { evidence: 0.8, pass: true }));
  const out = await r.runCycle(planFor('workflow'), TRAIN);
  assert.equal(out.decision, 'promote');
  assert.equal(ledger.events().length, 0, 'no vocabulary kinds for workflow yet - mirror nothing, honestly');
});

test('registry: unregistered target refuses with the six-part hint', async () => {
  const r = new LearningTargetRegistry();
  await assert.rejects(() => r.runCycle(planFor('router'), TRAIN), /not registered/);
});
