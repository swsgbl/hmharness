import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@hmharness/kernel';
import { withTopologyGovernance, mapRole } from '../topology-live.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'topo-live-'));
}

// governance writes to homeDir() — point HMH_HOME at a temp dir per test
async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await tmpHome();
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

function fakeSpawn(result: string, isError = false): Tool {
  return {
    name: 'spawn_agent',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { output: result, isError };
    },
  } as Tool;
}

test('mapRole maps tool roles onto blueprint roles', () => {
  assert.equal(mapRole('planner'), 'planner');
  assert.equal(mapRole('tester'), 'verifier');
  assert.equal(mapRole('reviewer'), 'critic');
  assert.equal(mapRole('researcher'), 'researcher');
  assert.equal(mapRole('repairer'), 'implementer');
  assert.equal(mapRole('whatever'), 'implementer');
});

test('governance: spawn lifecycle lands in multi-agent.jsonl', async () => {
  await withHome(async () => {
    const wrapped = withTopologyGovernance(fakeSpawn('sub-result'));
    const r = await wrapped.execute({ task: 'explore deps', role: 'researcher', max_turns: 3 }, { cwd: '.', home: process.env.HMH_HOME! });
    assert.equal(r.output, 'sub-result');
    assert.ok(!r.isError, 'successful spawn must not be an error');
    const text = await readFile(join(process.env.HMH_HOME!, 'cognitive', 'multi-agent.jsonl'), 'utf8');
    const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(events[0].event, 'team.created');
    assert.equal(events[1].event, 'spawn.started');
    assert.equal(events[1].role, 'researcher');
    assert.equal(events[2].event, 'spawn.done');
  });
});

test('governance: failing spawns are recorded as failures, not hidden', async () => {
  await withHome(async () => {
    const wrapped = withTopologyGovernance(fakeSpawn('boom', true));
    const r = await wrapped.execute({ task: 'x', role: 'coder' }, { cwd: '.', home: process.env.HMH_HOME! });
    assert.equal(r.isError, true);
    const text = await readFile(join(process.env.HMH_HOME!, 'cognitive', 'multi-agent.jsonl'), 'utf8');
    assert.match(text, /spawn.failed/);
  });
});

test('governance: throwing inner tool falls back bare and still audits', async () => {
  await withHome(async () => {
    let calls = 0;
    const flaky: Tool = {
      name: 'spawn_agent',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        calls += 1;
        if (calls === 1) throw new Error('governance exploded before run');
        return { output: 'bare ok' };
      },
    } as Tool;
    const wrapped = withTopologyGovernance(flaky);
    const r = await wrapped.execute({ task: 't' }, { cwd: '.', home: process.env.HMH_HOME! });
    assert.equal(calls, 2); // governance failed, bare spawn ran
    assert.equal(r.output, 'bare ok');
  });
});

test('governance: shared budget denies spawns once exhausted', async () => {
  await withHome(async () => {
    const wrapped = withTopologyGovernance(fakeSpawn('ok'));
    const ctx = { cwd: '.', home: process.env.HMH_HOME! };
    // burn the 400-unit team budget with max_turns=12 spawns (34 spawns = 408)
    let denied = false;
    for (let i = 0; i < 40; i++) {
      const r = await wrapped.execute({ task: `t${i}`, max_turns: 12 }, ctx);
      if (r.isError && /budget exhausted/.test(String(r.output))) { denied = true; break; }
    }
    assert.ok(denied, 'over-budget spawn must be denied with the budget error');
  });
});
