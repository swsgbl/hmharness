import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMeaLoop, formatMeaReport, type MeaStep } from '../mea.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mea-'));
}

test('mea: full loop passes when audits pass; learner keys to audit verdicts', async () => {
  const home = await tmpHome();
  const report = await runMeaLoop({
    home,
    task: 'build and verify the module',
    decompose: async (t) => [
      { id: 's1', description: `write code for ${t}`, acceptance: 'file exists', status: 'pending', attempts: 0 },
      { id: 's2', description: 'run tests', acceptance: 'tests green', status: 'pending', attempts: 0 },
    ],
    execute: async (step) => ({ completed: true, claim: `did ${step.description} perfectly` }),
    audit: async (step) => ({ pass: true, reasons: [`${step.acceptance} met`] }),
  });
  assert.equal(report.verdict, 'complete');
  assert.equal(report.stepsPassed, 2);
  assert.equal(report.stepsFailed, 0);
  assert.equal(report.replansUsed, 0);
  // memory keyed to the AUDIT-derived verdict
  const memText = await readFile(join(home, 'cognitive', 'memory', 'memory.jsonl'), 'utf8');
  const entry = memText.split('\n').filter((l) => l.includes('MEA')).map((l) => JSON.parse(l)).pop();
  assert.match(entry.content, /MEA complete/);
  assert.equal(entry.tags.includes('mea'), true);
  // history carries auditor evidence, executor entries carry NO evidence
  const audits = report.history.filter((h) => h.kind === 'audit');
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.evidence?.source === 'auditor'));
  const execs = report.history.filter((h) => h.kind === 'execute');
  assert.ok(execs.every((e) => e.evidence === undefined), 'executor entries must carry no evidence');
  await rm(home, { recursive: true, force: true });
});

test('mea: audit failure -> bounded retry -> replan inserts revised step; claim can never pass', async () => {
  const home = await tmpHome();
  let auditCalls = 0;
  let executorClaims: string[] = [];
  const report = await runMeaLoop({
    home,
    task: 'flaky integration',
    budget: { maxAttemptsPerStep: 2, maxReplans: 1 },
    decompose: async () => [
      { id: 's1', description: 'step one', acceptance: 'criterion A', status: 'pending', attempts: 0 },
    ],
    execute: async (step, digest) => {
      executorClaims.push(step.id);
      // fresh executor sees ONLY its step + digest (no prior transcripts)
      assert.ok(!JSON.stringify(digest).includes('trajectory'), 'digest must not leak transcripts');
      return { completed: true, claim: 'I swear it works' };
    },
    audit: async (step) => {
      auditCalls += 1;
      // the claim "I swear it works" can NEVER influence this — claim-blind
      return step.id.includes('-r1') && step.attempts >= 1
        ? { pass: true, reasons: ['revised step meets criterion'] }
        : { pass: false, reasons: ['criterion A not met'] };
    },
  });
  // s1 fails twice (2 attempts), replan inserts s1-r1 which passes
  assert.equal(report.stepsFailed, 1, 'original step exhausted its attempts');
  assert.equal(report.replansUsed, 1);
  assert.equal(report.stepsPassed, 1, 'revised step passed');
  assert.equal(report.verdict, 'partial');
  assert.ok(auditCalls >= 3, `expected >=3 audit calls (2 original + 1 revised), got ${auditCalls}`);
  // executor ran for original twice + revised once
  assert.equal(executorClaims.filter((c) => c === 's1').length, 2);
  assert.ok(executorClaims.includes('s1-r1'));
  const replans = report.history.filter((h) => h.kind === 'replan');
  assert.equal(replans.length, 1);
  assert.match(replans[0].detail, /revised step/);
  await rm(home, { recursive: true, force: true });
});

test('mea: budget-exhausted when everything fails; replans bounded', async () => {
  const home = await tmpHome();
  const report = await runMeaLoop({
    home,
    task: 'impossible task',
    budget: { maxAttemptsPerStep: 1, maxReplans: 1 },
    decompose: async () => [
      { id: 's1', description: 'only step', acceptance: 'never', status: 'pending', attempts: 0 },
    ],
    execute: async () => ({ completed: true, claim: 'done' }),
    audit: async () => ({ pass: false, reasons: ['never met'] }),
  });
  assert.equal(report.verdict, 'budget-exhausted');
  assert.equal(report.stepsFailed, 2, 'original + revised both failed');
  assert.equal(report.replansUsed, 1, 'replans bounded at 1');
  const text = formatMeaReport(report);
  assert.match(text, /budget-exhausted/);
  assert.match(text, /✗/);
  await rm(home, { recursive: true, force: true });
});

test('mea: fresh executor context contract — digest only carries done/remaining', async () => {
  const home = await tmpHome();
  let seenDigest: unknown = null;
  await runMeaLoop({
    home,
    task: 'context hygiene',
    decompose: async () => [
      { id: 's1', description: 'first', acceptance: 'a', status: 'pending', attempts: 0 },
      { id: 's2', description: 'second', acceptance: 'b', status: 'pending', attempts: 0 },
    ],
    execute: async (step, digest) => {
      if (step.id === 's2') seenDigest = digest;
      return { completed: true, claim: 'ok' };
    },
    audit: async () => ({ pass: true, reasons: ['ok'] }),
  });
  assert.deepEqual(seenDigest, { done: ['first'], remaining: [] }, 'second step sees step 1 in done list and NO transcripts');
  await rm(home, { recursive: true, force: true });
});
