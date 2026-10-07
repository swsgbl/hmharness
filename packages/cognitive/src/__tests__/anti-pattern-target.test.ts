import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTargetRegistry, registerAntiPatternTarget } from '../learning-targets.ts';
import type { CognitiveTrajectory, LearningDataset } from '../index.ts';

function traj(id: string, types: string[], success: boolean): CognitiveTrajectory {
  return {
    id,
    sessionId: 's-' + id,
    environment: { id: 'terminal', version: '1' },
    steps: types.map((type, i) => ({ step: i + 1, action: { id: `a${i}`, type, args: {} }, outcome: 'success' as const, evidence: [] })),
    metrics: { success, actions: types.length, elapsedMs: 1000, recoveryCount: 0 },
    startedAt: new Date().toISOString(),
  };
}

test('anti-pattern target: a failure signature generalizes when it fires on unseen failures but not successes', async () => {
  const r = new LearningTargetRegistry();
  const train: LearningDataset = {
    trajectories: [
      traj('t1', ['good', 'risky', 'boom'], false),
      traj('t2', ['good', 'risky', 'boom'], false),
      traj('t3', ['good', 'risky', 'boom'], false),
      traj('t4', ['good', 'safe'], true),
      traj('t5', ['good', 'fine'], true),
    ],
  };
  const holdout: LearningDataset = {
    trajectories: [
      traj('h1', ['good', 'risky', 'boom'], false),
      traj('h2', ['y', 'good', 'risky', 'boom'], false), // same signature after a different prefix
      traj('h3', ['good', 'safe'], true),
      traj('h4', ['good', 'fine'], true),
    ],
  };
  registerAntiPatternTarget(r, { holdout: async () => holdout, mining: { minFailures: 3 } });
  const out = await r.runCycle({ opportunityId: 'opp-anti', target: 'tool', payload: {} } as never, train);
  const m = out.evalResult?.metrics ?? {};
  // the top pattern is the LONGEST failure suffix ['good','risky','boom']; it fires on 2/2 unseen failures, 0/2 successes
  assert.equal(m.detection, 1, `detection should be 1 (got ${m.detection})`);
  assert.equal(m.control, 0);
  assert.equal(out.decision, 'promote', `evidence=1 clears the 0.6 bar (reason: ${out.reason})`);
});

test('anti-pattern target: a pattern that also fires on successes fails the control gate', async () => {
  const r = new LearningTargetRegistry();
  const train: LearningDataset = {
    trajectories: [
      traj('t1', ['common', 'end'], false),
      traj('t2', ['common', 'end'], false),
      traj('t3', ['common', 'end'], false),
    ],
  };
  const holdout: LearningDataset = {
    trajectories: [
      traj('h1', ['common', 'end'], false),
      traj('h2', ['common', 'end'], false),
      traj('h3', ['common', 'end'], true), // the "pattern" is just the normal ending - control must catch it
      traj('h4', ['common', 'end'], true),
    ],
  };
  registerAntiPatternTarget(r, { holdout: async () => holdout, mining: { minFailures: 3 } });
  const out = await r.runCycle({ opportunityId: 'opp-anti2', target: 'tool', payload: {} } as never, train);
  assert.equal(out.evalResult?.metrics.control, 1, 'fires on ALL the successes - it is the NORMAL ending, not a failure signal');
  assert.equal(out.evalResult?.metrics.evidence, 0, 'detection 1 - control 1 = 0');
  assert.equal(out.evalResult?.pass, false, 'the evaluator itself refuses zero evidence');
  assert.equal(out.decision, 'reject', 'the control gate keeps normal endings out');
});

test('anti-pattern target: thin-failure holdout rejects', async () => {
  const r = new LearningTargetRegistry();
  const train: LearningDataset = { trajectories: [traj('t1', ['a', 'boom'], false), traj('t2', ['a', 'boom'], false)] };
  const holdout: LearningDataset = { trajectories: [traj('h1', ['a', 'boom'], false)] }; // 1 failure only
  registerAntiPatternTarget(r, { holdout: async () => holdout, mining: { minFailures: 2 } });
  const out = await r.runCycle({ opportunityId: 'opp-anti3', target: 'tool', payload: {} } as never, train);
  assert.equal(out.decision, 'reject', 'single-failure holdout must not promote');
});
