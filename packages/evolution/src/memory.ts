/**
 * @hmharness/evolution - memory
 * Cross-session persistent memory. Notes are append-only lines in
 * memory/memory.md (ACE lesson: append beats rewrite - rewriting is where
 * hard-won context gets lost). Injection is retrieval-based and layered:
 *
 *   1. lexical scoring (ASCII words + CJK bigrams, no deps) - the baseline
 *   2. workspace scoping - notes tagged [ws:<name>] are boosted 2.5x when
 *      the current task runs inside that workspace and dampened to 0.3x in
 *      others. Isolation WITHOUT walls: project-local facts rank first at
 *      home, but global lessons stay reachable everywhere. Untagged notes
 *      (the entire pre-existing memory) behave exactly as before.
 *   3. optional embedding hybrid - when an embedding provider is passed in,
 *      notes are vectorised once (cache: memory/embeddings.json, keyed by
 *      content hash) and ranked by cosine similarity blended with the
 *      lexical score. Any failure falls back to pure lexical - embeddings
 *      are an upgrade, never a dependency.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface MemoryNote {
  time: string;
  text: string;
}

export async function readNotes(home: string): Promise<MemoryNote[]> {
  let raw: string;
  try {
    raw = await readFile(join(home, 'memory', 'memory.md'), 'utf8');
  } catch {
    return [];
  }
  const notes: MemoryNote[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*-\s*\[([^\]]*)\]\s*(.+)$/);
    if (m) notes.push({ time: m[1].trim(), text: m[2].trim() });
  }
  return notes;
}

/* ---------------- workspace scoping ---------------- */

interface WorkspaceEntry { id?: string; name: string; path: string; current?: boolean }

/** Resolve the workspace a cwd belongs to (longest path prefix wins).
 *  Returns null outside every workspace - those notes stay global. */
export async function workspaceForCwd(home: string, cwd: string): Promise<string | null> {
  let entries: WorkspaceEntry[];
  try {
    const j = JSON.parse(await readFile(join(home, 'workspaces.json'), 'utf8')) as { workspaces?: WorkspaceEntry[] } | WorkspaceEntry[];
    entries = Array.isArray(j) ? j : (j.workspaces ?? []);
  } catch {
    return null;
  }
  const norm = (p: string) => p.replace(/[\\/]+/g, '\\').toLowerCase().replace(/\\$/, '');
  const target = norm(cwd);
  let best: { name: string; len: number } | null = null;
  for (const w of entries) {
    if (!w?.path || !w?.name) continue;
    const p = norm(w.path);
    if ((target === p || target.startsWith(p + '\\')) && (!best || p.length > best.len)) {
      best = { name: w.name, len: p.length };
    }
  }
  return best?.name ?? null;
}

const WS_TAG = /\s*\[ws:([^\]]+)\]\s*$/;
function noteWorkspace(text: string): string | null {
  const m = text.match(WS_TAG);
  return m ? m[1] : null;
}

/** Tokenize for scoring: ASCII words as-is, CJK runs as bigrams. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[a-zA-Z0-9_.\\/:+-]{2,}/g) ?? []) out.add(w.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function scoreNotes(notes: MemoryNote[], task: string, workspace?: string): Array<{ note: MemoryNote; score: number }> {
  const taskTokens = tokens(task);
  const ranked = notes.map((note, idx) => {
    const n = tokens(note.text);
    let overlap = 0;
    for (const t of n) if (taskTokens.has(t)) overlap++;
    let score = overlap + idx / Math.max(notes.length, 1) * 0.01;
    // workspace scoping: boost at home, dampen abroad, globals untouched
    const ws = noteWorkspace(note.text);
    if (workspace && ws === workspace) score *= 2.5;
    else if (workspace && ws && ws !== workspace) score *= 0.3;
    return { note, score };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/* ---------------- optional embedding hybrid ---------------- */

export interface EmbeddingProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function embed(inputs: string[], p: EmbeddingProvider, fetchImpl?: typeof fetch): Promise<number[][] | null> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(p.baseUrl.replace(/\/+$/, '') + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, input: inputs }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { data?: Array<{ embedding?: number[] }> };
    const out = (j.data ?? []).map((d) => d.embedding ?? []);
    return out.length === inputs.length ? out : null;
  } catch {
    return null;
  }
}

interface EmbeddingCache { [hash: string]: number[] }

async function hybridRank(
  notes: MemoryNote[], task: string, workspace: string | undefined,
  home: string, embedding: EmbeddingProvider, fetchImpl?: typeof fetch,
): Promise<Array<{ note: MemoryNote; score: number }> | null> {
  const lexical = scoreNotes(notes, task, workspace);
  const maxLex = Math.max(...lexical.map((r) => r.score), 1e-9);
  const cacheFile = join(home, 'memory', 'embeddings.json');
  let cache: EmbeddingCache = {};
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) as EmbeddingCache; } catch { /* empty */ }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
  const missing = [...new Set(notes.filter((n) => !cache[hash(n.text)]).map((n) => n.text))];
  if (missing.length > 0) {
    const vecs = await embed(missing, embedding, fetchImpl);
    if (!vecs) return null; // embedding endpoint down -> pure lexical
    missing.forEach((text, i) => { cache[hash(text)] = vecs[i]; });
    try { await mkdir(join(home, 'memory'), { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache), 'utf8'); } catch { /* best effort */ }
  }
  const queryVec = await embed([task], embedding, fetchImpl);
  if (!queryVec) return null;
  const q = queryVec[0];
  const blended = lexical.map((r) => {
    const v = cache[hash(r.note.text)];
    const cos = v ? cosine(v, q) : 0;
    return { note: r.note, score: 0.5 * (r.score / maxLex) + 0.5 * Math.max(cos, 0) };
  });
  return blended.sort((a, b) => b.score - a.score);
}

/**
 * Build the prompt block: top-k task-relevant notes plus the newest few
 * (deduplicated), bounded in chars. Empty string when memory is empty.
 */
export async function retrieveMemory(
  home: string,
  task: string,
  opts: { topK?: number; newest?: number; maxChars?: number; workspace?: string; embedding?: EmbeddingProvider; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const { topK = 12, newest = 3, maxChars = 4000 } = opts;
  const notes = await readNotes(home);
  if (notes.length === 0) return '';
  let ranked: Array<{ note: MemoryNote; score: number }>;
  if (opts.embedding) {
    ranked = (await hybridRank(notes, task, opts.workspace, home, opts.embedding, opts.fetchImpl)) ?? scoreNotes(notes, task, opts.workspace);
  } else {
    ranked = scoreNotes(notes, task, opts.workspace);
  }
  const picked: MemoryNote[] = [];
  const seen = new Set<string>();
  for (const { note } of ranked.slice(0, topK)) {
    picked.push(note);
    seen.add(note.text);
  }
  for (const note of (newest > 0 ? notes.slice(-newest) : [])) {
    if (!seen.has(note.text)) picked.push(note);
    seen.add(note.text);
  }
  // stable output: keep chronological order
  picked.sort((a, b) => (a.time < b.time ? -1 : 1));
  const lines = picked.map((n) => `- [${n.time}] ${n.text}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n...[memory truncated]';
  return text;
}

/** Legacy full load (tail-bounded) - kept for callers that want everything. */
export async function loadMemory(home: string): Promise<string> {
  try {
    const text = (await readFile(join(home, 'memory', 'memory.md'), 'utf8')).trim();
    if (!text) return '';
    return text.length > 8000 ? text.slice(-8000) : text;
  } catch {
    return '';
  }
}

export async function appendMemory(home: string, note: string, workspace?: string): Promise<void> {
  const dir = join(home, 'memory');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const tag = workspace ? ` [ws:${workspace}]` : '';
  await appendFile(join(dir, 'memory.md'), `\n- [${stamp}] ${note.replace(/\n+/g, ' ').trim()}${tag}\n`, 'utf8');
}
