import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillPayload } from '../skillpayload.ts';

test('loadSkillPayload: draft content wins over bare name (day-49 instrument fix)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pay-'));
  try {
    await mkdir(join(home, 'skills', 'drafts'), { recursive: true });
    const md = '# verify-before-claim\n\nattach evidence lines. references not rules';
    await writeFile(join(home, 'skills', 'drafts', 'verify-before-claim.md'), md, 'utf8');
    const out = await loadSkillPayload(home, 'verify-before-claim');
    assert.match(out, /# verify-before-claim/);
    assert.match(out, /references not rules/);
    // no draft -> promoted copy
    const out2 = await loadSkillPayload(home, 'never-drafted-but-promoted');
    assert.equal(out2, 'never-drafted-but-promoted', 'falls back to the raw string so the arm still runs');
    // empty payload -> empty string
    assert.equal(await loadSkillPayload(home, ''), '');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('loadSkillPayload: promoted skills/ copy used when no draft exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-pay2-'));
  try {
    await mkdir(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'skills', 'live-skill.md'), '# live\nbody', 'utf8');
    const out = await loadSkillPayload(home, 'live-skill');
    assert.match(out, /# live/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
