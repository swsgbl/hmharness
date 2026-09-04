/**
 * @hmh/evolution - knowledge (Static Knowledge Evolution)
 * The environment's knowledge decays: HarmonyOS API versions, toolchain
 * requirements, SDK release notes change out from under the agent. The
 * surveyed gap (Environment-Centric / Static Knowledge Evolution): the
 * system only has retrieval over what it already stored - nothing pulls
 * FRESH environment knowledge in.
 *
 * Production shape here: snapshot the HarmonyOS release-notes index,
 * diff against the last snapshot, and when something changed, distill a
 * knowledge-patch SKILL DRAFT through the standard pipeline (poison screen
 * -> writeDraft). The bench gate + canary + impact loop then decide its
 * fate like any other skill. No new write channel.
 *
 * Network note: the fetch goes through the OS-configured proxy if any;
 * offline = clean no-op (knowledge refresh is best-effort, never a
 * failure the user must handle).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, type ProviderConfig } from '@hmh/kernel';
import { screenForPoison, type SkillProposal } from './evolve.ts';
import { writeDraft } from './skills.ts';

/** Index pages carrying HarmonyOS release info (public, no auth). */
const SOURCES = [
  'https://developer.huawei.com/consumer/cn/release-notes/',
] as const;

interface KnowledgeSnapshot {
  time: string;
  pages: Record<string, string>;
}

async function snapshotDir(home: string): Promise<string> {
  return join(home, 'evolution', 'knowledge');
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) hmharness-knowledge-refresh' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    // strip to text: tags/scripts/styles off, whitespace squeezed - the
    // snapshot must be stable across cosmetic site changes
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200_000);
  } catch {
    return null;
  }
}

/** One refresh cycle: fetch -> compare -> maybe one knowledge draft.
 *  Returns a short human-readable summary (or 'offline' etc.). */
export async function refreshKnowledge(opts: {
  home: string;
  provider: ProviderConfig;
  say?: (l: string) => void;
  fetchImpl?: typeof fetchPage;
}): Promise<{ summary: string; draft?: SkillProposal }> {
  const say = opts.say ?? (() => undefined);
  const doFetch = opts.fetchImpl ?? fetchPage;
  const dir = await snapshotDir(opts.home);
  await mkdir(dir, { recursive: true });
  const snapFile = join(dir, 'snapshot.json');

  // 1. current snapshot
  const pages: Record<string, string> = {};
  let fetched = 0;
  for (const url of SOURCES) {
    const text = await doFetch(url);
    if (text) { pages[url] = text; fetched++; }
  }
  if (fetched === 0) {
    return { summary: 'offline or unreachable - knowledge refresh skipped (no failure)' };
  }

  // 2. diff against the previous snapshot
  let prev: KnowledgeSnapshot | null = null;
  try {
    prev = JSON.parse(await readFile(snapFile, 'utf8')) as KnowledgeSnapshot;
  } catch { /* first run */ }
  const changes: Array<{ url: string; added: string[]; removed: string[] }> = [];
  for (const [url, text] of Object.entries(pages)) {
    const old = prev?.pages[url];
    if (!old) { if (prev) changes.push({ url, added: text.split(' ').slice(0, 400), removed: [] }); continue; }
    if (old === text) continue;
    const oldWords = new Set(old.split(' '));
    const newWords = new Set(text.split(' '));
    const added = [...newWords].filter((w) => !oldWords.has(w) && w.length > 3).slice(0, 300);
    const removed = [...oldWords].filter((w) => !newWords.has(w) && w.length > 3).slice(0, 100);
    if (added.length > 0) changes.push({ url, added, removed });
  }
  await writeFile(snapFile, JSON.stringify({ time: new Date().toISOString(), pages } satisfies KnowledgeSnapshot), 'utf8');

  if (changes.length === 0) {
    return { summary: 'no change detected since the last snapshot' };
  }

  // 3. distill ONE knowledge-patch draft from the diff (meta-model)
  say(`knowledge: ${changes.length} source(s) changed`);
  const system = [
    'You distill environment-knowledge updates for a HarmonyOS coding agent.',
    'Input: word-level diffs of official release-note pages since the last check.',
    'Output ONE skill draft in the standard format (name kebab-case starting with "env-", description one line, skill_md max 40 lines) capturing what changed in the toolchain/API landscape and how the agent should adapt.',
    'Rules: only facts visible in the diff; no speculation; no security/approval topics; if the diff is noise (navigation/menu churn), output exactly: NONE',
    'Respond with ONLY JSON: {"name":"...","description":"...","skill_md":"..."}.',
  ].join('\n');
  const user = changes.map((c) => `SOURCE ${c.url}\nADDED words: ${c.added.join(' ')}`).join('\n\n');
  let draft: SkillProposal | null = null;
  try {
    const r = await chat(opts.provider, [
      { role: 'system', content: system },
      { role: 'user', content: user.slice(0, 30_000) },
    ]);
    const raw = (r.message.content ?? '').trim();
    if (raw && raw !== 'NONE') {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const o = JSON.parse(m[0]) as { name?: string; description?: string; skill_md?: string };
        if (typeof o.name === 'string' && typeof o.skill_md === 'string' && o.name && o.skill_md && !screenForPoison(o.skill_md)) {
          draft = { name: o.name, description: o.description ?? '', skill_md: o.skill_md };
        }
      }
    }
  } catch {
    /* meta-model failure = no draft this cycle */
  }

  if (!draft) {
    return { summary: `diff detected (${changes.length} source(s)) but nothing worth a draft` };
  }
  await writeDraft(opts.home, draft.name, draft.skill_md);
  say(`knowledge draft written: ${draft.name} (goes through the normal gate pipeline)`);
  return { summary: `knowledge draft "${draft.name}" written - bench gate + canary + impact decide its fate`, draft };
}
