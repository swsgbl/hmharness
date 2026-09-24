import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillMd, validateSkillStructure, crossRuntimeReport } from '../skills-conformance.ts';

const validSkillMd = `---
name: my-skill
description: Does something useful
---

## Usage

Run the skill with the provided arguments.
`;

test('validateSkillMd: valid content passes', () => {
  const r = validateSkillMd(validSkillMd);
  assert.equal(r.valid, true);
  assert.equal(r.level, 'full');
});

test('validateSkillMd: missing frontmatter fails', () => {
  const r = validateSkillMd('no frontmatter here');
  assert.equal(r.valid, false);
  assert.equal(r.level, 'none');
  assert.ok(r.errors.some(e => e.includes('frontmatter')));
});

test('validateSkillMd: missing name field fails', () => {
  const content = validSkillMd.replace('name: my-skill', '');
  const r = validateSkillMd(content);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('name')));
});

test('validateSkillMd: no usage section warns', () => {
  const content = `---\nname: x\ndescription: y\n---\n\nJust text.`;
  const r = validateSkillMd(content);
  assert.equal(r.valid, true); // still valid, just a warning
  assert.equal(r.level, 'partial');
  assert.ok(r.warnings.some(w => w.includes('usage')));
});

test('validateSkillStructure: SKILL.md required', () => {
  const r = validateSkillStructure(['README.md']);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('SKILL.md')));
});

test('validateSkillStructure: full structure', () => {
  const r = validateSkillStructure(['SKILL.md', 'scripts/run.sh', 'references/guide.md', 'assets/icon.png']);
  assert.equal(r.valid, true);
  assert.equal(r.level, 'full');
});

test('crossRuntimeReport: complete skill', () => {
  const s = crossRuntimeReport({ name: 'test', hasSkillMd: true, hasScripts: true, hasReferences: true, hasAssets: true, entryLanguage: 'bash' });
  assert.ok(s.includes('✅'));
  assert.ok(s.includes('compatible'));
});

test('crossRuntimeReport: missing SKILL.md', () => {
  const s = crossRuntimeReport({ name: 'test', hasSkillMd: false, hasScripts: false, hasReferences: false, hasAssets: false });
  assert.ok(s.includes('❌'));
  assert.ok(s.includes('not compatible'));
});
