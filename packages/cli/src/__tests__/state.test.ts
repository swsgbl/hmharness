import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupState, listBackups, restoreState, removeBackup } from '../state.ts';

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-state-'));
  await mkdir(join(home, 'skills', 'demo'), { recursive: true });
  await mkdir(join(home, 'evolution'), { recursive: true });
  await writeFile(join(home, 'config.json'), '{"v":1}', 'utf8');
  await writeFile(join(home, 'skills', 'demo', 'SKILL.md'), '# demo skill\n', 'utf8');
  await writeFile(join(home, 'evolution', 'log.jsonl'), '{"cycle":1}\n', 'utf8');
  return home;
}

test('state: backup -> mutate -> restore round trip; current state parked, not destroyed', async () => {
  const home = await seedHome();
  try {
    // backup
    const b = await backupState(home);
    assert.ok(b.items.includes('skills') && b.items.includes('config.json'));
    const saved = await readFile(join(b.dir, 'skills', 'demo', 'SKILL.md'), 'utf8');
    assert.equal(saved, '# demo skill\n');

    // mutate: wipe skills, corrupt config (the "one bad JSONL" scenario)
    await rm(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'config.json'), 'CORRUPTED', 'utf8');

    // restore latest (no id)
    const r = await restoreState(home);
    assert.equal(r.id, b.id);
    const cfg = await readFile(join(home, 'config.json'), 'utf8');
    assert.equal(cfg, '{"v":1}', 'backup content is back');
    const skill = await readFile(join(home, 'skills', 'demo', 'SKILL.md'), 'utf8');
    assert.equal(skill, '# demo skill\n');

    // the corrupted pre-restore state was parked, not silently destroyed
    await stat(join(r.parked, 'config.json'));
    assert.equal(await readFile(join(r.parked, 'config.json'), 'utf8'), 'CORRUPTED');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('state: list reports backups newest-first; remove cleans up', async () => {
  const home = await seedHome();
  try {
    const a = await backupState(home);
    await new Promise((res) => setTimeout(res, 20)); // ids are timestamp-based
    const b = await backupState(home);
    const list = await listBackups(home);
    assert.deepEqual(list.map((x) => x.id), [b.id, a.id], 'newest first');

    const removed = await removeBackup(home, a.id);
    assert.deepEqual(removed, [a.id]);
    assert.equal((await listBackups(home)).length, 1);

    // restore by explicit id still works after removal of the other
    const r = await restoreState(home, b.id);
    assert.equal(r.restored.includes('skills'), true);
    await assert.rejects(() => restoreState(home, 'no-such-id'), /no backup matches/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('state: backup without --full skips sessions/, --full includes it', async () => {
  const home = await seedHome();
  try {
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', 's1.jsonl'), '{}\n', 'utf8');
    const lean = await backupState(home);
    assert.equal(lean.items.includes('sessions'), false);
    const full = await backupState(home, { full: true });
    assert.equal(full.items.includes('sessions'), true);
    await readFile(join(full.dir, 'sessions', 's1.jsonl'), 'utf8');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
