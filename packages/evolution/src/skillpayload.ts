/**
 * Resolve a treatment-arm skills prompt for a skill-target candidate: the
 * payload names the skill; the arm must inject the skill's CONTENT (draft
 * first, promoted second), never the bare name string. (Day-49 SELFFEED:
 * the first real experiment injected "+34 tokens" of name - it measured the
 * instrument, not the skill.)
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadSkillPayload(home: string, payload: string): Promise<string> {
  const name = payload.trim();
  if (!name) return '';
  const candidates = [
    join(home, 'skills', 'drafts', `${name}.md`),
    join(home, 'skills', `${name}.md`),
  ];
  for (const f of candidates) {
    try {
      const md = await readFile(f, 'utf8');
      if (md.trim()) return md.trim().slice(0, 4000);
    } catch { /* next */ }
  }
  // no file found: fall back to the raw string so the arm still runs
  return name;
}
