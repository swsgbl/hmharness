/**
 * @hmharness/evolution - labels (SELFFEED month-2 foundation)
 * Human reward-label channel: the M11 readiness condition
 * 'reward-human-correlation' needs >=100 human-scored samples; this is the
 * write path for them (evolution/reward-human-labels.jsonl, one line per
 * sample, deduplicated by session). `hmh label <session-id> <1-5> [note]`.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface HumanLabel {
  session: string;
  score: number; // 1..5
  note?: string;
  time: string;
}

const labelsFile = (home: string) => join(home, 'evolution', 'reward-human-labels.jsonl');

/** Append one human score (dedupe: a session keeps its FIRST label). */
export async function labelSession(home: string, session: string, score: number, note?: string): Promise<{ ok: boolean; reason?: string; count: number }> {
  if (!session || !/^\d{4}-\d{2}-\d{2}T/.test(session)) return { ok: false, reason: 'session id looks wrong (expected YYYY-MM-DDThh-mm-ss-xxxxxx)', count: (await readLabels(home)).length };
  if (!Number.isInteger(score) || score < 1 || score > 5) return { ok: false, reason: 'score must be an integer 1..5', count: (await readLabels(home)).length };
  const dir = join(home, 'evolution');
  await mkdir(dir, { recursive: true });
  const existing = await readLabels(home);
  if (existing.some((l) => l.session === session)) return { ok: false, reason: `session ${session} already labeled (first label wins)`, count: existing.length };
  const label: HumanLabel = { session, score, ...(note ? { note: note.slice(0, 120) } : {}), time: new Date().toISOString() };
  await appendFile(labelsFile(home), JSON.stringify(label) + '\n', 'utf8');
  return { ok: true, count: existing.length + 1 };
}

export async function readLabels(home: string): Promise<HumanLabel[]> {
  try {
    const text = await readFile(labelsFile(home), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as HumanLabel);
  } catch { return []; }
}

/** Recent sessions from the insight feed, each with its label (if any) -
 *  the pick list for `hmh label`. */
export async function labelableSessions(home: string, limit = 12): Promise<Array<{ session: string; task: string; label?: HumanLabel }>> {
  const { readInsights } = await import('./insights.ts');
  const labels = await readLabels(home);
  const bySession = new Map(labels.map((l) => [l.session, l]));
  const insights = await readInsights(home, 200);
  const seen = new Set<string>();
  const out: Array<{ session: string; task: string; label?: HumanLabel }> = [];
  for (const i of insights) {
    if (seen.has(i.session) || bySession.has(i.session)) continue;
    seen.add(i.session);
    out.push({ session: i.session, task: i.task.slice(0, 90), label: bySession.get(i.session) });
    if (out.length >= limit) break;
  }
  // labeled ones first for re-inspection, then unlabeled
  return [
    ...labels.slice(-limit).reverse().map((l) => ({ session: l.session, task: '(labeled)', label: l })),
    ...out,
  ];
}
