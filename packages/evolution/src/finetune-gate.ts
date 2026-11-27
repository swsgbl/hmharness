/**
 * The fine-tune gate's decisions, as pure functions (2026-11-27).
 *
 * `hmh auto-finetune` grew its rails inline - cooldown, one job at a time,
 * a kill switch - and the evolution daemon calls it after every cycle. What
 * it lacked showed on one machine over 50 days: the provider had switched its
 * fine-tuning service off, every cycle still read a 150 MB pairs file, made
 * three API calls and failed at the upload - exit code 0, nothing recorded,
 * and the daemon logged the first lines of the output rather than the last.
 * Nothing told anyone. These functions make each decision visible and testable:
 *
 *   - a RETIRED backend is answered without a single request;
 *   - a FAILED attempt throttles the next one (once a day), where a real
 *     submission keeps the cooldown it always had;
 *   - uploads are REUSED while the pairs are unchanged (13 attempts once
 *     left 13 identical training files in one account);
 *   - every failure is a ledger row.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { FineTuneBackend, FineTuneJob, FineTuneRetirement } from './cloud-finetune.ts';

export type LedgerRow = FineTuneJob & { time: string; [k: string]: unknown };

/** Ledger statuses that mean "tried, nothing was trained". */
export const FAILED_STATUSES: readonly string[] = ['staged', 'upload-failed'];

const HOURS = 3_600_000;
const DAYS = 86_400_000;

export type GateDecision = { ok: true } | { ok: false; reason: string };

/**
 * The clock the gate reads. A test sets HMH_FINETUNE_NOW to an ISO time to sit
 * inside a cooldown, before a retirement date or a day after a failure -
 * without waiting. Anything unparsable means the real clock.
 */
export function gateNow(): number {
  return Date.parse(process.env.HMH_FINETUNE_NOW ?? '') || Date.now();
}

/** Whether `submit` may go on. `now` is a timestamp so tests can sit anywhere. */
export function decideFineTuneGate(
  rows: LedgerRow[],
  opts: { submit: boolean; auto: boolean | undefined; cooldownDays: number; now: number; retryHours?: number },
): GateDecision {
  if (!opts.submit) return { ok: true };
  if (opts.auto === false) return { ok: false, reason: '自动微调已关闭（config finetune.auto=false）——本次跳过' };
  const lastReal = rows.findLast((r) => !FAILED_STATUSES.includes(String(r.status)));
  if (lastReal) {
    const age = opts.now - Date.parse(lastReal.time);
    if (Number.isFinite(age) && age >= 0 && age < opts.cooldownDays * DAYS) {
      return { ok: false, reason: `冷却中（上次提交 ${opts.cooldownDays} 天内）——本次跳过` };
    }
  }
  // A failed attempt costs nothing but time and bandwidth; retried every
  // cycle it was pure churn, so it waits a day. It does not count as a
  // submission: the retry that finally lands must not be locked out.
  const lastFailed = rows.findLast((r) => FAILED_STATUSES.includes(String(r.status)));
  if (lastFailed) {
    const age = opts.now - Date.parse(lastFailed.time);
    const retryHours = opts.retryHours ?? 24;
    if (Number.isFinite(age) && age >= 0 && age < retryHours * HOURS) {
      return { ok: false, reason: `上次尝试失败不满 ${retryHours} 小时（${String(lastFailed.status)}）——稍后再试` };
    }
  }
  return { ok: true };
}

/** Files an earlier attempt already uploaded for exactly this pairs digest:
 *  reuse them instead of uploading the same bytes again. */
export function reusableUploads(rows: LedgerRow[], digest: string): { trainFile?: string; evalFile?: string | null } {
  const hit = rows.findLast((r) => r.pairsDigest === digest && FAILED_STATUSES.includes(String(r.status)) && typeof r.trainFile === 'string');
  if (!hit) return {};
  return { trainFile: hit.trainFile as string, evalFile: typeof hit.evalFile === 'string' ? hit.evalFile : null };
}

/** One digest for the two files an attempt uploads. */
export function pairsDigest(trainJsonl: string, evalJsonl: string): string {
  return createHash('sha256').update(trainJsonl).update('\u0000').update(evalJsonl).digest('hex');
}

export interface DpoRow { prompt: string; chosen: string; rejected: string; split?: string; source?: string }

/**
 * The first `train` training rows and the first `eval` validation rows, in
 * file order - read as a stream, so only what this attempt trains on is held
 * in memory (the gate never needed the other 32,000 rows of a 150 MB file,
 * and the old read parsed all of it at once, every cycle). `trainTotal` and
 * `evalTotal` count the whole file; unparsable lines are skipped and counted,
 * never fatal - one torn line used to make the whole read look empty.
 */
export async function readDpoPairsHead(file: string, quota: { train: number; eval: number }): Promise<{ train: DpoRow[]; eval: DpoRow[]; trainTotal: number; evalTotal: number; bad: number }> {
  const train: DpoRow[] = [];
  const evalRows: DpoRow[] = [];
  let trainTotal = 0, evalTotal = 0, bad = 0;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row: DpoRow;
    try { row = JSON.parse(line) as DpoRow; } catch { bad++; continue; }
    if (row.split === 'eval') { evalTotal++; if (evalRows.length < quota.eval) evalRows.push(row); }
    else { trainTotal++; if (train.length < quota.train) train.push(row); }
  }
  return { train, eval: evalRows, trainTotal, evalTotal, bad };
}

/* ---------------- a provider that switched its fine-tuning off ---------------- */

export function isFineTuneRetired(backend: FineTuneBackend, now = new Date()): boolean {
  return !!backend.retired && now.getTime() >= Date.parse(backend.retired.since + 'T00:00:00Z');
}

/** What the user is told, once, instead of a request that cannot succeed. */
export function fineTuneRetirementNotice(backend: FineTuneBackend, now = new Date()): string | null {
  if (!backend.retired || !isFineTuneRetired(backend, now)) return null;
  const r: FineTuneRetirement = backend.retired;
  return `${backend.label}的微调服务已下线（${r.since} 起），自动微调在这个供应商上不再可用。`
    + `供应商公告（${r.source}）：${r.quote}`
    + ' 本机的评审标签和偏好对（evolution/dpo-pairs.jsonl）原样保留：换用仍提供微调的供应商后可以接着用。';
}
