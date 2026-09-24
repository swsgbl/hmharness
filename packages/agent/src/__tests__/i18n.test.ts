import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strings } from '../i18n.ts';

test('zh and en dictionaries expose the same keys', () => {
  const zh = strings('zh') as unknown as Record<string, unknown>;
  const en = strings('en') as unknown as Record<string, unknown>;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys);
});

test('default locale is zh; functions render', () => {
  const t = strings();
  assert.match(t.sessionFooter('s1', 2, 3), /s1/);
  assert.match(t.approvalPrompt('write_file', '{}'), /write_file/);
  const en = strings('en');
  assert.match(en.idle, /idle/i);
});

test('cmdResuming renders id/total and the hidden-tail note only when nonzero', () => {
  const zh = strings('zh');
  assert.match(zh.cmdResuming('abc123', 42, 0), /^--- 已恢复会话 abc123 · 42 条消息 ---$/);
  assert.match(zh.cmdResuming('abc123', 120, 40), /前 40 条保留在上下文中/);
  const en = strings('en');
  assert.equal(en.cmdResuming('abc123', 42, 0), '--- resumed abc123 · 42 messages ---');
  assert.match(en.cmdResuming('abc123', 120, 40), /40 earlier kept in context/);
});

test('cmdEvolveHint exists in both locales and points at the full command', () => {
  assert.match(strings('zh').cmdEvolveHint, /hmh evolve/);
  assert.match(strings('en').cmdEvolveHint, /hmh evolve/);
});
