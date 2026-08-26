import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, transcriptChars, DEFAULT_CONTEXT_CHARS } from '../context.ts';
import type { ChatMessage } from '../types.ts';

const mk = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

test('compactMessages: no-op under budget', () => {
  const msgs = [mk('system', 'sys'), mk('user', 'task')];
  const out = compactMessages(msgs, 1000);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'sys');
});

test('compactMessages: prunes oldest tool outputs, protects opening and tail', () => {
  const msgs: ChatMessage[] = [
    mk('system', 'sys'),
    mk('user', 'task'),
    mk('assistant', 'call'),
    ...Array.from({ length: 30 }, (_, i) => mk('tool', 'x'.repeat(1000) + i)),
    mk('assistant', 'tail-answer'),
  ];
  const out = compactMessages(msgs, 8000);
  assert.equal(out[0].content, 'sys');
  assert.equal(out[1].content, 'task');
  assert.equal(out[out.length - 1].content, 'tail-answer');
  const pruned = out.filter((m) => (m.content ?? '').startsWith('[context pruned')).length;
  // tools at idx 3..25 (23 of them) pruned; the last 8 messages (7 tools + tail) stay protected
  assert.equal(pruned, 23);
  assert.ok(transcriptChars(out) < transcriptChars(msgs));
});

test('default budget is sane', () => {
  assert.ok(DEFAULT_CONTEXT_CHARS >= 50_000);
});
