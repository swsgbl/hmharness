/**
 * three-arm v2 core tests — failure typing, HarmonyBench mapping, the
 * pre-registered population rule, and the seeds-parameterized statistics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  classifyFailure, harmonyBenchToTask, harmonyBenchTaskBytes,
  buildTaskSetHashV2, compareArmsV2, SEEDS_V2, EXPERIMENT_ID_V2, POPULATION_RULE,
} from '../three-arm-v2.ts';
import type { ExperimentTask, RunRecord } from '../three-arm.ts';

const task = (over: Partial<ExperimentTask> = {}): ExperimentTask => ({
  id: 't', prompt: 'p', tools: false, holdout: false, split: 'train', family: 'x', fileSha: '0',
  assertion: { expect: [] },
  ...over,
});

const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
  experimentId: EXPERIMENT_ID_V2, repoCommit: 'c', datasetHash: 'd',
  baseModel: { provider: 'p', id: 'm', sampling: 's' },
  arm: 'A', seed: 1, taskId: 't', holdoutClass: 'train',
  outcome: { success: false, environmentDeltaHash: 'x' },
  metrics: { cost: { promptTokens: null, completionTokens: null, totalTokens: null, usd: null }, wallMs: 0, toolCalls: 0, recoveries: 0, crashes: 0, falseCompletion: 0, predictedP: null, brier: null },
  safety: { backend: 'b', isolationLevel: 'i' },
  decision: 'measured', reason: 'exact mismatch: got "x"',
  ...over,
});

/* ---------------- failure typing ---------------- */

test('classifyFailure: success and each failure class', () => {
  assert.equal(classifyFailure(task(), rec({ outcome: { success: true, environmentDeltaHash: 'x' } })), null);
  assert.equal(classifyFailure(task(), rec()), 'exact-output');
  assert.equal(classifyFailure(task(), rec({ reason: 'regex mismatch: /x/' })), 'format');
  assert.equal(classifyFailure(task(), rec({ reason: 'missing "a" in output' })), 'content-marker');
  assert.equal(classifyFailure(task(), rec({ reason: 'none of the allowed markers found: a || b' })), 'content-marker');
  assert.equal(classifyFailure(task(), rec({ reason: 'forbidden marker present: a' })), 'forbidden');
});

test('classifyFailure: tool-use = tools task that never called a tool (v1 beh-t8-n anchor)', () => {
  const beh = task({ tools: true });
  assert.equal(classifyFailure(beh, rec({ metrics: rec().metrics, reason: 'exact mismatch: got "x"' })), 'tool-use'); // toolCalls=0
  const m = { ...rec().metrics, toolCalls: 2 };
  assert.equal(classifyFailure(beh, rec({ metrics: m, reason: 'exact mismatch: got "x"' })), 'exact-output'); // used tools, still failed exact
  const m0 = { ...rec().metrics, toolCalls: 0 };
  assert.equal(classifyFailure(beh, rec({ metrics: m0, reason: 'missing "a" in output' })), 'tool-use'); // precedence over detail
});

/* ---------------- HarmonyBench mapping ---------------- */

const hbCase = (over: Partial<Parameters<typeof harmonyBenchToTask>[0]> = {}) => ({
  id: 'exact-001', prompt: 'reply with exactly: HELLO',
  assertion: { type: 'exact' as const, value: 'HELLO' },
  category: 'exactness', needsTools: false,
  ...over,
});

test('harmonyBenchToTask: needsTools excluded, all four assertion types mapped', () => {
  assert.equal(harmonyBenchToTask(hbCase({ needsTools: true })), null);
  const exact = harmonyBenchToTask(hbCase())!;
  assert.equal(exact.id, 'hb-exact-001');
  assert.equal(exact.split, 'protect');
  assert.equal(exact.holdout, true);
  assert.equal(exact.family, 'hb-exactness');
  assert.equal(exact.assertion.expectExact, 'HELLO');
  assert.equal(exact.fileSha, createHash('sha256').update(harmonyBenchTaskBytes(hbCase())).digest('hex'));
  const rgx = harmonyBenchToTask(hbCase({ assertion: { type: 'regex', value: '^x$' } }))!;
  assert.equal(rgx.assertion.expectRegex, '^x$');
  const con = harmonyBenchToTask(hbCase({ assertion: { type: 'contains', value: '你好' } }))!;
  assert.deepEqual(con.assertion.expect, ['你好']);
  const not = harmonyBenchToTask(hbCase({ assertion: { type: 'not_contains', value: 'BAD' } }))!;
  assert.deepEqual(not.assertion.expectNone, ['BAD']);
});

test('harmonyBenchTaskBytes: round-trips through the .task line format', () => {
  const bytes = harmonyBenchTaskBytes(hbCase({ assertion: { type: 'exact', value: '{"ok":true}' } }));
  assert.equal(bytes, 'reply with exactly: HELLO\nexpect-exact: {"ok":true}\nholdout: true\n');
  // the parser (pick + strip surrounding quotes) recovers the original value
  const line = bytes.split('\n').find((l) => l.startsWith('expect-exact:'))!;
  const parsed = line.slice('expect-exact:'.length).trim().replace(/^"|"$/g, '');
  assert.equal(parsed, '{"ok":true}');
});

/* ---------------- datasetHash v2 ---------------- */

test('buildTaskSetHashV2: content-sensitive and order-insensitive', () => {
  const a = buildTaskSetHashV2([task({ id: 'a', prompt: 'p1' }), task({ id: 'b', prompt: 'p2' })]);
  const b = buildTaskSetHashV2([task({ id: 'b', prompt: 'p2' }), task({ id: 'a', prompt: 'p1' })]);
  assert.equal(a.datasetHash, b.datasetHash);
  const c = buildTaskSetHashV2([task({ id: 'a', prompt: 'CHANGED' }), task({ id: 'b', prompt: 'p2' })]);
  assert.notEqual(a.datasetHash, c.datasetHash);
  assert.equal(a.setId, 'three-arm-v2-2026-10-28');
});

/* ---------------- seeds-parameterized comparison ---------------- */

function mkRecord(arm: 'A' | 'B', seed: number, taskId: string, ok: boolean): RunRecord {
  return rec({ arm, seed, taskId, outcome: { success: ok, environmentDeltaHash: 'x' }, reason: ok ? 'ok' : 'exact mismatch: got "x"' });
}

test('compareArmsV2: 5 seeds counted, deterministic bootstrap, protocol identical to v1 shape', () => {
  const rs: RunRecord[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    rs.push(mkRecord('A', seed, 't1', true), mkRecord('B', seed, 't1', false));
    rs.push(mkRecord('A', seed, 't2', false), mkRecord('B', seed, 't2', true));
  }
  const c = compareArmsV2(rs, 'B', 'A', 'train');
  assert.equal(c.mcnemarPerSeed.length, 5);
  assert.deepEqual(c.mcnemarPerSeed.map((m) => m.seed), [1, 2, 3, 4, 5]);
  assert.equal(c.bootstrap.nTasks, 2);
  assert.equal(c.diff, 0); // 50% vs 50%
  assert.equal(c.significant, false);
  // reproducible: same input, same CI
  const c2 = compareArmsV2(rs, 'B', 'A', 'train');
  assert.deepEqual(c.bootstrap, c2.bootstrap);
});

test('compareArmsV2: discordant-cell support flag fires under the pre-registered bar', () => {
  const rs: RunRecord[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    rs.push(mkRecord('A', seed, 't1', true), mkRecord('B', seed, 't1', true)); // zero discordant
  }
  const c = compareArmsV2(rs, 'B', 'A', 'train');
  assert.equal(c.discordantCells, 0);
  assert.ok(c.needsData.some((n) => n.includes('discordant')));
});

/* ---------------- population rule ---------------- */

test('POPULATION_RULE: frozen values', () => {
  assert.equal(POPULATION_RULE.perClassCandidates, 2);
  assert.equal(POPULATION_RULE.maxClasses, 5);
  assert.ok(POPULATION_RULE.allRejected.includes('not deployable'));
  assert.equal(SEEDS_V2.length, 5);
});
