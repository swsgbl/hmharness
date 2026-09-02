import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, type LoopEvents } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

/** Fake provider that returns one assistant turn with N tool calls, then a final text. */
function fakeProvider(calls: number, text: string) {
  let turn = 0;
  return {
    baseUrl: 'x', apiKey: 'k', model: 'fake',
    async chat(_cfg: unknown, _msgs: unknown, _tools?: unknown, opts?: { onDelta?(k: string, c: string): void }) {
      turn++;
      opts?.onDelta?.('text', 'chunk');
      if (turn === 1) {
        const list = Array.from({ length: calls }, (_, i) => ({
          id: `c${i}`,
          function: { name: 'slow', arguments: JSON.stringify({ i }) },
        }));
        return { message: { role: 'assistant' as const, content: null, tool_calls: list }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }
      return { message: { role: 'assistant' as const, content: text }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
}

const slowTool: Tool = {
  name: 'slow',
  description: 'sleeps 150ms',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    await new Promise((r) => setTimeout(r, 150));
    return { output: 'done' };
  },
};

test('parallel tool execution: 4 slow calls cost ~1x, not 4x', async () => {
  const reg = new Registry();
  reg.register(slowTool);
  const t0 = Date.now();
  const r = await runLoop({
    provider: fakeProvider(4, 'ok') as never,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: fakeProvider(4, 'ok').chat as never,
  });
  const ms = Date.now() - t0;
  assert.equal(r.text, 'ok');
  assert.equal(r.toolUses, 4);
  assert.ok(ms < 420, `expected ~150-300ms, got ${ms}ms (sequential would be 600+)`);
});

test('approval gate stays sequential and denials short-circuit', async () => {
  let asked = 0;
  const gated: Tool = {
    name: 'slow',
    description: 'gated',
    parameters: { type: 'object', properties: {}, required: [] },
    needsApproval: () => true,
    async execute() { return { output: 'ran' }; },
  };
  const reg = new Registry();
  reg.register(gated);
  const results: string[] = [];
  const events: LoopEvents = { onToolResult: (n, o, e) => results.push(`${n}:${e ? 'err' : o}`) };
  await runLoop({
    provider: fakeProvider(3, 'done') as never,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    approval: { ask: async () => { asked++; return asked === 1; } }, // first granted, rest denied
    events,
    chatImpl: fakeProvider(3, 'done').chat as never,
  });
  assert.equal(asked, 3, 'each call asked individually');
  assert.equal(results.filter((x) => x === 'slow:ran').length, 1);
  assert.equal(results.filter((x) => x.endsWith('err')).length, 2);
});
