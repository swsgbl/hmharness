import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mechanicalGate, parseVerdict, runPipeline, type PipelineReport } from '../pipeline.ts';
import type { LoopResult } from '@hmharness/kernel';

const fakeLoop = (script: Array<(directive: string) => Partial<LoopResult> & { text: string }>) => {
  let i = 0;
  return async (opts: { messages: Array<{ role: string; content: string }> }): Promise<LoopResult> => {
    const directive = opts.messages[opts.messages.length - 1].content;
    const s = script[Math.min(i++, script.length - 1)](directive);
    return {
      text: s.text,
      turns: s.turns ?? 1,
      toolUses: s.toolUses ?? 0,
      messages: [],
      usage: { promptTokens: 10, completionTokens: 10 },
      reason: s.reason ?? 'final',
    };
  };
};

const baseOpts = (home: string, runLoopImpl: never, over: Record<string, unknown> = {}) => ({
  task: 'make the widget robust',
  provider: { name: 'fake', baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never,
  registry: {} as never,
  ctx: { cwd: home, home } as never,
  model: 'm',
  home,
  runLoopImpl,
  ...over,
});

test('parseVerdict: exact contract line, absence = FAIL', () => {
  assert.equal(parseVerdict('evidence... VERDICT: PASS because tests green'), 'PASS');
  assert.equal(parseVerdict('verdict: fail - build broke'), 'FAIL');
  assert.equal(parseVerdict('no verdict line here'), 'FAIL', 'missing contract line is a FAIL');
});

test('mechanicalGate: asserts first, tool errors second, null when nothing to check', () => {
  const outs = [{ name: 'run_command', output: 'all 5 tests passed', isError: false }];
  assert.deepEqual(mechanicalGate(outs, [{ kind: 'contains', value: 'tests passed' }]), { pass: true, detail: 'mechanical assertions green (1)' });
  assert.equal(mechanicalGate(outs, [{ kind: 'contains', value: 'coverage 100%' }])!.pass, false);
  assert.equal(mechanicalGate(outs, [{ kind: 'not-contains', value: 'error' }])!.pass, true);
  assert.equal(mechanicalGate([{ name: 'x', output: 'boom', isError: true }])!.pass, false, 'errored tool fails the mechanical gate');
  assert.equal(mechanicalGate(outs), null, 'no asserts + no errors -> nothing mechanical');
});

test('runPipeline: happy path PASS, five stages, report persisted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pipe-'));
  try {
    const loop = fakeLoop([
      () => ({ text: '1. do x (verify: run y)' }),                      // plan
      () => ({ text: 'implemented, build green', toolUses: 2 }),        // code
      () => ({ text: 'probes: edge -> ok vs expected ok', toolUses: 1 }), // test
      () => ({ text: 'no significant findings' }),                      // review
      () => ({ text: 'evidence: probes green. VERDICT: PASS' }),        // judge
    ]);
    const r = await runPipeline(baseOpts(home, loop as never));
    assert.equal(r.status, 'completed');
    assert.equal(r.finalVerdict, 'PASS');
    assert.equal(r.repairsUsed, 0);
    assert.deepEqual(r.stages.map((s) => s.stage), ['plan', 'code', 'test', 'review', 'judge']);
    const files = await readdir(join(home, 'pipelines', r.pipelineId));
    assert.ok(files.includes('pipeline.report.json'));
    const persisted = JSON.parse(await readFile(join(home, 'pipelines', r.pipelineId, 'pipeline.report.json'), 'utf8')) as PipelineReport;
    assert.equal(persisted.finalVerdict, 'PASS');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('runPipeline: FAIL verdict triggers repair rounds up to ceiling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pipe2-'));
  try {
    // judge FAILs twice then PASSes on attempt 3; repairer runs between
    let judgeN = 0;
    const loop = (directive: string): Promise<LoopResult> => {
      void directive;
      judgeN++;
      return Promise.resolve({
        text: 'step', turns: 1, toolUses: 0, messages: [],
        usage: { promptTokens: 1, completionTokens: 1 }, reason: 'final',
      });
    };
    // build a scripted loop via fakeLoop instead: judge always sees 'judge' stage
    const scripted = fakeLoop([
      () => ({ text: 'plan' }),
      () => ({ text: 'code' }),
      () => ({ text: 'test failed: edge case broken' }),
      () => ({ text: 'finding: X broken' }),
      () => ({ text: 'VERDICT: FAIL - edge case' }),
      () => ({ text: 'repairer fixed X', toolUses: 1 }),
      () => ({ text: 'test now green' }),
      () => ({ text: 'finding: ok now' }),
      () => ({ text: 'VERDICT: FAIL again' }),
      () => ({ text: 'repairer round 2', toolUses: 1 }),
      () => ({ text: 'test green 2' }),
      () => ({ text: 'review clean' }),
      () => ({ text: 'VERDICT: PASS' }),
    ]);
    void loop;
    const r = await runPipeline(baseOpts(home, scripted as never, { maxRepairs: 2 }));
    assert.equal(r.finalVerdict, 'PASS');
    assert.equal(r.repairsUsed, 2);
    const repairStages = r.stages.filter((s) => s.stage === 'repairer');
    assert.equal(repairStages.length, 2);
    // test/review rerun after each repair
    assert.equal(r.stages.filter((s) => s.stage === 'judge').length, 3);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('runPipeline: device gate runs after test, feeds judge, costs no turns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pipe4-'));
  try {
    const gateCalls: number[] = [];
    const scripted = fakeLoop([
      () => ({ text: 'plan' }),
      () => ({ text: 'code', toolUses: 1 }),
      () => ({ text: 'probes green', toolUses: 1 }),
      () => ({ text: 'clean' }),
      () => ({ text: 'device evidence seen. VERDICT: PASS' }),
    ]);
    const r = await runPipeline(baseOpts(home, scripted as never, {
      deviceGate: {
        hdc: 'hdc', hap: 'x.hap', bundle: 'b', ability: 'a', expectLog: 'onCreate',
        runDeviceTestImpl: async () => {
          gateCalls.push(1);
          return [
            { step: 'install', pass: true, detail: 'success' },
            { step: 'launch', pass: true, detail: 'started' },
            { step: 'log-marker', pass: true, detail: 'found' },
            { step: 'uninstall', pass: true, detail: 'gone' },
          ];
        },
      },
    }));
    assert.equal(r.finalVerdict, 'PASS');
    assert.equal(gateCalls.length, 1, 'gate ran once (no repair loop)');
    const dev = r.stages.find((s) => s.stage === 'device');
    assert.ok(dev, 'device stage recorded');
    assert.equal(dev!.verdict, 'PASS');
    assert.equal(dev!.turns, 0, 'no model turns spent on the gate');
    const files = await readdir(join(home, 'pipelines', r.pipelineId));
    assert.ok(files.some((f) => f.includes('device')), 'device stage persisted');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('runPipeline: failing device step is visible to the judge, judge still owns the verdict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pipe5-'));
  try {
    let judgeDirective = '';
    const scripted = fakeLoop([
      () => ({ text: 'plan' }),
      () => ({ text: 'code' }),
      () => ({ text: 'probes ok' }),
      () => ({ text: 'no findings' }),
      (directive) => { judgeDirective = directive; return { text: 'device failed but code is fine. VERDICT: FAIL - device unreachable' }; },
    ]);
    const r = await runPipeline(baseOpts(home, scripted as never, {
      maxRepairs: 0,
      deviceGate: {
        hdc: 'hdc', hap: 'x.hap', bundle: 'b', ability: 'a', expectLog: 'onCreate',
        runDeviceTestImpl: async () => [
          { step: 'install', pass: false, detail: 'no device found' },
        ],
      },
    }));
    const dev = r.stages.find((s) => s.stage === 'device');
    assert.equal(dev!.verdict, 'FAIL');
    assert.match(judgeDirective, /\[device #1\]/, 'judge saw the device evidence');
    assert.equal(r.finalVerdict, 'FAIL');
    assert.equal(r.repairsUsed, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('runPipeline: PASS + release binds checkpoint; FAIL never releases', async () => {
  const passHome = await mkdtemp(join(tmpdir(), 'hmh-pipe6-'));
  const passWs = await mkdtemp(join(tmpdir(), 'hmh-pipe6ws-'));
  const failHome = await mkdtemp(join(tmpdir(), 'hmh-pipe7-'));
  const failWs = await mkdtemp(join(tmpdir(), 'hmh-pipe7ws-'));
  try {
    // PASS path: release tick present, project record carries checkpoint+release
    const pass = await runPipeline({ ...baseOpts(passHome, fakeLoop([
      () => ({ text: 'plan' }),
      () => ({ text: 'code' }),
      () => ({ text: 'tests green' }),
      () => ({ text: 'clean' }),
      () => ({ text: 'VERDICT: PASS' }),
    ]) as never, { release: { version: 'v1.2.3', notes: 'first cut' } }), ctx: { cwd: passWs, home: passHome } as never });
    assert.equal(pass.finalVerdict, 'PASS');
    assert.ok(pass.release, 'release tick recorded');
    assert.match(pass.release!.checkpointId, /^cp_|^[0-9a-f]{10}$/);
    const { loadProject } = await import('../project.ts');
    const proj = await loadProject(passHome, pass.release!.projectId);
    assert.ok(proj, 'project record created');
    assert.equal(proj!.releases[0].version, 'v1.2.3');
    assert.equal(proj!.releases[0].checkpointId, pass.release!.checkpointId, 'release pinned to its checkpoint');

    // FAIL path: no release at all
    const fail = await runPipeline({ ...baseOpts(failHome, fakeLoop([
      () => ({ text: 'plan' }),
      () => ({ text: 'code' }),
      () => ({ text: 'tests broken' }),
      () => ({ text: 'finding' }),
      () => ({ text: 'VERDICT: FAIL' }),
    ]) as never, { release: { version: 'v9.9.9' }, maxRepairs: 0 }), ctx: { cwd: failWs, home: failHome } as never });
    assert.equal(fail.finalVerdict, 'FAIL');
    assert.equal(fail.release, undefined, 'FAIL never releases');
    assert.equal(await loadProject(failHome, 'proj_any'), null);
  } finally {
    await rm(passHome, { recursive: true, force: true });
    await rm(passWs, { recursive: true, force: true });
    await rm(failHome, { recursive: true, force: true });
    await rm(failWs, { recursive: true, force: true });
  }
});

test('runPipeline: global turn budget stops the chain honestly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pipe3-'));
  try {
    const scripted = fakeLoop([
      () => ({ text: 'plan', turns: 5 }),
      () => ({ text: 'code', turns: 5 }),
      () => ({ text: 'test', turns: 5 }),
      () => ({ text: 'never reached', turns: 5 }),
    ]);
    const r = await runPipeline(baseOpts(home, scripted as never, { maxTotalTurns: 12 }));
    assert.equal(r.status, 'budget');
    assert.equal(r.finalVerdict, 'none', 'no verdict when the budget cut the chain');
    assert.ok(r.stages.length < 4, 'judge never ran');
  } finally { await rm(home, { recursive: true, force: true }); }
});
