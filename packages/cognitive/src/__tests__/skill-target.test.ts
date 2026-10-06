import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearningTargetRegistry, registerSkillTarget } from '../learning-targets.ts';
import { CognitiveLedger } from '../ledger.ts';
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

test('skill target: the REAL trainer mines and the holdout replay decides', async () => {
  const ledger = new CognitiveLedger();
  const r = new LearningTargetRegistry();
  r.ledger = ledger;
  const train: LearningDataset = {
    trajectories: [
      traj('t1', ['alpha', 'beta', 'gamma', 'delta'], true),
      traj('t2', ['alpha', 'beta', 'gamma', 'other'], true),
      traj('t3', ['alpha', 'beta', 'gamma'], true),
      traj('t4', ['unrelated', 'steps'], true),
      traj('t5', ['alpha'], false), // failure: mining only reads successes
    ],
  };
  const holdout: LearningDataset = {
    trajectories: [
      traj('h1', ['alpha', 'beta', 'gamma', 'x'], true),
      traj('h2', ['alpha', 'beta', 'gamma'], true),
      traj('h3', ['nothing', 'shared'], true),
    ],
  };
  registerSkillTarget(r, { holdout: async () => holdout });
  const out = await r.runCycle({ opportunityId: 'opp-skill', target: 'skill', payload: {} } as never, train);
  // mined workflows exist; the top one replays in 2/3 holdout successes = 0.667 >= bar 0.6
  assert.equal(out.decision, 'promote', `expected promote, got ${out.decision} (${out.reason})`);
  assert.equal(out.bar, 0.6, 'skill-class bar from evidenceThreshold');
  const kinds = ledger.events().map((e) => e.kind);
  assert.deepEqual(kinds, ['skill.candidate', 'skill.promoted'], 'the real target mirrors its vocabulary kinds');
});

test('skill target: a workflow absent from the holdout rejects', async () => {
  const r = new LearningTargetRegistry();
  const train: LearningDataset = { trajectories: [traj('t1', ['p', 'q', 'r'], true), traj('t2', ['p', 'q', 'r', 's'], true)] };
  const holdout: LearningDataset = { trajectories: [traj('h1', ['a', 'b'], true), traj('h2', ['c', 'd'], true)] };
  registerSkillTarget(r, { holdout: async () => holdout });
  const out = await r.runCycle({ opportunityId: 'opp-2', target: 'skill', payload: {} } as never, train);
  assert.equal(out.decision, 'reject');
  assert.match(out.reason, /holdout evaluation failed|below bar/);
});

test('skill target: a holdout too thin to check is a rejection, not a pass', async () => {
  const r = new LearningTargetRegistry();
  const train: LearningDataset = { trajectories: [traj('t1', ['m', 'n'], true), traj('t2', ['m', 'n'], true)] };
  const holdout: LearningDataset = { trajectories: [traj('h1', ['m', 'n'], true)] }; // 1 success only
  registerSkillTarget(r, { holdout: async () => holdout });
  const out = await r.runCycle({ opportunityId: 'opp-3', target: 'skill', payload: {} } as never, train);
  assert.equal(out.decision, 'reject', 'single-success holdout must not promote');
});
