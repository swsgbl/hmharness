import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteDraft, listCanary, listDrafts, listSkills, promoteCanary, promoteSkill, rollbackSkill, unpromoteSkill, writeDraft } from '../skills.ts';

let home: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'hmh-skills-'));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('skill lifecycle: draft -> canary promote -> re-promote archives -> rollback restores', async () => {
  await writeDraft(home, 'ut-skill', '---\nname: ut-skill\ndescription: v1\n---\n# v1\n');
  // default promotion targets canary (P0): the bench gate earns a canary
  // slot, full activation comes from the impact loop's evidence
  await promoteSkill(home, 'ut-skill');
  assert.ok((await listCanary(home)).some((s) => s.name === 'ut-skill'));
  assert.equal((await listDrafts(home)).length, 0);

  await writeDraft(home, 'ut-skill', '---\nname: ut-skill\ndescription: v2\n---\n# v2\n');
  const p2 = await promoteSkill(home, 'ut-skill');
  assert.equal(p2.archivedPrevious, true);

  const ok = await rollbackSkill(home, 'ut-skill');
  assert.equal(ok, true);
  const restored = (await listSkills(home)).find((s) => s.name === 'ut-skill')
    ?? (await listCanary(home)).find((s) => s.name === 'ut-skill');
  assert.match(restored?.description ?? '', /v1/);
});

test('unpromote moves active back to drafts; deleteDraft removes', async () => {
  // after test 1's rollback, v1 sits in skills/active - a normal active skill
  assert.ok((await listSkills(home)).some((s) => s.name === 'ut-skill'));
  assert.equal(await unpromoteSkill(home, 'ut-skill'), true);
  assert.ok((await listDrafts(home)).some((s) => s.name === 'ut-skill'));
  assert.equal(await deleteDraft(home, 'ut-skill'), true);
  assert.equal((await listDrafts(home)).length, 0);
});

test('names are sanitized (path-safety)', async () => {
  await writeDraft(home, 'evil/../name', 'x');
  const drafts = await listDrafts(home);
  assert.ok(drafts.every((d) => !d.name.includes('/') && !d.name.includes('..')));
  await deleteDraft(home, 'evil-name');
});
