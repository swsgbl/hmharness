/**
 * @hmh/evolution - skills
 * The skill library with a three-state lifecycle:
 *   skills/draft/<name>/    drafted by the evolution loop, never injected
 *   skills/active/<name>/   promoted skills, injected into the system prompt
 *   skills/archive/<ts>_<name>/  snapshots taken before each promotion
 * Root-level skills/<name>/ from Phase 0 still counts as active (compat).
 * Promotion is move-based and each promote snapshots the incumbent so a
 * bench regression can roll back - the DGM/GDPevo lesson: no promotion
 * without a gate, no gate without a rollback path.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SkillState = 'draft' | 'active' | 'archived';

export interface SkillEntry {
  name: string;
  description: string;
  file: string;
  state: SkillState;
}

export async function listSkills(home: string): Promise<SkillEntry[]> {
  const root = join(home, 'skills');
  // Phase 0 layout: skills/<name>/SKILL.md directly under root (excluding lifecycle dirs)
  const legacy = await scan(join(root), ['draft', 'active', 'archive'], 'active');
  const active = await scan(join(root, 'active'), [], 'active');
  return [...legacy, ...active].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDrafts(home: string): Promise<SkillEntry[]> {
  return scan(join(home, 'skills', 'draft'), [], 'draft');
}

async function scan(dir: string, exclude: string[], state: SkillState): Promise<SkillEntry[]> {
  let dirs;
  try {
    dirs = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !exclude.includes(d.name));
  } catch {
    return [];
  }
  const entries: SkillEntry[] = [];
  for (const d of dirs) {
    const file = join(dir, d.name, 'SKILL.md');
    try {
      entries.push({ name: d.name, description: parseDescription(await readFile(file, 'utf8')), file, state });
    } catch {
      /* directory without SKILL.md - not a skill */
    }
  }
  return entries;
}

export function skillsToPrompt(entries: SkillEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}

/** Write (or overwrite) a draft; drafts are cheap and reversible by deletion. */
export async function writeDraft(home: string, name: string, skillMd: string): Promise<string> {
  const dir = join(home, 'skills', 'draft', sanitize(name));
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(file, skillMd, 'utf8');
  return file;
}

/**
 * Promote a draft to active. If an active skill with the same name exists
 * it is archived first (timestamped snapshot) so promoteSkill is always
 * reversible via rollbackSkill.
 */
export async function promoteSkill(home: string, name: string): Promise<{ file: string; archivedPrevious: boolean }> {
  const safe = sanitize(name);
  const draftDir = join(home, 'skills', 'draft', safe);
  const activeDir = join(home, 'skills', 'active', safe);
  const legacyDir = join(home, 'skills', safe);
  await mkdir(join(home, 'skills', 'active'), { recursive: true });
  await mkdir(join(home, 'skills', 'archive'), { recursive: true });

  let archivedPrevious = false;
  for (const existing of [activeDir, legacyDir]) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await rename(existing, join(home, 'skills', 'archive', `${stamp}_${safe}`));
      archivedPrevious = true;
    } catch {
      /* nothing at this path */
    }
  }
  await rename(draftDir, activeDir);
  return { file: join(activeDir, 'SKILL.md'), archivedPrevious };
}

/** Restore the most recent archived snapshot of a skill back to active. */
export async function rollbackSkill(home: string, name: string): Promise<boolean> {
  const safe = sanitize(name);
  const archiveRoot = join(home, 'skills', 'archive');
  let snapshots: string[];
  try {
    snapshots = (await readdir(archiveRoot)).filter((d) => d.endsWith(`_${safe}`)).sort();
  } catch {
    return false;
  }
  const latest = snapshots.pop();
  if (!latest) return false;
  await mkdir(join(home, 'skills', 'active'), { recursive: true });
  // Move the regressed incumbent out of the way first (rename onto an
  // existing directory fails on Windows), keeping it as a rejected snapshot.
  for (const cur of [join(home, 'skills', 'active', safe), join(home, 'skills', safe)]) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await rename(cur, join(archiveRoot, `rejected-${stamp}_${safe}`));
      break;
    } catch {
      /* nothing at this path */
    }
  }
  await rename(join(archiveRoot, latest), join(home, 'skills', 'active', safe));
  return true;
}

/** Demote an active skill back to draft without deleting anything. */
export async function unpromoteSkill(home: string, name: string): Promise<boolean> {
  const safe = sanitize(name);
  for (const from of [join(home, 'skills', 'active', safe), join(home, 'skills', safe)]) {
    try {
      await mkdir(join(home, 'skills', 'draft'), { recursive: true });
      await rename(from, join(home, 'skills', 'draft', safe));
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function deleteDraft(home: string, name: string): Promise<boolean> {
  try {
    await rm(join(home, 'skills', 'draft', sanitize(name)), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'skill';
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
