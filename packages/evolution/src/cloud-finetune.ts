/**
 * Cloud fine-tuning client (2026-09-25, closes the auto-finetune loop).
 *
 * Direction (user, 2026-09-24/25): users configure ONE api key for whatever
 * provider they use, the backend adapts everything else. Fine-tuning is
 * therefore a PROVIDER-AGNOSTIC capability: a registry of backends, each
 * knowing one provider's endpoints, accepted data format and model rules.
 * Zhipu is the first backend because it is the only one verified live
 * (2026-09-25, real key, real uploads) - NOT because hmh targets Zhipu.
 * A user on any other provider gets a clean "not supported yet" status,
 * never an error, and everything else keeps working.
 *
 * Zhipu endpoint surface (verified live 2026-09-25):
 *   POST {apiBase}/files               multipart file + purpose=fine-tune
 *   POST {apiBase}/fine_tuning/jobs    {model, training_file, ...}
 *   GET  {apiBase}/fine_tuning/jobs    list (+ /{id}, /{id}/cancel, /{id}/events)
 * Cross-checked field names against zhipuai SDK 2.1.5 source. The DPO row
 * format is the LIVE-verified one, which differs from Zhipu's own docs
 * (see zhipuDpoJsonl).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DpoPair } from './reward-model.ts';
import type { ProviderConfig } from '@hmharness/kernel';
import { gateNow } from './finetune-gate.ts';

/* ---------------- backend abstraction ---------------- */

/** A provider that has switched its fine-tuning service off. Recorded as a
 *  fact with its source: the product must not keep knocking on a door the
 *  provider closed (see finetune-gate.ts). */
export interface FineTuneRetirement {
  /** ISO date from which the service is gone altogether. */
  since: string;
  /** where the provider says so. */
  source: string;
  /** the provider's wording, kept verbatim. */
  quote: string;
}

/** One provider's fine-tuning dialect. Everything provider-specific lives
 * here; the transport and job flow above it are generic. */
export interface FineTuneBackend {
  id: string;
  /** Chinese, human-facing (shown in `hmh auto-finetune` output). */
  label: string;
  /** Does this provider entry belong to this backend? */
  matches(baseUrl: string): boolean;
  /** Normalize a chat baseUrl into the fine-tuning API root. */
  apiBase(baseUrl: string): string;
  /** Fine-tune base candidates, the user's MAIN model first. */
  modelLadder(mainModel: string): string[];
  /** Serialize pairs into this provider's DPO JSONL. */
  dpoJsonl(pairs: Array<Pick<DpoPair, 'prompt' | 'chosen' | 'rejected'>>): string;
  /** Does this API error text mean "this model is not fine-tunable here"?
   *  Used by the zero-side-effect model probe. */
  modelRejected(errorText: string): boolean;
  /** Set once the provider retires the service. */
  retired?: FineTuneRetirement;
}

const zhipuDpoJsonl = (pairs: Array<Pick<DpoPair, 'prompt' | 'chosen' | 'rejected'>>): string => {
  const lines: string[] = [];
  for (const p of pairs) {
    if (!p.prompt.trim() || !p.chosen.trim() || !p.rejected.trim()) continue; // quality gate mirrors rl-governance
    // Live-verified 2026-09-25: the documented {"input":{"messages":...}}
    // nesting is REJECTED by the upload validator ("缺少messages字段"); the
    // accepted shape is top-level messages (MUST contain an assistant turn -
    // "缺少assistant角色" otherwise) plus preferred_output/non_preferred_output.
    // The assistant turn carries the chosen answer, so the row is a complete
    // good trajectory and the preference pair trains the separation.
    lines.push(JSON.stringify({
      messages: [
        { role: 'user', content: p.prompt },
        { role: 'assistant', content: p.chosen },
      ],
      preferred_output: [{ role: 'assistant', content: p.chosen }],
      non_preferred_output: [{ role: 'assistant', content: p.rejected }],
    }));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
};

/** Zhipu bigmodel.cn - verified live 2026-09-25 (models glm-5.3 rejected
 * "微调功能未开放", glm-4-air "微调模型不存在", glm-4-flash/glm-4.5-air pass). */
export const ZHIPU_BACKEND: FineTuneBackend = {
  id: 'zhipu',
  label: '智谱（bigmodel.cn）',
  matches: (baseUrl) => baseUrl.includes('bigmodel.cn'),
  apiBase: (baseUrl) => {
    let u = baseUrl.trim().replace(/\/+$/, '');
    u = u.replace(/\/coding\/paas\/v4$/, '/paas/v4');
    if (!/\/api\/paas\/v4$/.test(u)) {
      const m = u.match(/^(https?:\/\/[^/]+)/);
      if (!m) throw new Error('baseUrl 需以 http(s):// 开头: ' + baseUrl);
      u = m[1] + '/api/paas/v4';
    }
    return u;
  },
  modelLadder: (mainModel) => [...new Set([mainModel, 'glm-4-flash', 'glm-4.5-air'].filter(Boolean))],
  dpoJsonl: zhipuDpoJsonl,
  modelRejected: (text) => /微调模型不存在|微调功能未开放|无权限|not found/i.test(text),
  // Read on the provider's own page on 2026-11-27. Observed from this machine:
  // job creation answered HTTP 500 from 2026-09-26, uploads HTTP 500 from
  // 2026-10-08 on - a 3-row file included - while the evolution daemon kept
  // retrying every cycle for 50 days without one line that said why.
  retired: {
    since: '2026-11-16',
    source: 'https://docs.bigmodel.cn/cn/guide/tools/fine-tuning',
    quote: '微调与部署服务将于 2026 年 11 月 16 日下线。自 2026 年 10 月 16 日起，平台将不再支持创建、修改或删除微调任务、微调数据及私有实例，现有信息仍可查看。',
  },
};

/** Registry - one entry per provider dialect, matched against the user's
 * configured providers at runtime. Extend by adding a verified backend. */
export const FINE_TUNE_BACKENDS: FineTuneBackend[] = [ZHIPU_BACKEND];

/** Kept for the existing tests/callers: the Zhipu row format. */
export const toDpoJsonl = zhipuDpoJsonl;

export interface ResolvedFineTune {
  backend: FineTuneBackend;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  /** the user's MAIN model on that provider (first ladder candidate) */
  model: string;
}

/**
 * Match the user's providers against the backend registry. The CHAT route's
 * provider is tried first (fine-tune what you actually use), then any other
 * configured provider. Returns null when nothing matches - the caller
 * surfaces "not supported yet" as a status, never as an error.
 */
export function resolveFineTuneBackend(
  providers: Record<string, ProviderConfig> | undefined,
  chatProviderName?: string,
): ResolvedFineTune | null {
  if (!providers) return null;
  const ordered: Array<[string, ProviderConfig]> = [];
  if (chatProviderName && providers[chatProviderName]) ordered.push([chatProviderName, providers[chatProviderName]]);
  for (const [name, p] of Object.entries(providers)) {
    if (!ordered.some(([n]) => n === name)) ordered.push([name, p]);
  }
  for (const [name, p] of ordered) {
    if (!p.baseUrl || !p.apiKey) continue;
    const backend = FINE_TUNE_BACKENDS.find((b) => b.matches(p.baseUrl));
    if (backend) return { backend, providerName: name, apiKey: p.apiKey, baseUrl: p.baseUrl, model: p.model };
  }
  return null;
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

async function apiFetch(
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
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  filename: string;
  jsonl: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFile> {
  const url = opts.backend.apiBase(opts.baseUrl) + '/files';
  const form = new FormData();
  form.append('purpose', 'fine-tune');
  form.append('file', new Blob([opts.jsonl], { type: 'application/jsonl' }), opts.filename);
  const body = await apiFetch(url, opts.apiKey, { method: 'POST', body: form }, opts.fetchImpl ?? fetch);
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
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  model: string;
  trainingFile: string;
  validationFile?: string;
  suffix?: string;
  hyperparameters?: { batch_size?: number | 'auto'; learning_rate_multiplier?: number | 'auto'; n_epochs?: number | 'auto' };
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = opts.backend.apiBase(opts.baseUrl) + '/fine_tuning/jobs';
  const payload: Record<string, unknown> = { model: opts.model, training_file: opts.trainingFile };
  if (opts.validationFile) payload.validation_file = opts.validationFile;
  if (opts.suffix) payload.suffix = opts.suffix;
  if (opts.hyperparameters) payload.hyperparameters = opts.hyperparameters;
  return (await apiFetch(url, opts.apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

export async function listFineTuneJobs(opts: {
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob[]> {
  const url = opts.backend.apiBase(opts.baseUrl) + `/fine_tuning/jobs?limit=${opts.limit ?? 10}`;
  const body = await apiFetch(url, opts.apiKey, { method: 'GET' }, opts.fetchImpl ?? fetch);
  return ((body as { data?: FineTuneJob[] }).data ?? []) as FineTuneJob[];
}

export async function retrieveFineTuneJob(opts: {
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = opts.backend.apiBase(opts.baseUrl) + `/fine_tuning/jobs/${opts.jobId}`;
  return (await apiFetch(url, opts.apiKey, { method: 'GET' }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

export async function cancelFineTuneJob(opts: {
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<FineTuneJob> {
  const url = opts.backend.apiBase(opts.baseUrl) + `/fine_tuning/jobs/${opts.jobId}/cancel`;
  return (await apiFetch(url, opts.apiKey, { method: 'POST' }, opts.fetchImpl ?? fetch)) as FineTuneJob;
}

/* ---------------- model auto-selection ---------------- */

/**
 * Model auto-selection (decided 2026-09-25: novices never pick a
 * fine-tune base). Candidates: the user's MAIN model first - if the API
 * rejects it the ladder silently falls to the next documented fine-tunable
 * base. The probe POSTs {model, training_file:"file-probe-invalid"} -
 * model validation runs BEFORE file binding, so the request always fails
 * without creating anything, and the error text tells us whether the model
 * is usable.
 */
export async function probeFineTuneModel(opts: {
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<{ usable: boolean; reason?: string }> {
  const url = opts.backend.apiBase(opts.baseUrl) + '/fine_tuning/jobs';
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, training_file: 'file-probe-invalid' }),
  });
  const text = await res.text();
  if (res.ok) return { usable: true }; // unreachable in practice; harmless
  const rejected = opts.backend.modelRejected(text);
  return { usable: !rejected, reason: rejected ? text.slice(0, 160) : undefined };
}

/** Walk the ladder, return the first usable model plus why earlier ones
 * were skipped (surfaced as one Chinese line - the backend adapts, the
 * user reads, never chooses). */
export async function pickFineTuneModel(opts: {
  backend: FineTuneBackend;
  apiKey: string;
  baseUrl: string;
  mainModel: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  for (const m of opts.backend.modelLadder(opts.mainModel)) {
    const r = await probeFineTuneModel({ backend: opts.backend, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: m, fetchImpl: opts.fetchImpl });
    if (r.usable) return m;
    opts.log?.(`微调候选 ${m} 不可用（${(r.reason ?? '').replace(/^.*"message":"([^"]*)".*$/, '$1').slice(0, 60) || 'API 拒绝'}），自动改试下一个`);
  }
  throw new Error('所有微调候选模型均不可用——请在服务商控制台确认微调权限（可能需联系客服开放），或用 --model= 指定其他可微调模型');
}

/* ---------------- local job ledger ---------------- */

/** Append-only record of jobs this machine submitted (audit trail: what was
 * trained, on which file, when - survives provider console churn). The row is
 * stamped with the clock the gate reads (finetune-gate.ts gateNow): ledger
 * and decision must share one clock, or a cooldown compares two different
 * times. */
export async function recordFineTuneJob(home: string, job: FineTuneJob, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  const row = { time: new Date(gateNow()).toISOString(), ...job, ...extra };
  await appendFile(join(dir, 'finetune-jobs.jsonl'), JSON.stringify(row) + '\n', 'utf8');
}

export async function readLocalFineTuneJobs(home: string): Promise<Array<FineTuneJob & { time: string }>> {
  try {
    const text = await readFile(join(home, 'evolution', 'finetune-jobs.jsonl'), 'utf8');
    // one torn line must not blank the whole ledger: the cooldown below reads it,
    // and "no history" there means "may submit again today"
    return text.split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as FineTuneJob & { time: string }]; } catch { return []; }
    });
  } catch { return []; }
}
