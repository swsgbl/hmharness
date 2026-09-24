import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeFineTuneBase,
  toDpoJsonl,
  estimateTokens,
  estimateTrainingCost,
  fineTuneModelLadder,
  pickFineTuneModel,
  probeFineTuneModel,
  uploadFineTuneFile,
  createFineTuneJob,
  recordFineTuneJob,
  readLocalFineTuneJobs,
  type FineTuneJob,
} from '../cloud-finetune.ts';
import type { DpoPair } from '../reward-model.ts';

test('normalizeFineTuneBase: coding endpoint, bare domain, passthrough', () => {
  // the user's chat route points at the CODING endpoint - fine-tuning does not
  assert.equal(normalizeFineTuneBase('https://open.bigmodel.cn/api/coding/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(normalizeFineTuneBase('https://open.bigmodel.cn/'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(normalizeFineTuneBase('https://open.bigmodel.cn/api/paas/v4/'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.throws(() => normalizeFineTuneBase('not-a-url'));
});

test('toDpoJsonl: provider DPO row format, empty rows dropped', () => {
  const pairs: DpoPair[] = [
    { prompt: 'task A', chosen: 'good', rejected: 'bad', chosenSession: 's1', rejectedSession: 's2', gap: 3 },
    { prompt: '', chosen: 'x', rejected: 'y', chosenSession: 's3', rejectedSession: 's4', gap: 1 }, // dropped
  ];
  const jsonl = toDpoJsonl(pairs);
  const rows = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, 'empty prompt row is dropped');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['input', 'non_preferred_output', 'preferred_output']);
  assert.deepEqual(rows[0].input.messages, [{ role: 'user', content: 'task A' }]);
  assert.deepEqual(rows[0].preferred_output, [{ role: 'assistant', content: 'good' }]);
  assert.deepEqual(rows[0].non_preferred_output, [{ role: 'assistant', content: 'bad' }]);
  assert.equal(toDpoJsonl([]), '');
});

test('cost helpers', () => {
  assert.ok(estimateTokens('abcd'.repeat(100)) >= 100);
  assert.equal(estimateTrainingCost(1_000_000, 3, 0.1), 300);
});

test('fineTuneModelLadder: main model first, deduped', () => {
  assert.deepEqual(fineTuneModelLadder('glm-5.3'), ['glm-5.3', 'glm-4-flash', 'glm-4.5-air']);
  assert.deepEqual(fineTuneModelLadder('glm-4-flash'), ['glm-4-flash', 'glm-4.5-air']);
});

/** mock fetch; handler sees (url, body) so probes of different models can
 * return different rejections. */
function mockFetch(handler: (url: string, body: string) => { status: number; body: string }, calls: Array<{ url: string; init: RequestInit }>) {
  return (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reqBody = typeof init.body === 'string' ? init.body : '';
    const r = handler(String(url), reqBody);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
}

test('pickFineTuneModel: main model rejected (live 2026-09-25 glm-5.3 behavior) falls to next', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = (_url: string, body: string) => {
    const model = (() => { try { return JSON.parse(body).model; } catch { return ''; } })();
    // glm-5.3: live behavior on this account; other models pass validation
    // and die at file binding ("参数校验解析异常")
    return model === 'glm-5.3'
      ? { status: 404, body: '{"error":{"code":"1600","message":"微调功能未开放，请联系客服开放"}}' }
      : { status: 400, body: '{"error":{"code":"400","message":"参数校验解析异常"}}' };
  };
  const model = await pickFineTuneModel({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', mainModel: 'glm-5.3', fetchImpl: mockFetch(handler, calls) });
  assert.equal(model, 'glm-4-flash');
  // probe never creates a job: invalid training_file id on purpose
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.training_file, 'file-probe-invalid');
});

test('pickFineTuneModel: main model usable -> returned directly', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = () => ({ status: 400, body: '{"error":{"code":"400","message":"参数校验解析异常"}}' });
  const model = await pickFineTuneModel({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', mainModel: 'glm-4-flash', fetchImpl: mockFetch(handler, calls) });
  assert.equal(model, 'glm-4-flash');
  assert.equal(calls.length, 1, 'ladder stops at first usable');
});

test('pickFineTuneModel: every candidate rejected -> throws with guidance', async () => {
  const handler = () => ({ status: 404, body: '{"error":{"code":"1608","message":"微调模型不存在"}}' });
  await assert.rejects(
    () => pickFineTuneModel({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', mainModel: 'glm-5.3', fetchImpl: mockFetch(handler, []) }),
    /微调/,
  );
});

test('probeFineTuneModel: 200 counts usable', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = () => ({ status: 200, body: '{"id":"job-x"}' });
  const r = await probeFineTuneModel({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', fetchImpl: mockFetch(handler, calls) });
  assert.deepEqual(r, { usable: true });
});

test('uploadFineTuneFile: multipart purpose=fine-tune, parses token stats', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = (url: string) => url.endsWith('/files')
    ? { status: 200, body: JSON.stringify({ id: 'file-1', bytes: 85, samples: 1, object: 'file', purpose: 'fine-tune', text_stats: [{ tokens: 9 }, { tokens: 7 }] }) }
    : { status: 404, body: '{}' };
  const up = await uploadFineTuneFile({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', filename: 't.jsonl', jsonl: '{}\n', fetchImpl: mockFetch(handler, calls) });
  assert.equal(up.id, 'file-1');
  assert.equal(up.tokens, 9, 'max of tokenizer stats');
  assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, 'Bearer k');
  const form = calls[0].init.body as FormData;
  assert.equal(form.get('purpose'), 'fine-tune');
});

test('createFineTuneJob: payload carries model + training_file; auth header set', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = () => ({ status: 200, body: JSON.stringify({ id: 'job-1', status: 'queued' }) });
  const job = await createFineTuneJob({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', trainingFile: 'file-1', suffix: 'hmh', fetchImpl: mockFetch(handler, calls) });
  assert.equal(job.id, 'job-1');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'glm-4-flash');
  assert.equal(body.training_file, 'file-1');
  assert.equal(body.suffix, 'hmh');
});

test('API errors surface the provider message', async () => {
  const handler = () => ({ status: 401, body: '{"error":{"code":"1000","message":"bad key"}}' });
  await assert.rejects(
    () => uploadFineTuneFile({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', filename: 't.jsonl', jsonl: '{}\n', fetchImpl: mockFetch(handler, []) }),
    /bad key/,
  );
});

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'hmh-ft-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('local job ledger roundtrip', async () => {
  assert.deepEqual(await readLocalFineTuneJobs(home), []);
  const job: FineTuneJob = { id: 'job-9', status: 'queued', model: 'glm-4-flash' };
  await recordFineTuneJob(home, job, { pairs: 123 });
  const rows = await readLocalFineTuneJobs(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'job-9');
  assert.ok(rows[0].time, 'timestamp recorded');
  assert.equal((rows[0] as unknown as { pairs: number }).pairs, 123);
  const raw = await readFile(join(home, 'evolution', 'finetune-jobs.jsonl'), 'utf8');
  assert.ok(raw.trim().split('\n').length === 1);
});
