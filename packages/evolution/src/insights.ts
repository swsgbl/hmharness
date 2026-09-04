/**
 * @hmh/evolution - insights
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
}

export async function recordInsight(home: string, insight: Insight): Promise<void> {
  const dir = join(home, 'insights');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'insights.jsonl'), JSON.stringify(insight) + '\n', 'utf8');
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
