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
