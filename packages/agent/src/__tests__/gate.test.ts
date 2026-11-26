/**
 * gate tests (2026-10-15, v0.24 P2A production opt-in): the conditioned
 * policy is the SINGLE implementation shared by the lab script and the
 * runner — pin its three-tier honesty here:
 *   pair with support >= MIN decides (both directions),
 *   else type with support >= MIN decides,
 *   else no evidence = allow (knownUnknown is an explore signal).
 *
 * 2026-11-26: and the two ways out of a block - evidence expires, and a
 * blocked action keeps one real run per task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conditionedPolicy, buildConditionedGate, GATE_MIN_SUPPORT, GATE_WINDOW_DAYS } from '../gate.ts';

const c = (s: number, f: number) => ({ s, f });
// the decision table on its own: no exploration (that is tested separately)
const TABLE = { explore: false };

test('policy: risky pair blocks where the type baseline would pass (the corpus read->edit shape)', () => {
  const typeStat = new Map([['edit_file', c(83, 17)]]); // type rate 0.83
  const pairStat = new Map([['read_file->edit_file', c(9, 7)]]); // pair rate 0.56, n=16
  const p = conditionedPolicy(typeStat, pairStat, 0.7, TABLE);
  assert.equal(p.check('read_file').allowed, true, 'read_file type baseline passes');
  const v = p.check('edit_file');
  assert.equal(v.allowed, false, 'the pair verdict blocks despite the benign type rate');
  if (!v.allowed) assert.match(v.reason, /read_file->edit_file/);
});

test('policy: benign pair passes where the type baseline would block (both directions)', () => {
  const typeStat = new Map([['run_command', c(60, 40)]]); // 0.6 < 0.7 would block
  const pairStat = new Map([['harmony_devices->run_command', c(12, 0)]]); // 1.00 passes
  const p = conditionedPolicy(typeStat, pairStat, 0.7, TABLE);
  assert.equal(p.check('harmony_devices').allowed, true);
  assert.equal(p.check('run_command').allowed, true, 'the benign pair rescues the risky type');
  // but run_command AFTER something else still falls back to the type verdict
  const p2 = conditionedPolicy(typeStat, pairStat, 0.7, TABLE);
  p2.check('read_file'); // unknown type = allow, becomes lastType
  const v2 = p2.check('run_command');
  assert.equal(v2.allowed, false, 'unsupported pair falls back to the type verdict');
});

test('policy: below MIN_SUPPORT never decides (a rate built on 2 observations is not a rate)', () => {
  const typeStat = new Map([['write_file', c(90, 10)]]);
  const pairStat = new Map([['write_file->edit_file', c(0, GATE_MIN_SUPPORT - 1)]]); // support 9: refuse-shaped but too thin
  const p = conditionedPolicy(typeStat, pairStat, 0.7, TABLE);
  assert.equal(p.check('write_file').allowed, true);
  assert.equal(p.check('edit_file').allowed, true, 'thin pair does not block; edit_file has no type evidence either');
});

test('policy: refusals do not advance the sequence (executions change the world, not attempts)', () => {
  const typeStat = new Map([['write_file', c(90, 10)]]);
  const pairStat = new Map([['write_file->edit_file', c(1, 11)]]); // 0.08, n=12 -> block
  const p = conditionedPolicy(typeStat, pairStat, 0.7, TABLE);
  assert.equal(p.check('write_file').allowed, true); // lastType = write_file
  assert.equal(p.check('edit_file').allowed, false); // pair blocks; lastType STAYS write_file
  const v = p.check('edit_file');
  assert.equal(v.allowed, false, 'the refusal did not advance lastType to edit_file (same context, same verdict)');
  assert.equal(p.stats().refusals, 2);
  assert.equal(p.stats().consults, 3);
});

// ---- the way out of a block (2026-11-26) ----

test('a blocked action type keeps ONE real run per task, then is refused again', () => {
  const typeStat = new Map([['web_search', c(0, 23)]]); // the real table on the machine this was found on
  const p = conditionedPolicy(typeStat, new Map(), 0.4);
  assert.equal(p.check('web_search').allowed, true, 'first time in this task: it runs, so the tables can learn');
  const v = p.check('web_search');
  assert.equal(v.allowed, false, 'and then the verdict stands');
  if (!v.allowed) assert.match(v.reason, /tends to fail/);
  assert.equal(p.check('web_search').allowed, false);
  assert.deepEqual([p.stats().explorations, p.stats().refusals, p.stats().consults], [1, 2, 3]);
});

test('exploration is one per blocked ACTION per task, whichever verdict blocked it (pair or type)', () => {
  const typeStat = new Map([['run_command', c(2, 20)]]); // 0.09: the type blocks
  const pairStat = new Map([['read_file->edit_file', c(0, 12)]]); // the pair blocks
  const p = conditionedPolicy(typeStat, pairStat, 0.4);
  assert.equal(p.check('read_file').allowed, true);
  assert.equal(p.check('edit_file').allowed, true, 'pair block: explored');
  assert.equal(p.check('edit_file').allowed, true, 'edit_file now follows itself - no pair evidence for that, no type evidence: allowed');
  assert.equal(p.check('run_command').allowed, true, 'type block: explored');
  assert.equal(p.check('run_command').allowed, false, 'then refused');
  assert.equal(p.stats().explorations, 2);
});

test('the real-run chance is not bought twice: an explored action that is blocked again right after stays blocked', () => {
  // 40 web_fetch failures in a row also teach the pair web_fetch->web_fetch to fail.
  // Keyed by verdict, the second attempt would be a NEW blocked pair and run again.
  const typeStat = new Map([['web_fetch', c(0, 40)]]);
  const pairStat = new Map([['web_fetch->web_fetch', c(0, 39)]]);
  const p = conditionedPolicy(typeStat, pairStat, 0.4);
  assert.equal(p.check('web_fetch').allowed, true, 'one real run');
  assert.equal(p.check('web_fetch').allowed, false, 'not a second one under the pair verdict');
  assert.equal(p.stats().explorations, 1);
});

test('without exploration a block is final (the behaviour before 0.23.56, kept for the lab script)', () => {
  const p = conditionedPolicy(new Map([['web_search', c(0, 23)]]), new Map(), 0.4, { explore: false });
  assert.equal(p.check('web_search').allowed, false);
  assert.equal(p.check('web_search').allowed, false);
});

/** One terminal trajectory with the given steps, started at `startedAt`, in the home's store. */
async function seedTrajectory(home: string, id: string, startedAt: string, steps: Array<{ type: string; ok: boolean }>): Promise<void> {
  const dir = join(home, 'cognitive', 'trajectories');
  await mkdir(dir, { recursive: true });
  const traj = {
    id, sessionId: `s-${id}`, startedAt, endedAt: startedAt,
    environment: { id: 'terminal', version: '1.0.0' },
    goal: { id: `goal-${id}`, description: 'seed' },
    steps: steps.map((s, i) => ({ step: i + 1, action: { id: `${id}-${i}`, type: s.type, args: {}, reason: 'seed' }, outcome: s.ok ? 'success' : 'failure', evidence: [], durationMs: 1 })),
    metrics: { actions: steps.length, successes: steps.filter((s) => s.ok).length, failures: steps.filter((s) => !s.ok).length, recoveries: 0, durationMs: 1 },
  };
  await writeFile(join(dir, `${id}.jsonl`), JSON.stringify(traj) + '\n', 'utf8');
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const manyFailures = (type: string): Array<{ type: string; ok: boolean }> => Array.from({ length: 40 }, () => ({ type, ok: false }));

test('builder: empty/unreadable corpus yields an all-allow gate (no evidence never blocks, never crashes)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-'));
  try {
    const gate = await buildConditionedGate(home, 0.7);
    assert.equal((await gate.check('write_file', {})).allowed, true);
    assert.equal((await gate.check('run_command', {})).allowed, true);
    const s = gate.stats();
    assert.equal(s.types, 0);
    assert.equal(s.refusals, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('builder: evidence expires - failures older than the window no longer block an action', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-'));
  try {
    // 40 failures, all older than the window: the action is allowed again
    await seedTrajectory(home, 'trj-old', daysAgo(GATE_WINDOW_DAYS + 5), manyFailures('web_search'));
    const gate = await buildConditionedGate(home, 0.4);
    assert.equal(gate.stats().types, 0, 'nothing from before the window is counted');
    assert.equal((await gate.check('web_search', {})).allowed, true);

    // the same failures, recent: blocked (after the one real run). Ten
    // trajectories, because the builder keeps a 70% train split (7 of 10)
    for (let i = 0; i < 10; i++) await seedTrajectory(home, `trj-new-${i}`, daysAgo(2), manyFailures('web_fetch'));
    const gate2 = await buildConditionedGate(home, 0.4);
    assert.equal(gate2.stats().types, 1, 'exactly the recent action type is counted');
    assert.equal((await gate2.check('web_fetch', {})).allowed, true, 'one real run');
    assert.equal((await gate2.check('web_fetch', {})).allowed, false, 'then refused');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('builder: an older failure recovers when successes follow it inside the window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-'));
  try {
    // the tool was broken, then fixed: ten trajectories of each, so the 70%
    // train split keeps a mix whatever the seeded shuffle picks
    for (let i = 0; i < 10; i++) await seedTrajectory(home, `trj-bad-${i}`, daysAgo(10), manyFailures('web_search'));
    for (let i = 0; i < 10; i++) await seedTrajectory(home, `trj-good-${i}`, daysAgo(1), Array.from({ length: 40 }, () => ({ type: 'web_search', ok: true })));
    const gate = await buildConditionedGate(home, 0.4);
    const s = gate.stats();
    assert.equal((await gate.check('web_search', {})).allowed, true);
    assert.equal((await gate.check('web_search', {})).allowed, true, 'not blocked at all: about half of the recent evidence is success');
    assert.equal(s.explorations, 0, 'so no exploration was needed');
    assert.equal(s.refusals, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
