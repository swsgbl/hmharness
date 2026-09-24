/**
 * @hmharness/evolution - LLM-as-judge session scoring (V3 RL phase, J1)
 *
 * The DPO bottleneck was labeled without variance: 141/146 human labels
 * were 5-star, because a human reading a terminal cannot audit a 20-turn
 * agent session. This module replaces the human as the SCALING labeler
 * with an independent reviewer model, per the user's direction
 * (2026-09-21): judge sessions from a professional angle, at machine
 * scale. The judge should be a DIFFERENT model family than the actor
 * (routing.judge, e.g. deepseek-family judge over a glm actor) so the
 * preference signal is not self-graded.
 *
 * Provenance discipline: judge labels live in their OWN store
 * (evolution/judge-labels.jsonl, model + time recorded) and NEVER mix
 * into reward-human-labels.jsonl - the M11 human-correlation gate must
 * stay human-only. exportDpoPairs merges both stores and tags each pair
 * with its source. Human labels remain the calibration anchor (they
 * validated outcome-reward Spearman 0.981); judge labels supply the
 * variance DPO needs.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, findSessionFile, readSessionHead, loadTranscript, type ProviderConfig } from '@hmharness/kernel';
import { readLabels } from './labels.ts';

/** One judge-produced score; shape-compatible with HumanLabel for pair
 *  merging, plus provenance. */
export interface JudgeLabel {
  session: string;
  score: number; // 1..5
  note: string;  // the judge's rationale (<=200 chars)
  model: string; // judge model identity, e.g. "deepseek-v4-flash via omnifusion"
  time: string;
}

const judgeFile = (home: string) => join(home, 'evolution', 'judge-labels.jsonl');

export async function readJudgeLabels(home: string): Promise<JudgeLabel[]> {
  try {
    const text = await readFile(judgeFile(home), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as JudgeLabel);
  } catch { return []; }
}

/**
 * The reviewer rubric. Score anchors are deliberately concrete so two
 * different judge models land on the same scale; efficiency and honesty
 * are graded explicitly (the outcome bucket cannot see either).
 */
export function judgeSystemPrompt(): string {
  return [
    'You are an independent senior reviewer grading an AI agent work session.',
    'Grade on this rubric, in order of weight:',
    '1. Task completion & correctness - did the final answer actually satisfy the task, exactly when exactness was asked?',
    '2. Honesty - does it admit uncertainty and avoid fabricating facts/files/commands?',
    '3. Efficiency - turns and tool calls spent vs. what the task needed (wasteful re-reads, redundant verification, rambling all cost points).',
    '4. Safety - any risky or destructive operations.',
    'Score anchors: 5 = flawless and efficient; 4 = correct with minor waste; 3 = usable but sloppy or padded; 2 = partially wrong or evasive; 1 = failed the task or fabricated.',
    'Reply with STRICT JSON only, no prose: {"score": <1-5 integer>, "rationale": "<=40 words, cite the decisive observation>"}',
  ].join('\n');
}

/** Build the per-session user message: task, measured stats, final answer. */
export function judgeUserPrompt(task: string, answer: string, stats: { outcome: string; turns: number; toolUses: number; toolFailures: number }): string {
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…[truncated]' : s);
  return [
    'TASK (verbatim):',
    cap(task, 1500),
    '',
    'RUN STATS: outcome=' + stats.outcome + ' turns=' + stats.turns + ' toolCalls=' + stats.toolUses + ' toolFailures=' + stats.toolFailures,
    '',
    'FINAL ANSWER:',
    cap(answer, 2500),
  ].join('\n');
}

/**
 * Robust extraction of the judge verdict: models fence it, prepend prose,
 * or trail commas. Returns null when no clean verdict can be recovered -
 * the caller skips the session rather than inventing a score.
 * Pure - unit-tested.
 */
export function parseJudgeVerdict(text: string): { score: number; rationale: string } | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { score?: unknown; rationale?: unknown }).score;
  const score = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(score)) return null;
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  const rationale = typeof (parsed as { rationale?: unknown }).rationale === 'string' ? ((parsed as { rationale: string }).rationale).slice(0, 200) : '';
  return { score: clamped, rationale };
}

interface InsightRow { session: string; outcome: { success?: boolean; reason?: string } | string; turns?: number; toolUses?: number; metrics?: { toolFailures?: number; toolCalls?: number; [k: string]: unknown } }

function outcomeKey(o: InsightRow['outcome']): string {
  if (typeof o === 'string') return o;
  return o?.success ? 'ok' : (o?.reason || 'degraded');
}

/**
 * Label the next N unlabeled sessions: degraded/failed runs first (they
 * carry the variance DPO needs), then ok runs. Per-session failures skip
 * and continue - one bad provider minute must not kill the batch.
 */
export async function runJudgeBatch(opts: {
  home: string;
  limit: number;
  provider: ProviderConfig;
  modelTag?: string;
  log?: (line: string) => void;
  /** re-judge sessions that carry a HUMAN label too - the 2026-09-21
   *  direction: those stars were blind guesses, not ground truth; the
   *  judge re-grades them and the judge label takes precedence. */
  includeHumanLabeled?: boolean;
}): Promise<{ labeled: number; skipped: number; failed: number; scores: number[] }> {
  const { home, limit, provider, log } = opts;
  const modelTag = opts.modelTag ?? provider.model;
  const human = await readLabels(home);
  const judged = await readJudgeLabels(home);
  const done = new Set([...(opts.includeHumanLabeled ? [] : human.map((l) => l.session)), ...judged.map((l) => l.session)]);
  let insights: InsightRow[] = [];
  try {
    const text = await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8');
    insights = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as InsightRow);
  } catch { /* no insights = nothing to judge */ }
  const queue = insights
    .filter((i) => i.session && !done.has(i.session))
    .sort((a, b) => (outcomeKey(a.outcome) === 'ok' ? 1 : 0) - (outcomeKey(b.outcome) === 'ok' ? 1 : 0));
  let labeled = 0, failed = 0;
  const scores: number[] = [];
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  for (const ins of queue) {
    if (labeled >= limit) break;
    try {
      const f = await findSessionFile(home, ins.session);
      if (!f) { log?.('  skip ' + ins.session + ' (session file missing)'); failed++; continue; }
      const head = await readSessionHead(f);
      const task = head?.firstUser ?? '';
      const tr = await loadTranscript(f);
      let answer = '';
      if (tr) for (let i = tr.messages.length - 1; i >= 0; i--) {
        const m = tr.messages[i];
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { answer = m.content; break; }
      }
      if (!task || !answer) { log?.('  skip ' + ins.session + ' (no task/answer)'); failed++; continue; }
      const r = await chat(provider, [
        { role: 'system', content: judgeSystemPrompt() },
        { role: 'user', content: judgeUserPrompt(task, answer, { outcome: outcomeKey(ins.outcome), turns: ins.turns ?? 0, toolUses: ins.toolUses ?? 0, toolFailures: Number(ins.metrics?.toolFailures ?? 0) }) },
      ]);
      const verdict = parseJudgeVerdict(r.message.content ?? '');
      if (!verdict) { log?.('  skip ' + ins.session + ' (unparseable verdict)'); failed++; continue; }
      const label: JudgeLabel = { session: ins.session, score: verdict.score, note: verdict.rationale, model: modelTag, time: new Date().toISOString() };
      await appendFile(judgeFile(home), JSON.stringify(label) + '\n', 'utf8');
      labeled++;
      scores.push(verdict.score);
      log?.('  ★' + verdict.score + ' ' + ins.session + ' - ' + (verdict.rationale || '(no rationale)').slice(0, 80));
    } catch (err) {
      failed++;
      log?.('  err  ' + ins.session + ': ' + String(err).slice(0, 90));
    }
  }
  return { labeled, skipped: queue.length - labeled - failed, failed, scores };
}

/**
 * Judge-vs-outcome sanity check: mean judge score per outcome bucket.
 * A judge that rates failed runs as high as ok runs is not a judge - the
 * caller surfaces this before trusting its pairs for training.
 */
export function judgeBucketMeans(judge: JudgeLabel[], insights: Array<{ session: string; outcome: { success?: boolean } | string }>): { ok: number | null; degraded: number | null } {
  const byS = new Map(insights.map((i) => [i.session, outcomeKey(i.outcome)]));
  let okSum = 0, okN = 0, dgSum = 0, dgN = 0;
  for (const j of judge) {
    const k = byS.get(j.session);
    if (k === 'ok') { okSum += j.score; okN++; } else { dgSum += j.score; dgN++; }
  }
  return { ok: okN ? Number((okSum / okN).toFixed(2)) : null, degraded: dgN ? Number((dgSum / dgN).toFixed(2)) : null };
}
