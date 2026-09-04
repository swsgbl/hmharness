/**
 * @hmh/evolution - radar (ops-signal feed)
 * The ops keeper's ecosystem radar scans OpenHarmony release sources and
 * writes dated briefs (home/ops/briefs/YYYY-MM-DD.md). This module hands
 * the NEWEST brief text to the evolution loop as context: toolchain flags
 * and API surfaces move with releases, and a skill proposal that doesn't
 * know "ArkUI 5.1.2 shipped last week" proposes stale advice.
 *
 * Read-only and best-effort: evolution never triggers a scan (that's
 * `hmh ops scan`'s own budgeted job) - it reads what the keeper already
 * published, and an absent brief simply means no ecosystem signal.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The newest radar brief, capped (the meta-model needs a headline, not
 *  the whole document; stale-brief protection via the filename date). */
export async function latestRadarBrief(home: string, maxChars = 1200, maxAgeDays = 14): Promise<string | null> {
  const dir = join(home, 'ops', 'briefs');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch {
    return null;
  }
  const latest = files[files.length - 1];
  if (!latest) return null;
  const date = latest.replace(/\.md$/, '');
  if (Date.now() - new Date(date + 'T00:00:00Z').getTime() > maxAgeDays * 86400_000) {
    return null; // too old to be ecosystem "news"
  }
  try {
    const text = (await readFile(join(dir, latest), 'utf8')).trim();
    return text.length > 20 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}
