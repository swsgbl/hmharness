/**
 * @hmh/evolution - skills
 * The skill library: every directory under HMH_HOME/skills/ holding a
 * SKILL.md is a skill. The agent sees the catalog in its system prompt and
 * reads the full text on demand via read_file. Skills are the unit the
 * evolution loop will draft, bench-test, and promote (Phase 3).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillEntry {
  name: string;
  description: string;
  file: string;
}

export async function listSkills(home: string): Promise<SkillEntry[]> {
  const root = join(home, 'skills');
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const entries: SkillEntry[] = [];
  for (const dir of dirs) {
    const file = join(root, dir, 'SKILL.md');
    try {
      const text = await readFile(file, 'utf8');
      entries.push({ name: dir, description: parseDescription(text), file });
    } catch {
      /* directory without SKILL.md - not a skill */
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsToPrompt(entries: SkillEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}

function parseDescription(text: string): string {
  // frontmatter "description:" line, or first non-heading non-empty line
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^description:\s*(.+)$/m);
    if (m) return m[1].trim().slice(0, 120);
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 120);
  }
  return '';
}
