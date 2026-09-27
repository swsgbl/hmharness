/**
 * @hmharness/evolution - insights
 * Automatic insight capture: every finished session appends a compact
 * record (task / outcome / tool usage) to insights/insights.jsonl. This is
 * the raw feed the future evolution loop mines for skill and prompt
 * improvements - the DGM lesson: evolution needs an archive plus a signal.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Insight {
  time: string;
  session: string;
  task: string;
  outcome: 'ok' | 'turn-budget' | 'error';
  turns: number;
  toolUses: number;
  toolsUsed: string[];
  /** P0 impact attribution: skills (incl. canaries) injected into this
   *  session's system prompt - the join key for canary A/B comparison. */
  skillsInjected?: string[];
  /** Plan C (2026-09-27): the workspace (project) this session ran in.
   *  Retrieval stays GLOBAL - a lesson learned in project A is reachable
   *  from project B - but the origin is stamped on the injected line so
   *  the model can weigh "same tooling, different codebase" advice. */
  workspace?: string;
}

/**
 * Secret redaction for everything that leaves the machine (insights feed the
 * PUBLIC evidence page). Users paste API keys into task text ("新增 provider,
 * sk-… 给 hmharness") and the audit trail must never publish them. Cover the
 * shapes seen in the wild: OpenAI-style sk-, VolcEngine ark-<uuid>-<hex>,
 * GitHub ghp_/npm_ tokens. GitHub Push Protection caught this class once
 * (GH013, VolcEngine Ark) - it must be caught here first.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9]{20,}/g, label: 'sk-[REDACTED]' },
  { re: /ark-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{4,}/g, label: 'ark-[REDACTED]' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, label: 'ghp_[REDACTED]' },
  { re: /npm_[A-Za-z0-9]{20,}/g, label: 'npm_[REDACTED]' },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.label);
  return out;
}

export async function recordInsight(home: string, insight: Insight): Promise<void> {
  const dir = join(home, 'insights');
  await mkdir(dir, { recursive: true });
  const clean = { ...insight, task: redactSecrets(insight.task) };
  await appendFile(join(dir, 'insights.jsonl'), JSON.stringify(clean) + '\n', 'utf8');
}

/** Read recent insights as structured records (the evolve loop's raw feed). */
export async function readInsights(home: string, limit = 40): Promise<Insight[]> {
  try {
    const text = await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).slice(-limit);
    const out: Insight[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as Insight);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Summarize recent insights for the system prompt (bounded). */
export async function recentInsights(home: string, limit = 5): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
    const last = lines.slice(-limit);
    if (last.length === 0) return '';
    return last
      .map((l) => {
        try {
          const i = JSON.parse(l) as Insight;
          return `- [${i.outcome}] ${i.task.slice(0, 60)} (turns ${i.turns}, tools ${i.toolsUsed.join(',') || 'none'})`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

/* ---------------- experience retrieval (2026-09-27, plan A) ----------------
 * The injection used to be "last 5 insights" - pure recency. After 300
 * tasks, a question similar to task #50 got five UNRELATED recent lessons
 * instead of that one. Industry direction (Agent KB / Agent Workflow
 * Memory, verified 2026-09-27): retrieve relevant experience per task.
 * Zero-dependency red line -> character-bigram Jaccard (works well for CJK
 * too), a small recency tiebreak, graceful fallback to recency order. */

/** Task-similarity feature set: per-WORD bigrams plus single chars as
 *  tokens (2026-09-27). Cross-word bigrams that include the space turned
 *  out to be a noise factory - 'fix' and 'xxx' shared 'x ' and unrelated
 *  natural sentences scored 0.06. Words are split on non-alphanumerics;
 *  CJK text has no spaces, so a whole Chinese clause becomes one word and
 *  keeps every character bigram. Pure. */
export function bigrams(s: string): Set<string> {
  const words = s.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const out = new Set<string>();
  for (const w of words) {
    if (w.length === 1) { out.add(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** Jaccard similarity of two bigram sets. Pure. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function formatInsight(i: Insight, currentWorkspace?: string): string {
  // cross-project origin stamp (plan C): lessons from ANOTHER project are
  // still injected (global retrieval) but labelled, so the model knows the
  // tooling lesson may not carry the codebase specifics with it
  const from = i.workspace && currentWorkspace && i.workspace !== currentWorkspace ? ` [来自项目:${i.workspace}]` : '';
  return `- [${i.outcome}] ${i.task.slice(0, 60)} (turns ${i.turns}, tools ${i.toolsUsed.join(',') || 'none'})${from}`;
}

/** Noise floor: below this similarity an insight is unrelated to the task.
 *  With per-word bigrams the highest unrelated natural-language pairs score
 *  ~0.04 (stopword overlap: 'the' contributes th/he); related tasks land at
 *  0.5+. The floor sits between the two, with margin on both sides. */
export const INSIGHT_SIM_FLOOR = 0.05;

/**
 * The K most RELEVANT insights for this task (recency as tiebreak), falling
 * back to the K most recent when nothing clears the noise floor - so the
 * prompt always carries some experience, exactly like before.
 */
export async function retrieveInsights(home: string, task: string, opts: { topK?: number; pool?: number; workspace?: string } = {}): Promise<string> {
  const topK = opts.topK ?? 5;
  const pool = opts.pool ?? 500;
  let rows: Insight[] = [];
  try {
    const text = await readFile(join(home, 'insights', 'insights.jsonl'), 'utf8');
    rows = text.trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Insight; } catch { return null; } })
      .filter((x): x is Insight => x !== null)
      .slice(-pool);
  } catch {
    return ''; // no archive at all - same behaviour as recentInsights
  }
  if (rows.length === 0) return '';
  const q = bigrams(task);
  if (q.size === 0) return rows.slice(-topK).map((r) => formatInsight(r, opts.workspace)).join('\n');
  // newest first within the pool, so idx IS the recency rank
  const newestFirst = [...rows].reverse();
  const scored = newestFirst
    .map((r, idx) => ({ r, s: jaccard(q, bigrams(r.task)) + (1 - idx / (newestFirst.length + 1)) * 1e-4 }))
    .filter((x) => x.s > INSIGHT_SIM_FLOOR)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((x) => x.r);
  if (scored.length === 0) return rows.slice(-topK).map((r) => formatInsight(r, opts.workspace)).join('\n');
  return scored.map((r) => formatInsight(r, opts.workspace)).join('\n');
}
