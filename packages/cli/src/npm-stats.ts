/**
 * @hmharness/cli - npm-stats
 * `hmh ops stats`: download counts for the seven @hmharness packages from
 * npm's public downloads API. Counts are DOWNLOADS, not users - mirror sync
 * and scanners are included; the line under the table says so (honesty over
 * vanity metrics).
 */
const PKGS = ['kernel', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli'] as const;

export interface PkgStat {
  name: string;
  day: number | null;
  week: number | null;
  month: number | null;
}

async function one(fetchImpl: typeof fetch, period: string, name: string): Promise<number | null> {
  try {
    const res = await fetchImpl(`https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { downloads?: number };
    return typeof j.downloads === 'number' ? j.downloads : null;
  } catch { return null; }
}

export async function fetchNpmStats(fetchImpl: typeof fetch = fetch): Promise<PkgStat[]> {
  const rows = await Promise.all(PKGS.map(async (p) => {
    const name = '@hmharness/' + p;
    const [day, week, month] = await Promise.all([
      one(fetchImpl, 'last-day', name),
      one(fetchImpl, 'last-week', name),
      one(fetchImpl, 'last-month', name),
    ]);
    return { name, day, week, month };
  }));
  return rows;
}

export function renderStats(rows: PkgStat[]): string {
  const n = (v: number | null) => (v === null ? '-' : String(v));
  const w = (s: string, len: number) => s.padEnd(len);
  const head = w('package', 28) + w('day', 7) + w('week', 8) + 'month';
  const body = rows.map((r) => w(r.name, 28) + w(n(r.day), 7) + w(n(r.week), 8) + n(r.month)).join('\n');
  return head + '\n' + body + '\n(downloads, not users: mirror sync + scanners included; CN installs via npmmirror are NOT counted)';
}
