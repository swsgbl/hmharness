/**
 * `replayableConversation`: a conversation as a provider takes it back
 * (2026-11-26). Every surface continues a thread through this function, so it
 * is pinned on the shapes that get a request rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayableConversation } from '../session.ts';
import type { ChatMessage } from '../types.ts';

const call = (id: string): NonNullable<ChatMessage['tool_calls']>[number] => ({ id, type: 'function', function: { name: 'noop', arguments: '{}' } });
const result = (id: string, content: string): ChatMessage => ({ role: 'tool', tool_call_id: id, name: 'noop', content });

test('a complete conversation passes through unchanged, minus the system prompt', () => {
  const thread: ChatMessage[] = [
    { role: 'system', content: 'the prompt of an earlier run' },
    { role: 'user', content: 'do it', images: ['data:image/png;base64,AAA'] },
    { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')] },
    result('c1', 'one'),
    result('c2', 'two'),
    { role: 'assistant', content: 'done' },
    { role: 'system', content: '[turn checkpoint] a note from an earlier run' },
  ];
  assert.deepEqual(replayableConversation(thread), [
    thread[1], thread[2], thread[3], thread[4], thread[5],
  ]);
});

test('a call whose result never landed is dropped together with its call', () => {
  // the run was killed mid-batch: the assistant asked for two tools, one answered
  const thread: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')] },
    result('c1', 'one'),
  ];
  const out = replayableConversation(thread);
  assert.deepEqual(out, [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [call('c1')] },
    result('c1', 'one'),
  ]);
});

test('an assistant step left with no answered call loses its tool_calls entirely', () => {
  const thread: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'checking', tool_calls: [call('c1')] },
  ];
  assert.deepEqual(replayableConversation(thread), [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'checking' },
  ]);
  // and the input is not mutated
  assert.equal(thread[1]!.tool_calls?.length, 1);
});

test('an assistant step left with no answered call and no text leaves the conversation', () => {
  // the common killed-mid-batch shape: the step that asked for the tool had no text
  const thread: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')] },
  ];
  assert.deepEqual(replayableConversation(thread), [{ role: 'user', content: 'do it' }]);
  // whitespace only is no text either
  assert.deepEqual(replayableConversation([{ role: 'assistant', content: '  ', tool_calls: [call('c1')] }]), []);
  // an empty reply recorded by an older run (it ended the run back then)
  assert.deepEqual(replayableConversation([{ role: 'user', content: 'do it' }, { role: 'assistant', content: null }, { role: 'assistant', content: 'done' }]),
    [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'done' }]);
});

test('a tool result that answers nothing in the conversation is dropped', () => {
  const thread: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    result('orphan', 'nobody asked'),
    { role: 'assistant', content: 'done' },
  ];
  assert.deepEqual(replayableConversation(thread), [thread[0], thread[2]]);
});

test('a loaded rollout (ids paired in order by loadTranscript) stays whole across several turns', () => {
  const thread: ChatMessage[] = [];
  for (let n = 1; n <= 3; n++) {
    thread.push({ role: 'user', content: 'turn ' + n });
    thread.push({ role: 'assistant', content: null, tool_calls: [call('c' + n)] });
    thread.push(result('c' + n, 'out ' + n));
    thread.push({ role: 'assistant', content: 'answer ' + n });
  }
  assert.equal(replayableConversation(thread).length, thread.length);
});
