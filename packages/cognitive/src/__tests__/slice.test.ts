import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerticalSlice, formatSliceReport, independentEvaluator, type SliceReport } from '../slice.ts';
import { TrajectoryStore, TrajectoryRecorder } from '../index.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'slice-'));
}

async function seedTrajectory(home: string, success: boolean): Promise<string> {
  const rec = new TrajectoryRecorder('trj-slice', 'ses-slice', { id: 'terminal', version: '1' }, { id: 'g', description: 'slice task' });
  rec.record({ action: { id: 'a1', type: 'write_file', args: { path: 'out.txt' }, reason: 'slice' }, outcome: success ? 'success' : 'failure', evidence: [], durationMs: 5 });
  const traj = rec.finish(success);
  await new TrajectoryStore(home).append(traj);
  return traj.id;
}

test('slice: full vertical run — stages present, learn keyed to the INDEPENDENT verdict', async () => {
  const home = await tmpHome();
  const ws = await mkdtemp(join(tmpdir(), 'slice-ws-'));
  await writeFile(join(ws, 'README.md'), '# ws', 'utf8');
  const trajId = await seedTrajectory(home, true);

  const report = await runVerticalSlice({
    home,
    cwd: ws,
    task: 'create out.txt with the number 42',
    act: async () => {
      // a REAL (host-bridged) act would run the agent loop; here the fake
      // act performs the actual work AND lies about it — to prove the
      // verdict below ignores the claim
      await writeFile(join(ws, 'out.txt'), '43', 'utf8'); // wrong content on purpose
      return { completed: true, claim: 'done perfectly, out.txt contains 42', trajectoryId: trajId, turns: 2, toolUses: 1 };
    },
    evaluate: independentEvaluator(async (task, cwd) => {
      // claim-blind: only task text + workspace — reads the real file
      const content = await readFile(join(cwd, 'out.txt'), 'utf8').catch(() => '');
      const pass = content.trim() === '42';
      return { pass, reasons: [pass ? 'out.txt contains 42' : `out.txt contains "${content.trim()}" not 42`] };
    }),
  });

  // all six stages ran, in order
  assert.deepEqual(report.stages.map((s) => s.stage), ['observe', 'goal', 'plan', 'act', 'evaluate', 'learn']);
  // the independent verdict caught the lie — the claim said perfect
  assert.equal(report.verdict.source, 'independent');
  assert.equal(report.verdict.pass, false);
  assert.match(report.verdict.reasons[0]!, /43/);
  assert.equal(report.agentClaim.completed, true); // the claim is recorded...
  // ...but LEARN keyed on the independent verdict (FAIL), not the claim
  const memText = await readFile(join(home, 'cognitive', 'memory', 'memory.jsonl'), 'utf8');
  const sliceEntry = memText.split('\n').filter((l) => l.includes('SLICE')).map((l) => JSON.parse(l)).pop();
  assert.match(sliceEntry.content, /FAIL\(independent\)/);
  assert.equal(sliceEntry.tags.includes('fail'), true);
  // formatter output names the verdict source
  const text = formatSliceReport(report);
  assert.match(text, /FAIL \(independent\)/);
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

test('slice: structural fallback is labeled honestly and cannot pose as independent', async () => {
  const home = await tmpHome();
  const ws = await mkdtemp(join(tmpdir(), 'slice-ws-'));
  const trajId = await seedTrajectory(home, true);
  const report: SliceReport = await runVerticalSlice({
    home, cwd: ws, task: 'do a thing',
    act: async () => ({ completed: true, claim: 'all good', trajectoryId: trajId }),
    // no evaluate: fallback must be structural
  });
  assert.equal(report.verdict.source, 'structural');
  assert.equal(report.verdict.pass, true);
  const memText = await readFile(join(home, 'cognitive', 'memory', 'memory.jsonl'), 'utf8');
  const sliceEntry = memText.split('\n').filter((l) => l.includes('SLICE')).map((l) => JSON.parse(l)).pop();
  assert.match(sliceEntry.content, /structural/);
  assert.equal(sliceEntry.confidence, 0.6); // lower trust than independent
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

test('slice: act throwing is contained — the slice still evaluates and learns', async () => {
  const home = await tmpHome();
  const ws = await mkdtemp(join(tmpdir(), 'slice-ws-'));
  await seedTrajectory(home, false);
  const report = await runVerticalSlice({
    home, cwd: ws, task: 'unstable task',
    act: async () => { throw new Error('agent loop exploded'); },
    evaluate: independentEvaluator(async () => ({ pass: false, reasons: ['workspace untouched'] })),
  });
  const actStage = report.stages.find((s) => s.stage === 'act')!;
  assert.equal(actStage.ok, false);
  assert.match(actStage.detail, /did not complete/);
  assert.equal(report.verdict.pass, false);
  assert.equal(report.stages.length, 6, 'learn stage must still close the loop');
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});
