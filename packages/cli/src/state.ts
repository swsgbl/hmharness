/**
 * @hmharness/cli - state (HMH_HOME backup / restore / list)
 * The evolution state (skills + memory + insights + evolution logs + bench
 * cases + pareto archive) is a single-point asset: one corrupted JSONL and
 * the agent's entire learning history is gone. `hmh state backup` snapshots
 * the irreplaceable parts into HMH_HOME/backups/<timestamp>/ as plain files
 * (no archive format - restorable by copy even with a broken toolchain);
 * `hmh state restore` swaps one back AFTER parking the current state in a
 * .pre-restore-<ts> safety copy, so a botched restore is itself restorable.
 */
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The irreplaceable set. `sessions/` (large, and evidence rather than
 *  state) is only included with --full. */
const STATE_ITEMS = [
  'config.json',
  'workspaces.json',
  'memory.md',
  'memory',
  'skills',
  'insights',
  'evolution',
  'bench',
  'ops',
] as const;

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function backupsDir(home: string): string {
  return join(home, 'backups');
}

/** Timestamped backup id: sorts lexicographically == chronologically. */
export async function backupState(home: string, opts: { full?: boolean } = {}): Promise<{ id: string; items: string[]; dir: string }> {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(backupsDir(home), id);
  await mkdir(dir, { recursive: true });
  const items: string[] = [...STATE_ITEMS];
  if (opts.full) items.push('sessions');
  const copied: string[] = [];
  for (const item of items) {
    const src = join(home, item);
    if (await exists(src)) {
      await cp(src, join(dir, item), { recursive: true });
      copied.push(item);
    }
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    time: new Date().toISOString(),
    full: opts.full === true,
    items: copied,
  }, null, 2), 'utf8');
  return { id, items: copied, dir };
}

export interface BackupInfo {
  id: string;
  time: string;
  full: boolean;
  items: string[];
}

export async function listBackups(home: string): Promise<BackupInfo[]> {
  const dir = backupsDir(home);
  if (!await exists(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue;
    try {
      const m = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, name, 'manifest.json'), 'utf8'));
      out.push({ id: name, time: m.time, full: m.full === true, items: m.items ?? [] });
    } catch { /* not a backup dir - skip */ }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Restore by id (or the latest when omitted). The CURRENT state is parked
 *  in backups/.pre-restore-<ts>/ before anything is copied back, so a wrong
 *  pick is undoable. Only items present in the backup are restored. */
export async function restoreState(home: string, id?: string): Promise<{ id: string; restored: string[]; parked: string }> {
  const backups = await listBackups(home);
  if (backups.length === 0) throw new Error('no backups found - run "hmh state backup" first');
  const chosen = id ? backups.find((b) => b.id === id) : backups[0];
  if (!chosen) throw new Error(`no backup matches "${id}" (available: ${backups.map((b) => b.id).join(', ')})`);

  // 1. park the current state
  const parkId = `.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const parkDir = join(backupsDir(home), parkId);
  await mkdir(parkDir, { recursive: true });
  for (const item of chosen.items) {
    const cur = join(home, item);
    if (await exists(cur)) await rename(cur, join(parkDir, item));
  }

  // 2. copy the backup in
  const src = join(backupsDir(home), chosen.id);
  const restored: string[] = [];
  for (const item of chosen.items) {
    if (await exists(join(src, item))) {
      await cp(join(src, item), join(home, item), { recursive: true });
      restored.push(item);
    }
  }
  return { id: chosen.id, restored, parked: parkDir };
}

/** Remove a backup by id (or all with --all). Refuses to touch anything
 *  that is not under backups/, and refuses the newest backup unless --all. */
export async function removeBackup(home: string, id: string, opts: { all?: boolean } = {}): Promise<string[]> {
  const backups = await listBackups(home);
  const targets = opts.all ? backups : backups.filter((b) => b.id === id);
  if (!opts.all && targets.length === 0) throw new Error(`no backup matches "${id}"`);
  const removed: string[] = [];
  for (const t of targets) {
    await rm(join(backupsDir(home), t.id), { recursive: true, force: true });
    removed.push(t.id);
  }
  return removed;
}
