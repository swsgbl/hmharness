import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

/** Scripted chat: turns 1..N issue the given tool calls, then a final answer. */
function scriptedChat(script: Array<{ calls?: Array<{ name: string; args: string }>; text?: string | null }>) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    const calls = step.calls?.map((c, j) => ({ id: 'call_' + i + '_' + j, type: 'function' as const, function: { name: c.name, arguments: c.args } }));
    return {
      message: { role: 'assistant' as const, content: step.text ?? null, ...(calls ? { tool_calls: calls } : {}) },
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  };
}

function countingTool(name: string): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    name, description: 'test tool',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    async execute() { calls++; return { output: 'RESULT for q=abc: the answer is 42' }; },
  };
  return { tool, calls: () => calls };
}

const fakeProvider = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;

test('repeat-call dedup: identical tool calls get the cached result, tool executes once', async () => {
  const { tool, calls } = countingTool('search');
  const reg = new Registry();
  reg.register(tool);
  const chat = scriptedChat([
    { calls: [{ name: 'search', args: '{"q":"abc"}' }], text: null },
    { calls: [{ name: 'search', args: '{"q":"abc"}' }], text: null },
    { calls: [{ name: 'search', args: '{"q":"abc"}' }], text: null },
    { text: 'done' },
  ]);
  const r = await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'find it' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: chat as never,
  });
  assert.equal(r.reason, 'final');
  assert.equal(calls(), 1, 'executed exactly ONCE - the 2nd and 3rd identical calls got the cached head');
  const cached = r.messages.filter((m) => m.role === 'tool' && String(m.content).includes('already ran'));
  assert.equal(cached.length, 2, 'two cache reminders in the transcript');
});

test('different args bypass dedup (the tool executes each time)', async () => {
  const { tool, calls } = countingTool('search');
  const reg = new Registry();
  reg.register(tool);
  const chat = scriptedChat([
    { calls: [{ name: 'search', args: '{"q":"abc"}' }], text: null },
    { calls: [{ name: 'search', args: '{"q":"xyz"}' }], text: null },
    { text: 'done' },
  ]);
  await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: chat as never,
  });
  assert.equal(calls(), 2, 'different arguments = real executions');
});
