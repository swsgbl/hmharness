import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../prompt.ts';
import { isTrivialTask } from '../runner.ts';

test('system prompt states host facts the model cannot guess', () => {
  const p = buildSystemPrompt({ cwd: 'G:\\work', home: 'C:\\Users\\x\\.hmharness', memory: '', skills: '', insights: '', model: 'm1' });
  assert.ok(p.includes(process.platform), 'platform stated');
  assert.ok(p.includes('HMH_HOME'), 'state home stated');
  assert.ok(p.includes('127.0.0.1'), 'local probe guidance present');
  assert.ok(p.includes('Never scan a whole drive'), 'anti-fullscan rule present');
  assert.ok(p.includes('switch strategy'), 'fail-twice rule present');
  if (process.platform === 'win32') {
    assert.ok(p.includes('findstr'), 'cmd equivalents present on win32');
    assert.ok(p.includes('NOT bash'), 'shell identity explicit on win32');
  }
});

test('memory/skills/insights sections inject when provided', () => {
  const p = buildSystemPrompt({ cwd: '/w', home: '/h', memory: 'NOTE-X', skills: 'SKILL-Y', insights: 'INSIGHT-Z', model: 'm' });
  assert.ok(p.includes('NOTE-X') && p.includes('SKILL-Y') && p.includes('INSIGHT-Z'));
});

test('prompt contains Codex-origin instructions: persist, plan, parallel, git discipline', () => {
  const p = buildSystemPrompt({ cwd: '/w', home: '/h', memory: '', skills: '', insights: '', model: 'm' });
  for (const kw of ['Persist until the task is fully handled', 'outline your approach in 2-4 steps',
    'invoke them in the same turn', 'NEVER revert existing changes', 'edit_file',
    'code review mindset']) {
    assert.ok(p.includes(kw), 'missing: ' + kw);
  }
});

test('prompt contains DeepSeek-origin instructions: phased execution, challenge risk, user feedback', () => {
  const p = buildSystemPrompt({ cwd: '/w', home: '/h', memory: '', skills: '', insights: '', model: 'm' });
  assert.ok(p.includes('work in phases'), 'missing phased-execution');
  assert.ok(p.includes('raise it proactively'), 'missing challenge-risk');
  assert.ok(p.includes('ground truth'), 'missing user-feedback');
});

test('AGENTS.md injected when provided; omitted when absent', () => {
  const withMd = buildSystemPrompt({ cwd: '/w', home: '/h', memory: '', skills: '', insights: '', model: 'm', agentsMd: 'Use the fm engine, never hvigor.' });
  assert.ok(withMd.includes('Use the fm engine, never hvigor.'));
  assert.ok(withMd.includes('Project-level instructions'));
  const withoutMd = buildSystemPrompt({ cwd: '/w', home: '/h', memory: '', skills: '', insights: '', model: 'm' });
  assert.ok(!withoutMd.includes('Project-level instructions'));
});

test('identity anchor at the END of the prompt (overrides base model identity)', () => {
  const p = buildSystemPrompt({ cwd: '/w', home: '/h', memory: 'm', skills: 's', insights: 'i', model: 'agnes-2.5-flash' });
  // identity block is the LAST section, after memory/skills/insights
  const lastIdentity = p.lastIndexOf('You are hmh');
  const lastInsight = p.lastIndexOf('## Recent session outcomes');
  assert.ok(lastIdentity > lastInsight, 'identity anchor comes AFTER all injections');
  assert.ok(p.includes('When asked "who are you"'), 'self-intro guidance present');
  assert.ok(p.includes('NOT the base model'), 'explicit override instruction present');
});

test('trivial task detection: greetings and identity questions skip injection', () => {
  // greetings
  assert.equal(isTrivialTask('你好'), true);
  assert.equal(isTrivialTask('hello'), true);
  assert.equal(isTrivialTask('hi'), true);
  // identity questions
  assert.equal(isTrivialTask('你是谁'), true);
  assert.equal(isTrivialTask('介绍你自己'), true);
  assert.equal(isTrivialTask('介绍一下自己'), true);
  assert.equal(isTrivialTask('who are you'), true);
  assert.equal(isTrivialTask('introduce yourself'), true);
  // acknowledgments
  assert.equal(isTrivialTask('谢谢'), true);
  assert.equal(isTrivialTask('ok'), true);
  assert.equal(isTrivialTask('好的'), true);
  // NOT trivial
  assert.equal(isTrivialTask('构建这个项目'), false);
  assert.equal(isTrivialTask('read the config file and fix the timeout'), false);
  assert.equal(isTrivialTask('a'.repeat(120)), false); // too long
});
