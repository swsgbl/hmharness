/**
 * The fine-tune gate's decisions (2026-11-27).
 *
 * On one machine the provider had retired its fine-tuning service, and for
 * 50 days the evolution daemon ran the gate after every cycle: it read a
 * 150 MB pairs file, made three API calls, failed at the upload - exit code
 * 0, no record, and the log showed the first lines of the output rather than
 * the last. Each rule below is the answer to one part of that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gate from '../finetune-gate.ts';
import { ZHIPU_BACKEND, readLocalFineTuneJobs, recordFineTuneJob, type FineTuneBackend } from '../cloud-finetune.ts';

const at = (iso: string) => Date.parse(iso);
const row = (time: string, extra: object = {}) => ({ id: 'x', time, ...extra }) as gate.LedgerRow;
const H = 3_600_000;

/* ---------------- a retired provider ---------------- */

test('a retired backend: not before the date, retired from it on; a backend without the fact never is', () => {
  assert.equal(gate.isFineTuneRetired(ZHIPU_BACKEND, new Date('2026-11-15T23:59:59Z')), false);
  assert.equal(gate.isFineTuneRetired(ZHIPU_BACKEND, new Date('2026-11-16T00:00:00Z')), true);
  assert.equal(gate.isFineTuneRetired(ZHIPU_BACKEND, new Date('2027-01-01T00:00:00Z')), true);
  const live: FineTuneBackend = { ...ZHIPU_BACKEND, retired: undefined };
  assert.equal(gate.isFineTuneRetired(live, new Date('2027-01-01T00:00:00Z')), false);
  assert.equal(gate.fineTuneRetirementNotice(live), null, 'nothing to say for a live backend');
});

test('the retirement notice names the provider, the date, where it says so, its wording, and that the data stays', () => {
  const notice = gate.fineTuneRetirementNotice(ZHIPU_BACKEND, new Date('2026-11-27T00:00:00Z'))!;
  assert.match(notice, /智谱（bigmodel\.cn）的微调服务已下线（2026-11-16 起）/);
  assert.ok(notice.includes(ZHIPU_BACKEND.retired!.source), 'the source is quoted');
  assert.ok(notice.includes(ZHIPU_BACKEND.retired!.quote), 'the provider wording is verbatim');
  assert.match(notice, /dpo-pairs\.jsonl.*原样保留/);
  assert.equal(gate.fineTuneRetirementNotice(ZHIPU_BACKEND, new Date('2026-10-01T00:00:00Z')), null, 'nothing said before the date');
});

/* ---------------- the gate ---------------- */

test('without --submit nothing is gated (staging is free and always allowed)', () => {
  const rows = [row('2026-11-01T00:00:00Z', { status: 'queued' })];
  assert.deepEqual(gate.decideFineTuneGate(rows, { submit: false, auto: false, cooldownDays: 7, now: at('2026-11-01T01:00:00Z') }), { ok: true });
});

test('kill switch: finetune.auto=false refuses a submit whatever the ledger says', () => {
  const d = gate.decideFineTuneGate([], { submit: true, auto: false, cooldownDays: 7, now: at('2026-11-27T00:00:00Z') });
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.reason, /自动微调已关闭/);
});

test('cooldown counts REAL submissions only: 7 days after one, a submit waits; a failed attempt does not lock it out', () => {
  const real = (days: number) => [row(new Date(at('2026-11-27T00:00:00Z') - days * 24 * H).toISOString(), { status: 'deploy-cancelled' })];
  const now = at('2026-11-27T00:00:00Z');
  const opts = { submit: true, auto: undefined, cooldownDays: 7, now };
  const inside = gate.decideFineTuneGate(real(3), opts);
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.match(inside.reason, /冷却中（上次提交 7 天内）/);
  assert.deepEqual(gate.decideFineTuneGate(real(7), opts), { ok: true }, 'exactly at the cooldown: due');
  // a real submission 30 days back and a failed attempt 25 hours back: due
  assert.deepEqual(gate.decideFineTuneGate([
    ...real(30),
    row(new Date(now - 25 * H).toISOString(), { status: 'staged' }),
  ], opts), { ok: true });
});

test('a FAILED attempt waits a day: staged and upload-failed alike, once a day at most', () => {
  const now = at('2026-11-27T00:00:00Z');
  const opts = { submit: true, auto: undefined, cooldownDays: 7, now };
  for (const status of ['staged', 'upload-failed']) {
    const blocked = gate.decideFineTuneGate([row(new Date(now - 2 * H).toISOString(), { status })], opts);
    assert.equal(blocked.ok, false, status);
    if (!blocked.ok) assert.match(blocked.reason, new RegExp(`上次尝试失败不满 24 小时（${status}）`));
    assert.deepEqual(gate.decideFineTuneGate([row(new Date(now - 24 * H).toISOString(), { status })], opts), { ok: true }, status + ': a day later it is due again');
  }
  // the wait is configurable
  const quick = gate.decideFineTuneGate([row(new Date(now - 3 * H).toISOString(), { status: 'staged' })], { ...opts, retryHours: 2 });
  assert.deepEqual(quick, { ok: true });
});

test('a ledger row dated in the future (clock skew) never blocks and never counts as a submission', () => {
  const now = at('2026-11-27T00:00:00Z');
  const opts = { submit: true, auto: undefined, cooldownDays: 7, now };
  assert.deepEqual(gate.decideFineTuneGate([row('2026-12-01T00:00:00Z', { status: 'running' })], opts), { ok: true });
});

/* ---------------- reusing uploads ---------------- */

test('uploads are reused only for the same pairs, only from a failed attempt, the latest one wins', () => {
  const rows = [
    row('2026-11-01T00:00:00Z', { status: 'staged', pairsDigest: 'aaa', trainFile: 'file-old', evalFile: 'eval-old' }),
    row('2026-11-02T00:00:00Z', { status: 'staged', pairsDigest: 'bbb', trainFile: 'file-new', evalFile: 'eval-new' }),
    row('2026-11-03T00:00:00Z', { status: 'upload-failed', pairsDigest: 'bbb', trainFile: 'file-train-only' }),
  ];
  assert.deepEqual(gate.reusableUploads(rows, 'aaa'), { trainFile: 'file-old', evalFile: 'eval-old' });
  // the latest failed attempt for these rows got the train file up and not the eval one
  assert.deepEqual(gate.reusableUploads(rows, 'bbb'), { trainFile: 'file-train-only', evalFile: null });
  assert.deepEqual(gate.reusableUploads(rows, 'ccc'), {}, 'other pairs: upload');
  // a real submission's files are not reused
  assert.deepEqual(gate.reusableUploads([row('2026-11-01T00:00:00Z', { status: 'succeeded', pairsDigest: 'aaa', trainFile: 'f' })], 'aaa'), {});
});

test('the digest follows the rows: either file changing changes it', () => {
  const d = gate.pairsDigest('a\n', 'b\n');
  assert.equal(gate.pairsDigest('a\n', 'b\n'), d, 'stable');
  assert.notEqual(gate.pairsDigest('a2\n', 'b\n'), d);
  assert.notEqual(gate.pairsDigest('a\n', 'b2\n'), d);
  assert.notEqual(gate.pairsDigest('ab\n', ''), gate.pairsDigest('a\n', 'b\n'), 'no concatenation ambiguity');
});

/* ---------------- the streamed pairs read ---------------- */

test('the pairs read keeps the first rows in file order, counts the whole file, and survives a torn line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-pairs-'));
  try {
    const p = (i: number, split?: string) => JSON.stringify({ prompt: 'p' + i, chosen: 'c', rejected: 'r', ...(split ? { split } : {}) });
    const file = join(dir, 'dpo-pairs.jsonl');
    await writeFile(file, [
      p(1), p(2, 'eval'), '', p(3), '{"prompt":"torn', p(4, 'eval'), p(5), p(6), p(7, 'eval'), p(8, 'eval'),
    ].join('\n') + '\n', 'utf8');
    const head = await gate.readDpoPairsHead(file, { train: 2, eval: 1 });
    assert.deepEqual(head.train.map((r) => r.prompt), ['p1', 'p3'], 'the first two training rows');
    assert.deepEqual(head.eval.map((r) => r.prompt), ['p2'], 'the first validation row');
    assert.equal(head.trainTotal, 4, 'counted over the whole file');
    assert.equal(head.evalTotal, 4);
    assert.equal(head.bad, 1, 'the torn line is skipped and counted');
    const all = await gate.readDpoPairsHead(file, { train: 100, eval: 100 });
    assert.equal(all.train.length, 4);
    assert.equal(all.eval.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the ledger read skips a torn line instead of blanking the history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-ledger-'));
  try {
    await recordFineTuneJob(dir, { id: 'first', status: 'queued', model: 'm' });
    await writeFile(join(dir, 'evolution', 'finetune-jobs.jsonl'), (await readFileText(join(dir, 'evolution', 'finetune-jobs.jsonl'))) + '{"id":"torn"\n', 'utf8');
    const rows = await readLocalFineTuneJobs(dir);
    assert.deepEqual(rows.map((r) => r.id), ['first'], 'one bad line costs one line, not the ledger');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function readFileText(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}
