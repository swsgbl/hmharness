import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryStore, TrajectoryRecorder } from '../trajectory.ts';
import { listTrajectoryIds, replayTrajectory, exportCognitiveState, purgeCognitiveState } from '../governance.ts';
import { CognitiveMemory } from '../memory.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gov-'));
}

async function seed(home: string, id: string, goal?: string): Promise<void> {
  const rec = new TrajectoryRecorder(id, 's1', { id: 'terminal', version: '1' }, goal ? { id: 'g', description: goal } : undefined);
  rec.record({ action: { id: 'a1', type: 'read_file', args: { path: 'x' } }, outcome: 'success', evidence: ['e1'], prediction: { claim: 'will work', confidence: 0.8 } });
  rec.record({ action: { id: 'a2', type: 'run_command', args: { cmd: 'y' } }, outcome: 'failure', evidence: [] });
  const store = new TrajectoryStore(home);
  await store.append(rec.finish(false));
}

test('replay: list + step-by-step view with predictions', async () => {
  const home = await tmpHome();
  await seed(home, 'trj-r1', 'fix the bug');
  const list = await listTrajectoryIds(home);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'trj-r1');
  assert.equal(list[0].actions, 2);
  const view = await replayTrajectory(home, 'trj-r1');
  assert.ok(view);
  assert.equal(view?.goal, 'fix the bug');
  assert.equal(view?.steps.length, 2);
  assert.equal(view?.steps[0].actionType, 'read_file');
  assert.equal(view?.steps[0].prediction?.confidence, 0.8);
  assert.equal(view?.steps[1].outcome, 'failure');
  const latest = await replayTrajectory(home, 'latest');
  assert.equal(latest?.trajectoryId, 'trj-r1');
  assert.equal(await replayTrajectory(home, 'nope'), null);
  await rm(home, { recursive: true, force: true });
});

test('export: single-file bundle contains verbatim memory/audit jsonl', async () => {
  const home = await tmpHome();
  await seed(home, 'trj-e1');
  const mem = new CognitiveMemory(home);
  await mem.write({ layer: 'semantic', content: 'lesson learned', source: 't', provenance: 'p', confidence: 0.8, environment: 'terminal', session: 's' });
  const { file, export: exp } = await exportCognitiveState(home, join(home, 'bundle.json'));
  assert.ok(existsSync(file));
  assert.equal(exp.trajectoryCount, 1);
  assert.equal(exp.memoryLineCount, 1);
  assert.match(exp.memoryJsonl, /lesson learned/);
  const round = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(round.trajectories.length, 1);
  assert.equal(round.trajectories[0].steps[0].action.type, 'read_file');
  await rm(home, { recursive: true, force: true });
});

test('purge: refuses without the exact token, deletes only cognitive store with it', async () => {
  const home = await tmpHome();
  await seed(home, 'trj-p1');
  const mem = new CognitiveMemory(home);
  await mem.write({ layer: 'semantic', content: 'x', source: 's', provenance: 'p', confidence: 1, environment: 'terminal', session: 's' });
  const refused = await purgeCognitiveState(home, 'yes');
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /purge-cognitive/);
  assert.ok(existsSync(join(home, 'cognitive', 'trajectories')));
  const done = await purgeCognitiveState(home, 'purge-cognitive');
  assert.equal(done.ok, true);
  assert.ok(done.removed.includes('cognitive/trajectories'));
  assert.equal(existsSync(join(home, 'cognitive', 'trajectories')), false);
  assert.equal(existsSync(join(home, 'cognitive', 'memory')), false);
  await rm(home, { recursive: true, force: true });
});
