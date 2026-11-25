import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDescription, skillsToPrompt, type SkillEntry } from '../skills.ts';

// 2026-11-25 技能正文可达性。系统提示词的技能清单原来每行只有 "名字: 描述", 不带文件位置,
// 而 SKILL.md 分布在 skills\<name>\、skills\active\<name>\、skills\canary\<name>\ 三处,
// 模型只能猜。对会话历史的审计: 注入了技能的 2228 个会话里只有 43 个(1.9%)读到过技能正文,
// 77 次读取里 23 次因为猜错路径失败。清单每行加目录标记, "标记 → 路径"的图例在系统提示词里。
const SEP = process.platform === 'win32' ? '\\' : '/';
const HOME = [SEP === '\\' ? 'C:\\Users\\u' : '/home/u', '.hmharness'].join(SEP);
const file = (...parts: string[]) => [HOME, 'skills', ...parts, 'SKILL.md'].join(SEP);
const entry = (name: string, f: string, state: SkillEntry['state'] = 'active'): SkillEntry => ({ name, description: `does ${name}`, file: f, state });

test('skillsToPrompt tags the sub-folder a SKILL.md lives in; top-level skills carry no tag', () => {
  const out = skillsToPrompt([
    entry('legacy-skill', file('legacy-skill')),
    entry('active-skill', file('active', 'active-skill'), 'active'),
    entry('canary-skill', file('canary', 'canary-skill'), 'canary'),
    entry('draft-skill', file('draft', 'draft-skill'), 'draft'),
  ]);
  assert.equal(out, [
    '- legacy-skill: does legacy-skill',
    '- active-skill [active]: does active-skill',
    '- canary-skill [canary]: does canary-skill',
    '- draft-skill [draft]: does draft-skill',
  ].join('\n'));
});

test('skillsToPrompt stays a plain list: name and description first, missing description kept, unknown root untagged', () => {
  const out = skillsToPrompt([
    entry('odd', [SEP === '\\' ? 'D:\\elsewhere' : '/elsewhere', 'odd', 'SKILL.md'].join(SEP)),
    { name: 'bare', description: '', file: '', state: 'active' },
  ]);
  assert.equal(out, '- odd: does odd\n- bare: (no description)');
  assert.equal(skillsToPrompt([]), '');
});

test('skillsToPrompt uses the LAST skills/ segment, so a home that itself ends in "skills" still resolves', () => {
  const tricky = [SEP === '\\' ? 'C:\\x\\skills' : '/x/skills', 'skills', 'canary', 's', 'SKILL.md'].join(SEP);
  assert.equal(skillsToPrompt([entry('s', tricky, 'canary')]), '- s [canary]: does s');
});

// ---- 描述提取 ----
// 同一真实技能库: 107 个在册技能里 65 个是带标准 frontmatter 的 CRLF 文件, 里面有真正的
// description 字段, 但只认 LF 的正则匹配不到 frontmatter, 回落后取到的是 frontmatter 里的
// "name: <技能名>" 那一行 —— 模型看到的是 "- ab-testing: name: ab-testing", 无从知道技能是做什么的。
test('parseDescription reads the frontmatter description with LF and with CRLF line endings', () => {
  const lf = '---\nname: a\ndescription: Does A.\n---\n# A\nbody\n';
  assert.equal(parseDescription(lf), 'Does A.');
  assert.equal(parseDescription(lf.replace(/\n/g, '\r\n')), 'Does A.');
});

test('parseDescription unfolds a folded block scalar and strips matching quotes', () => {
  assert.equal(
    parseDescription('---\r\ndescription: >-\r\n  Use when the user wants to plan an A/B test\r\n  or analyse experiment results.\r\nname: ab\r\n---\r\n'),
    'Use when the user wants to plan an A/B test or analyse experiment results.',
  );
  assert.equal(parseDescription('---\ndescription: |\n  Line one.\n  Line two.\n---\n'), 'Line one. Line two.');
  assert.equal(parseDescription('---\ndescription: "Quoted desc."\n---\n'), 'Quoted desc.');
});

test('parseDescription: frontmatter without a description falls through to the BODY, never to another frontmatter field', () => {
  assert.equal(parseDescription('---\nname: only-name\n---\n# Title\nFirst body line.\n'), 'First body line.');
  assert.equal(parseDescription('---\r\nname: only-name\r\nmetadata:\r\n  version: 1\r\n---\r\n'), '');
  assert.equal(parseDescription('# Title\nNo frontmatter here.\n'), 'No frontmatter here.');
  assert.equal(parseDescription('# Title\n---\n'), '');
});
