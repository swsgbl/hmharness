import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildSystemPrompt } from '../prompt.ts';
import { skillsToPrompt } from '@hmharness/evolution';

// 2026-11-25 技能正文可达性: 清单行带目录标记([active]/[canary]), 系统提示词给出"标记 → 路径"的图例,
// 并且图例里的根目录就是本次会话真实的 HMH_HOME(隔离 home / 多 home 机器上猜不出来)。
test('skill library tells the model where each SKILL.md is, under the real HMH_HOME', () => {
  const home = join(process.cwd(), 'x-home', '.hmharness');
  const root = join(home, 'skills');
  const p = buildSystemPrompt({
    cwd: '/w', home, memory: '', insights: '', model: 'm',
    skills: skillsToPrompt([
      { name: 'top', description: 'd1', file: join(root, 'top', 'SKILL.md'), state: 'active' },
      { name: 'act', description: 'd2', file: join(root, 'active', 'act', 'SKILL.md'), state: 'active' },
    ]),
  });
  assert.ok(p.includes(join(root, '<name>', 'SKILL.md')), 'untagged rule names the real skills root');
  assert.ok(p.includes(join(root, '<tag>', '<name>', 'SKILL.md')), 'tagged rule present');
  assert.ok(p.includes('- top: d1'), 'top-level line untagged');
  assert.ok(p.includes('- act [active]: d2'), 'sub-folder tag on the line');
  assert.ok(p.includes('read_file'), 'still tells the model to read the file before applying');

  const q = buildSystemPrompt({ cwd: '/w', home, memory: '', insights: '', model: 'm', skills: '' });
  assert.ok(!q.includes('<tag>'), 'no legend when there are no skills');
});
