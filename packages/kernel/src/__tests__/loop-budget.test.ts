import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../loop.ts';
import { transcriptChars } from '../context.ts';
import type { ChatMessage } from '../types.ts';

// real glm-class window -> budget 163,840 chars (131072 * 2.5 * 0.5)
const glmWindow = { baseUrl: 'x', apiKey: 'k', model: 'glm-5.3' };

function fakeChat() {
  let turn = 0;
  return async (_cfg: unknown, msgs: ChatMessage[]) => {
    turn++;
    if (turn === 1) {
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } }],
        },
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      };
    }
    return { message: { role: 'assistant' as const, content: `turn-${turn}-done` }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  };
}

test('loop injects budget wrap-up message when context exceeds 80%', async () => {
  // preload transcript with enough content to exceed 80% of the glm budget
  // after the first noop call adds ~50k chars of tool output
  const noop = { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} },
    async execute() { return { output: 'x'.repeat(50_000) }; },
  };
  const registry = { toOpenAITools: () => [], get: () => noop };
  // prefill with large content to simulate a long-running session
  const filler = 'a'.repeat(90_000);
  const messages: ChatMessage[] = [
    { role: 'system', content: filler },
    { role: 'user', content: 'do it' },
  ];
  const result = await runLoop({
    provider: glmWindow,
    registry: registry as never,
    messages,
    ctx: { cwd: '.', home: '.' },
    chatImpl: fakeChat(),
  });
  // after noop executes: 90k filler + 50k tool output > 80% of 163k budget
  const wrapup = result.messages.find((m) => (m.content ?? '').includes('Context is running low'));
  assert.ok(wrapup, 'budget wrap-up message injected');
  assert.equal(wrapup!.role, 'system');
});

test('auto-continue: model calling tools past the soft limit keeps going until it gives a final answer', async () => {
  const noop = { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} },
    async execute() { return { output: 'ok' }; },
  };
  const registry = { toOpenAITools: () => [], get: () => noop };
  let callCount = 0;
  const chat = async () => {
    callCount++;
    if (callCount <= 50) {
      return {
        message: { role: 'assistant' as const, content: null, tool_calls: [{ id: `c${callCount}`, function: { name: 'noop', arguments: '{}' } }] },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }
    return { message: { role: 'assistant' as const, content: 'all done after 50 productive turns' }, usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const result = await runLoop({
    provider: glmWindow, // soft limit 40
    registry: registry as never,
    messages: [{ role: 'user', content: 'long task' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: chat,
  });
  assert.equal(result.turns, 51, 'ran past the 40-turn soft limit to 51 (50 tool calls + 1 final)');
  assert.match(result.text, /all done/);
  const checkpoint = result.messages.find((m) => (m.content ?? '').includes('turn checkpoint'));
  assert.ok(checkpoint, 'soft checkpoint message injected');
});

test('hard turn valve: safety cap stops even if the model keeps calling tools', async () => {
  const noop = { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} },
    async execute() { return { output: 'loop' }; },
  };
  const registry = { toOpenAITools: () => [], get: () => noop };
  const runaway = async () => ({
    message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c', function: { name: 'noop', arguments: '{}' } }] },
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const result = await runLoop({
    provider: glmWindow,
    registry: registry as never,
    messages: [{ role: 'user', content: 'infinite loop' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: runaway,
    maxTotalTurns: 10,
  });
  assert.equal(result.turns, 10, 'stopped at hard cap');
  assert.match(result.text, /Safety turn limit/);
});
