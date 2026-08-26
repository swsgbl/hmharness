/**
 * @hmh/evolution - memory
 * Cross-session persistent memory. Notes are append-only lines in
 * memory/memory.md (ACE lesson: append beats rewrite - rewriting is where
 * hard-won context gets lost). Injection is retrieval-based: notes are
 * scored against the current task (ASCII words + CJK bigrams, no deps) and
 * only the top matches plus the newest few enter the system prompt.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
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

/** Tokenize for scoring: ASCII words as-is, CJK runs as bigrams. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[a-zA-Z0-9_.\\/:+-]{2,}/g) ?? []) out.add(w.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function scoreNotes(notes: MemoryNote[], task: string): Array<{ note: MemoryNote; score: number }> {
  const taskTokens = tokens(task);
  return notes
    .map((note, idx) => {
      const n = tokens(note.text);
      let overlap = 0;
      for (const t of n) if (taskTokens.has(t)) overlap++;
      // tiny recency bias so equal-relevance ties favor recent notes
      return { note, score: overlap + idx / Math.max(notes.length, 1) * 0.01 };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Build the prompt block: top-k task-relevant notes plus the newest few
 * (deduplicated), bounded in chars. Empty string when memory is empty.
 */
export async function retrieveMemory(home: string, task: string, opts: { topK?: number; newest?: number; maxChars?: number } = {}): Promise<string> {
  const { topK = 12, newest = 3, maxChars = 4000 } = opts;
  const notes = await readNotes(home);
  if (notes.length === 0) return '';
  const ranked = scoreNotes(notes, task);
  const picked: MemoryNote[] = [];
  const seen = new Set<string>();
  for (const { note } of ranked.slice(0, topK)) {
    picked.push(note);
    seen.add(note.text);
  }
  for (const note of notes.slice(-newest)) {
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

export async function appendMemory(home: string, note: string): Promise<void> {
  const dir = join(home, 'memory');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await appendFile(join(dir, 'memory.md'), `\n- [${stamp}] ${note.replace(/\n+/g, ' ').trim()}\n`, 'utf8');
}
