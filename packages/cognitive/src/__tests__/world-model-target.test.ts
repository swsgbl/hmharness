import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTargetRegistry, registerWorldModelTarget } from '../learning-targets.ts';
import { CognitiveLedger } from '../ledger.ts';
import type { CognitiveTrajectory, LearningDataset } from '../index.ts';

function traj(id: string, types: string[], success: boolean): CognitiveTrajectory {
  return {
    id,
    sessionId: 's-' + id,
    environment: { id: 'terminal', version: '1' },
    steps: types.map((type, i) => ({
      step: i + 1,
      action: { id: `a${i}`, type, args: {} },
      outcome: type === 'flaky' ? ('failure' as const) : ('success' as const),
      evidence: [],
    })),
    metrics: { success, actions: types.length, elapsedMs: 1000, recoveryCount: 0 },
    startedAt: new Date().toISOString(),
  };
}

test('world_model target: learned structure beats a fresh model on a structured holdout', async () => {
  const ledger = new CognitiveLedger();
  const r = new LearningTargetRegistry();
  r.ledger = ledger;
  // train: alpha usually succeeds, flaky usually fails (10 trajectories)
  const train: LearningDataset = { trajectories: Array.from({ length: 10 }, (_, i) => traj('t' + i, i % 2 ? ['alpha', 'alpha'] : ['flaky'], true)) };
  // holdout: same structure, unseen
  const holdout: LearningDataset = { trajectories: Array.from({ length: 10 }, (_, i) => traj('h' + i, i % 2 ? ['alpha'] : ['flaky', 'flaky'], true)) };
  registerWorldModelTarget(r, { environmentId: 'terminal', holdout: async () => holdout });
  const out = await r.runCycle({ opportunityId: 'opp-wm', target: 'world_model', payload: {} } as never, train);
  // the trained arm saw alpha->success/flaky->failure enough to calibrate;
  // the fresh arm predicts ~0.5 everywhere -> trained brier should be far lower
  const brierFresh = out.evalResult?.metrics.brierFresh ?? 1;
  const brierTrained = out.evalResult?.metrics.brierTrained ?? 1;
  assert.equal(brierFresh > brierTrained, true, `trained (${brierTrained}) should beat fresh (${brierFresh})`);
  assert.ok((out.evalResult?.metrics.checked ?? 0) >= 10, 'at least 10 holdout steps scored');
  assert.ok(out.evalResult !== undefined);
  // world_model has no ledger vocabulary kinds - nothing mirrored (stated, not faked)
  assert.equal(ledger.events().length, 0);
});

test('world_model target: structure-free data does not fake evidence', async () => {
  const r = new LearningTargetRegistry();
  // single-shuffled trajectories with no repeating structure
  const train: LearningDataset = { trajectories: [traj('t1', ['x1'], true), traj('t2', ['x2'], true)] };
  const holdout: LearningDataset = { trajectories: [traj('h1', ['y1'], true), traj('h2', ['y2'], true), traj('h3', ['y3'], true), traj('h4', ['y4'], true), traj('h5', ['y5'], true), traj('h6', ['y6'], true), traj('h7', ['y7'], true), traj('h8', ['y8'], true), traj('h9', ['y9'], true), traj('h10', ['y10'], true)] };
  registerWorldModelTarget(r, { environmentId: 'terminal', holdout: async () => holdout });
  const out = await r.runCycle({ opportunityId: 'opp-wm2', target: 'world_model', payload: {} } as never, train);
  // unseen action types -> trained model has no beliefs for them -> both arms tie -> no positive evidence
  const ev = out.evalResult?.metrics.evidence ?? 0;
  assert.ok(ev < 0.5, `unseen structure must not produce pass-level evidence (got ${ev})`);
});
