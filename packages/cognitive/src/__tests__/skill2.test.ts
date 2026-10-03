import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mineWorkflows, mineAntiPatterns } from '../skill-compiler.ts';
import { TrajectoryRecorder, type CognitiveTrajectory } from '../index.ts';

function traj(id: string, types: string[], success: boolean): CognitiveTrajectory {
  const rec = new TrajectoryRecorder(id, id, { id: 'terminal', version: '1' }, { id: 'g', description: 't' });
  types.forEach((t, i) => {
    rec.record({ action: { id: `a${i}`, type: t, args: {}, reason: 'r' }, outcome: i === types.length - 1 && !success ? 'failure' : 'success', evidence: [], durationMs: 1 });
  });
  return rec.finish(success);
}

test('skill2: n-gram workflows generalize across episodes with extra steps', () => {
  // three successes sharing the core run_command→edit_file→run_command but
  // each with a DIFFERENT extra step — exact-sequence compile() finds
  // nothing (3 distinct keys), n-gram mining finds the shared workflow
  const eps = [
    traj('t1', ['list_dir', 'run_command', 'edit_file', 'run_command', 'read_file'], true),
    traj('t2', ['run_command', 'edit_file', 'run_command', 'see_image'], true),
    traj('t3', ['run_command', 'edit_file', 'run_command'], true),
  ];
  const flows = mineWorkflows(eps, { minSupport: 3, nMin: 2, nMax: 4 });
  assert.ok(flows.length >= 1, `expected >=1 workflow, got ${flows.length}`);
  const top = flows[0]!;
  assert.deepEqual(top.steps, ['run_command', 'edit_file', 'run_command']);
  assert.equal(top.support, 3);
  // maximality: the contained bigrams (run|edit, edit|run) are dropped
  assert.ok(!flows.some((f) => f.steps.length === 2), 'contained bigrams must be dropped');
  // a pattern seen in only ONE episode is folklore, not a workflow
  const lonely = mineWorkflows([eps[0]!, traj('t4', ['write_file', 'run_command', 'read_file'], true)], { minSupport: 2 });
  assert.ok(!lonely.some((f) => f.steps.includes('write_file')));
});

test('skill2: anti-patterns mine the failure tail, never procedures', () => {
  const eps = [
    traj('f1', ['read_file', 'edit_file', 'run_command'], false),
    traj('f2', ['list_dir', 'edit_file', 'run_command'], false),
    traj('f3', ['run_command', 'run_command', 'edit_file', 'run_command'], false),
    traj('s1', ['edit_file', 'run_command', 'read_file'], true), // success: must not count
  ];
  const anti = mineAntiPatterns(eps, { minFailures: 3, nMax: 2 });
  assert.ok(anti.length >= 1);
  const top = anti[0]!;
  assert.deepEqual(top.pattern, ['edit_file', 'run_command']);
  assert.equal(top.failures, 3);
  assert.match(top.warning, /avoid/);
  // successes never contribute
  assert.ok(!anti.some((a) => a.pattern.join('|').includes('read_file') && a.failures > 0 && a.trajectoryIds.includes('s1')));
});
