/**
 * Cloud fine-tuning client (2026-09-25, closes the auto-finetune loop).
 *
 * Direction (user, 2026-09-24): users configure ONE api key, the backend
 * adapts everything else; local-GPU training was a developer experiment.
 * This module submits the accumulated DPO preference pairs to the provider's
 * fine-tuning API so "gets smarter as you use it" needs no local stack.
 *
 * Endpoint surface verified live 2026-09-25 against open.bigmodel.cn with a
 * real key (read-only probes + one 85-byte purpose=fine-tune upload):
 *   POST /api/paas/v4/files                     multipart file + purpose=fine-tune
 *   POST /api/paas/v4/fine_tuning/jobs          {model, training_file, ...}
 *   GET  /api/paas/v4/fine_tuning/jobs          list
 *   GET  /api/paas/v4/fine_tuning/jobs/{id}     retrieve
 *   POST /api/paas/v4/fine_tuning/jobs/{id}/cancel
 *   GET  /api/paas/v4/fine_tuning/jobs/{id}/events
 * Cross-checked field names against zhipuai SDK 2.1.5 source
 * (api_resource/fine_tuning/jobs/jobs.py). The DPO row format follows the
 * official guide: {"input":{messages,tools,parallel_tool_calls},
 * "preferred_output":[...],"non_preferred_output":[...]}.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DpoPair } from './reward-model.ts';

/** A fine-tunable model + how its jobs are priced. Prices change - the
 * caller renders the estimate, the catalog only carries what we verified. */
export interface FineTuneModelInfo {
  id: string;
  dpo: boolean;
  note: string;
}

/** Models verified as fine-tunable (guide + live probe 2026-09-25: bare
 * glm-4-air 404s "微调模型不存在", glm-4-flash passes model validation). */
export const FINE_TUNE_CATALOG: FineTuneModelInfo[] = [
  { id: 'glm-4-flash', dpo: true, note: '最便宜，LoRA 需开发者 Pro 权益' },
  { id: 'glm-4.5-air', dpo: false, note: '全参微调，对所有用户开放（SFT）' },
  { id: 'glm-4-air-250414', dpo: true, note: '全参微调' },
  { id: 'glm-4-air-x', dpo: true, note: '全参微调' },
];

export const DEFAULT_FINE_TUNE_MODEL = 'glm-4-flash';

/**
 * Model auto-selection (user direction 2026-09-25: novices must never pick
 * a fine-tune base). Candidates: the user's MAIN model first - if the API
 * rejects it (live probe 2026-09-25: glm-5.3 answers "微调功能未开放") the
 * ladder silently falls to the next documented fine-tunable base. The probe
 * POSTs {model, training_file:"file-probe-invalid"} - model validation runs
 * BEFORE file binding, so the request always fails without creating
 * anything, and the error text tells us whether the model is usable.
 */
export function fineTuneModelLadder(mainModel: string): string[] {
  const ladder = [mainModel, DEFAULT_FINE_TUNE_MODEL, 'glm-4.5-air'];
  return [...new Set(ladder.filter(Boolean))];
}

/** Zero-side-effect model probe (the request can never create a job - the
 * training_file id is invalid on purpose). "model rejected" vs "reached
 * file validation" is distinguishable in the error text. */
export async function probeFineTuneModel(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<{ usable: boolean; reason?: string }> {
  const url = normalizeFineTuneBase(opts.baseUrl) + '/fine_tuning/jobs';
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, training_file: 'file-probe-invalid' }),
  });
  const text = await res.text();
  if (res.ok) return { usable: true }; // unreachable in practice; harmless
  const rejected = /微调模型不存在|微调功能未开放|无权限|not found/i.test(text);
  return { usable: !rejected, reason: rejected ? text.slice(0, 160) : undefined };
}

/** Walk the ladder, return the first usable model plus why earlier ones
 * were skipped (surfaced as one Chinese line - the backend adapts, the
 * user reads, never chooses). */
export async function pickFineTuneModel(opts: {
  apiKey: string;
  baseUrl: string;
  mainModel: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  for (const m of fineTuneModelLadder(opts.mainModel)) {
    const r = await probeFineTuneModel({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: m, fetchImpl: opts.fetchImpl });
    if (r.usable) return m;
    opts.log?.(`微调候选 ${m} 不可用（${(r.reason ?? '').replace(/^.*"message":"([^"]*)".*$/, '$1').slice(0, 60) || 'API 拒绝'}），自动改试下一个`);
  }
  throw new Error('所有微调候选模型均不可用——请在智谱控制台确认微调权限（可能需联系客服开放），或用 --model= 指定其他可微调模型');
}

/**
 * Fine-tuning does not live on the coding endpoint: config.json points the
 * chat route at /api/coding/paas/v4, but the fine_tuning/file APIs sit on
 * /api/paas/v4. Strip the coding segment so the user's existing glm provider
 * entry works unchanged (zero new configuration).
 */
export function normalizeFineTuneBase(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, '');
  u = u.replace(/\/coding\/paas\/v4$/, '/paas/v4');
  if (!/\/api\/paas\/v4$/.test(u)) {
    const m = u.match(/^(https?:\/\/[^/]+)/);
    if (!m) throw new Error('baseUrl 需以 http(s):// 开头: ' + baseUrl);
    u = m[1] + '/api/paas/v4';
  }
  return u;
}

/** Serialize pairs into the provider DPO JSONL row format (pure). Accepts
 * the slim {prompt,chosen,rejected} rows the CLI persists - provenance
 * fields never leave the machine. */
export function toDpoJsonl(pairs: Array<Pick<DpoPair, 'prompt' | 'chosen' | 'rejected'>>): string {
  const lines: string[] = [];
  for (const p of pairs) {
    if (!p.prompt.trim() || !p.chosen.trim() || !p.rejected.trim()) continue; // quality gate mirrors rl-governance
    const row = {
      input: {
        messages: [{ role: 'user', content: p.prompt }],
        tools: [],
        parallel_tool_calls: false,
      },
      preferred_output: [{ role: 'assistant', content: p.chosen }],
      non_preferred_output: [{ role: 'assistant', content: p.rejected }],
    };
    lines.push(JSON.stringify(row));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Rough token estimate for a cost preview before upload (chars/4 heuristic;
 * the upload response returns exact per-tokenizer stats which the UI shows
 * alongside - this is only the pre-flight number). */
export function estimateTokens(jsonl: string): number {
  return Math.ceil(jsonl.length / 4);
}

/** Training cost = tokens × epochs × unit price. Pure math, price supplied
 * by the caller (it changes; we never bake it in as truth). */
export function estimateTrainingCost(tokens: number, epochs: number, pricePerKTokens: number): number {
  return Math.round(((tokens / 1000) * epochs * pricePerKTokens) * 100) / 100;
}

/* ---------------- HTTP layer (fetch, zero deps) ---------------- */

export interface UploadedFile {
  id: string;
  bytes: number;
  samples: number;
  /** tokens counted by the provider tokenizer (max of the reported stats). */
  tokens: number;
}

async function zhipuFetch(
  url: string,
  apiKey: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } };
    throw new Error(`HTTP ${res.status}: ${err?.error?.message ?? String(body).slice(0, 200)}`);
  }
  return body;
}

/** Upload a training/validation JSONL (free operation, verified live). */
export async function uploadFineTuneFile(opts: {
  apiKey: string;
  baseUrl: string;
  filename: string;
  jsonl: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFile> {
  const url = normalizeFineTuneBase(opts.baseUrl) + '/files';
  const form = new FormData();
  form.append('purpose', 'fine-tune');
  form.append('file', new Blob([opts.jsonl], { type: 'application/jsonl' }), opts.filename);
  const body = await zhipuFetch(url, opts.apiKey, { method: 'POST', body: form }, opts.fetchImpl ?? fetch);
  const o = body as { id: string; bytes: number; samples?: number; text_stats?: Array<{ tokens: number }> };
  const tokens = Math.max(0, ...(o.text_stats ?? []).map((t) => t.tokens ?? 0));
  return { id: o.id, bytes: o.bytes, samples: o.samples ?? 0, tokens };
}

export interface FineTuneJob {
  id: string;
  model?: string;
  status?: string;
  fine_tuned_model?: string;
  training_file?: string;
  created_at?: number;
  [k: string]: unknown;
}

/** Create a fine-tuning job (PAID - callers must gate behind explicit
 * submit consent; uploads alone are free). */
export async function createFineTuneJob(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  trainingFile: string;
  validationFile?: string;
  suffix?: string;
  hyperparameters?: { batch_size?: number | 'auto'; learning_rate_multiplier?: number | 'auto'; n_epochs?: number | 'auto' };
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = normalizeFineTuneBase(opts.baseUrl) + '/fine_tuning/jobs';
  const payload: Record<string, unknown> = { model: opts.model, training_file: opts.trainingFile };
  if (opts.validationFile) payload.validation_file = opts.validationFile;
  if (opts.suffix) payload.suffix = opts.suffix;
  if (opts.hyperparameters) payload.hyperparameters = opts.hyperparameters;
  return (await zhipuFetch(url, opts.apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

export async function listFineTuneJobs(opts: {
  apiKey: string;
  baseUrl: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob[]> {
  const url = normalizeFineTuneBase(opts.baseUrl) + `/fine_tuning/jobs?limit=${opts.limit ?? 10}`;
  const body = await zhipuFetch(url, opts.apiKey, { method: 'GET' }, opts.fetchImpl ?? fetch);
  return ((body as { data?: FineTuneJob[] }).data ?? []) as FineTuneJob[];
}

export async function retrieveFineTuneJob(opts: {
  apiKey: string;
  baseUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = normalizeFineTuneBase(opts.baseUrl) + `/fine_tuning/jobs/${opts.jobId}`;
  return (await zhipuFetch(url, opts.apiKey, { method: 'GET' }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

export async function cancelFineTuneJob(opts: {
  apiKey: string;
  baseUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = normalizeFineTuneBase(opts.baseUrl) + `/fine_tuning/jobs/${opts.jobId}/cancel`;
  return (await zhipuFetch(url, opts.apiKey, { method: 'POST' }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

/* ---------------- local job ledger ---------------- */

/** Append-only record of jobs this machine submitted (audit trail: what was
 * trained, on which file, when - survives provider console churn). */
export async function recordFineTuneJob(home: string, job: FineTuneJob, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  const row = { time: new Date().toISOString(), ...job, ...extra };
  await appendFile(join(dir, 'finetune-jobs.jsonl'), JSON.stringify(row) + '\n', 'utf8');
}

export async function readLocalFineTuneJobs(home: string): Promise<Array<FineTuneJob & { time: string }>> {
  try {
    const text = await readFile(join(home, 'evolution', 'finetune-jobs.jsonl'), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
