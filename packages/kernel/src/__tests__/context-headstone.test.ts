import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, compactWithEvictions, transcriptChars, HEADSTONE_CHARS } from '../context.ts';
import type { ChatMessage } from '../types.ts';

function makeLong(n: number, toolOutputSize = 5000): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do things' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: 'thinking about step ' + i, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'probe', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: 'c' + i, name: 'probe', content: 'FINDING-' + i + ': ' + 'x'.repeat(toolOutputSize) });
  }
  return msgs;
}

test('headstone: pruned tool results keep their first ~200 chars (the finding), not a zero-info tombstone', () => {
  const msgs = makeLong(40); // ~200K chars, over the 160K default budget
  const out = compactMessages(msgs);
  assert.ok(transcriptChars(out) <= 160_000, 'compaction brings the transcript under budget');
  const pruned = out.filter((m) => m.role === 'tool' && String(m.content).includes('pruned to fit budget'));
  assert.ok(pruned.length > 0, 'some tool results were pruned');
  for (const m of pruned) {
    const c = String(m.content);
    assert.match(c, /FINDING-\d+/, 'the headstone carries the finding line');
    assert.ok(c.length <= HEADSTONE_CHARS + 80, 'headstone is short (head + framing)');
  }
});

test('headstone: compaction with evictions also preserves heads and reports evicted chars', () => {
  const msgs = makeLong(40);
  const { messages, evictedChars } = compactWithEvictions(msgs, 160_000);
  assert.ok(evictedChars > 0, 'eviction happened');
  const withHeads = messages.filter((m) => m.role === 'tool' && String(m.content).includes('FINDING-'));
  assert.ok(withHeads.length > 0, 'pruned results still carry their finding heads');
});
