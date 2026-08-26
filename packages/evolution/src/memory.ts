/**
 * @hmh/evolution - memory
 * Cross-session persistent memory: memory/memory.md is loaded into every
 * system prompt and appendMemory() lets the agent itself take notes that
 * survive restarts. Voyager/DGM lineage: what evolves is experience.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadMemory(home: string): Promise<string> {
  try {
    const text = (await readFile(join(home, 'memory', 'memory.md'), 'utf8')).trim();
    if (!text) return '';
    // Keep the prompt contribution bounded; full recollection comes later
    // via retrieval (Phase 2).
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
