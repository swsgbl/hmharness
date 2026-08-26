/**
 * @hmh/domain-ops
 * The ops keeper (hm-keeper successor, rewritten per the behavior spec
 * captured in docs/MIGRATION-ASSESSMENT.md):
 *  - ecosystem radar: pull OpenHarmony release sources -> diff against the
 *    last snapshot -> Chinese brief via the model, DEGRADING to a template
 *    brief when the model is unreachable
 *  - one failing source never kills the scan
 *  - everything lands under HMH_HOME/ops/ (snapshots, briefs, scan log)
 * All network fetches are zero-dependency native fetch with per-source
 * timeouts. The issue-flow half of the old keeper is deliberately deferred
 * until a GitHub MCP server is configured - borrow the ecosystem, don't
 * rebuild API clients.
 */
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, type ProviderConfig, type Tool } from '@hmh/kernel';

export interface RadarSource {
  key: string;
  kind: 'gitee-releases' | 'github-tags';
  repo: string; // "owner/name"
  label: string;
}

export interface RadarItem {
  id: string;
  title: string;
  url: string;
  date: string;
}

export interface ScanReport {
  time: string;
  baseline: boolean;
  sources: Array<{ key: string; ok: boolean; count: number; error?: string }>;
  newItems: Array<{ source: string; item: RadarItem }>;
  brief: string;
  briefMode: 'model' | 'template' | 'none';
}

const DEFAULT_SOURCES: RadarSource[] = [
  { key: 'oh-docs', kind: 'gitee-releases', repo: 'openharmony/docs', label: 'OpenHarmony 文档/版本发布' },
  { key: 'oh-ace', kind: 'github-tags', repo: 'openharmony/arkui_ace_engine', label: 'ArkUI 框架' },
  { key: 'oh-ets', kind: 'github-tags', repo: 'openharmony/arkcompiler_ets_frontend', label: 'ArkTS/方舟编译器' },
  { key: 'oh-ability', kind: 'github-tags', repo: 'openharmony/ability_ability_runtime', label: 'Ability 运行时' },
];

function opsDir(home: string): string {
  return join(home, 'ops');
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'hmharness-radar/0.1', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(src: RadarSource): Promise<RadarItem[]> {
  if (src.kind === 'gitee-releases') {
    const data = (await fetchJson(`https://gitee.com/api/v5/repos/${src.repo}/releases?per_page=5`)) as Array<{
      tag_name: string; name: string; html_url?: string; created_at?: string;
    }>;
    return data.map((r) => ({
      id: r.tag_name ?? String(r.name),
      title: `${src.label}: ${r.name || r.tag_name}`,
      url: r.html_url ?? `https://gitee.com/${src.repo}/releases`,
      date: (r.created_at ?? '').slice(0, 10),
    }));
  }
  const data = (await fetchJson(`https://api.github.com/repos/${src.repo}/tags?per_page=5`)) as Array<{ name: string; commit?: { url?: string } }>;
  return data.map((t) => ({
    id: t.name,
    title: `${src.label}: ${t.name}`,
    url: `https://github.com/${src.repo}/tags`,
    date: '',
  }));
}

interface Snapshot {
  time: string;
  seen: Record<string, string[]>; // source key -> item ids ever seen
}

async function loadSnapshot(home: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(join(opsDir(home), 'radar-snapshot.json'), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

/** Template fallback brief - the old keeper's degradation spec, verbatim in spirit. */
function templateBrief(report: Omit<ScanReport, 'brief' | 'briefMode'>): string {
  const lines = [`# 生态雷达简报(模板拼接·模型不可达)`, '', `时间:${report.time}`];
  if (report.baseline) {
    lines.push('', '本次为初次基线扫描,记录当前各源最新条目,不做变更分析。');
  }
  lines.push('', '## 变更条目');
  if (report.newItems.length === 0) lines.push('(无新增)');
  for (const n of report.newItems.slice(0, 20)) lines.push(`- ${n.item.title}${n.item.url ? ` (${n.item.url})` : ''}`);
  lines.push('', '## 源健康');
  for (const s of report.sources) lines.push(`- ${s.key}: ${s.ok ? `ok (${s.count} 条)` : `FAIL ${s.error ?? ''}`}`);
  lines.push('', '## 影响面建议(模板)', '- 有 OpenHarmony 大版本发布时:检查 compatibleSdkVersion 是否需要跟进;ArkUI/ArkTS 源有发布时:关注 API 变更公告。');
  return lines.join('\n');
}

async function modelBrief(provider: ProviderConfig, partial: Omit<ScanReport, 'brief' | 'briefMode'>): Promise<string | null> {
  const system = [
    '你是 hmharness 的生态雷达编辑。根据 OpenHarmony 生态各源的变更条目写一份简明的中文简报(markdown)。',
    '结构:## 摘要(2-3 句)、## 值得关注(逐条:变更是什么+对鸿蒙应用开发者可能的影响)、## 建议(是否需要行动)。',
    '只依据给到的条目,不编造;条目为空就写"本期无变更";保持简短(300 字内)。',
  ].join('\n');
  const user = JSON.stringify({ baseline: partial.baseline, newItems: partial.newItems.slice(0, 20), sources: partial.sources }, null, 2);
  try {
    const r = await chat(provider, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], undefined, { timeoutMs: 90_000 });
    const text = (r.message.content ?? '').trim();
    return text.length > 40 ? text : null;
  } catch {
    return null;
  }
}

export async function scanRadar(opts: {
  home: string;
  provider: ProviderConfig;
  sources?: RadarSource[];
}): Promise<ScanReport> {
  const home = opts.home;
  const sources = opts.sources && opts.sources.length > 0 ? opts.sources : DEFAULT_SOURCES;
  await mkdir(join(opsDir(home), 'briefs'), { recursive: true });

  const prev = await loadSnapshot(home);
  const baseline = prev === null;

  const sourceStates: ScanReport['sources'] = [];
  const newItems: ScanReport['newItems'] = [];
  const seen: Record<string, string[]> = {};

  await Promise.all(
    sources.map(async (src) => {
      try {
        const items = await fetchSource(src);
        seen[src.key] = items.map((i) => i.id);
        if (!baseline) {
          const prevIds = new Set(prev!.seen[src.key] ?? []);
          for (const item of items) if (!prevIds.has(item.id)) newItems.push({ source: src.label, item });
        }
        sourceStates.push({ key: src.key, ok: true, count: items.length });
      } catch (err) {
        // single-source failure never kills the scan
        sourceStates.push({ key: src.key, ok: false, count: 0, error: String(err).slice(0, 120) });
        seen[src.key] = prev?.seen[src.key] ?? [];
      }
    }),
  );

  const partial: Omit<ScanReport, 'brief' | 'briefMode'> = {
    time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    baseline,
    sources: sourceStates.sort((a, b) => a.key.localeCompare(b.key)),
    newItems: newItems.slice(0, 30),
  };

  let brief: string;
  let briefMode: ScanReport['briefMode'];
  if (baseline) {
    brief = templateBrief(partial);
    briefMode = 'none';
  } else {
    const mb = await modelBrief(opts.provider, partial);
    if (mb) {
      brief = mb;
      briefMode = 'model';
    } else {
      brief = templateBrief(partial);
      briefMode = 'template';
    }
  }

  const report: ScanReport = { ...partial, brief, briefMode };
  await writeFile(join(opsDir(home), 'radar-snapshot.json'), JSON.stringify({ time: partial.time, seen }, null, 2), 'utf8');
  await writeFile(join(opsDir(home), 'briefs', `${partial.time.slice(0, 10)}.md`), brief + '\n', 'utf8');
  await appendFile(join(opsDir(home), 'ops-log.jsonl'), JSON.stringify({
    time: partial.time, baseline, briefMode,
    sources: partial.sources.map((s) => ({ key: s.key, ok: s.ok })),
    newCount: partial.newItems.length,
  }) + '\n', 'utf8');
  return report;
}

export async function latestBrief(home: string): Promise<{ date: string; text: string } | null> {
  try {
    const files = (await readdir(join(opsDir(home), 'briefs'))).filter((f) => f.endsWith('.md')).sort();
    const last = files[files.length - 1];
    if (!last) return null;
    return { date: last.replace(/\.md$/, ''), text: await readFile(join(opsDir(home), 'briefs', last), 'utf8') };
  } catch {
    return null;
  }
}

export async function opsStatus(home: string): Promise<{ scans: number; lastScan?: string; sources: string[] }> {
  const lines = (await readFile(join(opsDir(home), 'ops-log.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  return {
    scans: lines.length,
    lastScan: last ? (JSON.parse(last) as { time: string }).time : undefined,
    sources: DEFAULT_SOURCES.map((s) => s.key),
  };
}

/* ------------------------------------------------------------------ */
/* Agent tools                                                         */
/* ------------------------------------------------------------------ */

async function resolveProvider(): Promise<ProviderConfig> {
  const { loadConfig } = await import('@hmh/kernel');
  return (await loadConfig()).provider;
}

export const harmonyOpsRadarScan: Tool = {
  name: 'harmony_ops_radar_scan',
  description:
    'Scan the OpenHarmony/HarmonyOS ecosystem radar: pull release feeds (OpenHarmony docs/ArkUI/ArkTS/Ability runtime), diff against the last snapshot, and produce a Chinese brief (model-written, template fallback when the model is down). Read-only for the outside world; results land under HMH_HOME/ops/.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const provider = await resolveProvider();
    const r = await scanRadar({ home: ctx.home, provider });
    const head = [
      `scan ${r.time} · ${r.baseline ? 'BASELINE (first scan)' : `${r.newItems.length} new items`}`,
      `sources: ${r.sources.map((s) => `${s.key}:${s.ok ? 'ok' : 'FAIL'}`).join(' ')}`,
      `brief mode: ${r.briefMode}`,
      '',
    ].join('\n');
    return { output: (head + r.brief).slice(0, 20_000) };
  },
};

export const harmonyOpsRadarBrief: Tool = {
  name: 'harmony_ops_radar_brief',
  description: 'Read the latest saved ecosystem radar brief (markdown).',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const b = await latestBrief(ctx.home);
    return b ? { output: `(${b.date})\n${b.text}`.slice(0, 20_000) } : { output: 'No brief yet - run harmony_ops_radar_scan first.', isError: true };
  },
};

export const harmonyOpsStatus: Tool = {
  name: 'harmony_ops_status',
  description: 'Ops keeper status: scan count, last scan time, watched sources.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const s = await opsStatus(ctx.home);
    return { output: `scans: ${s.scans}${s.lastScan ? ` · last: ${s.lastScan}` : ''}\nsources: ${s.sources.join(', ')}` };
  },
};

export const opsTools: Tool[] = [harmonyOpsRadarScan, harmonyOpsRadarBrief, harmonyOpsStatus];
export { DEFAULT_SOURCES };
