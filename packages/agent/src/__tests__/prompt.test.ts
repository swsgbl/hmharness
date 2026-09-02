import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../prompt.ts';

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
