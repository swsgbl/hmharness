/**
 * loop-gate tests (2026-10-15, v0.24 P2A live intervention):
 * the pre-execution action gate refuses a call BEFORE it runs — the tool
 * never executes, the refusal reason becomes the tool result (the model
 * re-plans), onGate fires for observability, an ALLOW falls through to the
 * normal approval path, and repeated refusals honestly count toward idle
 * detection (an agent that cannot get past the gate IS stuck).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

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

function countingTool(name: string, needsApproval = false): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    name, description: 'test tool',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    needsApproval: needsApproval ? () => true : undefined,
    async execute() { calls++; return { output: `RESULT for ${name}` }; },
  };
  return { tool, calls: () => calls };
}

const fakeProvider = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;

test('gate refusal: tool never executes, reason becomes the tool result, model re-plans', async () => {
  const { tool, calls } = countingTool('write_file');
  const reg = new Registry();
  reg.register(tool);
  const gateEvents: Array<{ name: string; allowed: boolean; reason?: string }> = [];
  const r = await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'do it' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: scriptedChat([
      { calls: [{ name: 'write_file', args: '{"q":"a"}' }], text: null },
      { text: 'ok, I took a different path' },
    ]) as never,
    toolGate: {
      check: async () => ({ allowed: false as const, reason: 'writing to a.txt failed in 4 of 5 similar contexts (world model belief 0.83) - use a different target or verify first' }),
    },
    events: {
      onGate: (name, _args, allowed, reason) => gateEvents.push({ name, allowed, reason }),
    },
  });
  assert.equal(r.reason, 'final');
  assert.equal(calls(), 0, 'the refused tool NEVER executed');
  const refusal = r.messages.find((m) => m.role === 'tool');
  assert.ok(refusal, 'a tool result exists for the refused call');
  assert.match(String(refusal!.content), /\[action gate\]/, 'refusal carries the gate prefix');
  assert.match(String(refusal!.content), /different target/, 'the gate reason reached the model');
  assert.equal(gateEvents.length, 1);
  assert.equal(gateEvents[0].name, 'write_file');
  assert.equal(gateEvents[0].allowed, false);
  assert.match(gateEvents[0].reason ?? '', /world model/);
});

test('gate ALLOW falls through: the tool executes and approval still applies', async () => {
  const { tool, calls } = countingTool('write_file', true);
  const reg = new Registry();
  reg.register(tool);
  let approvals = 0;
  const r = await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'do it' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: scriptedChat([
      { calls: [{ name: 'write_file', args: '{"q":"a"}' }], text: null },
      { text: 'done' },
    ]) as never,
    toolGate: { check: async () => ({ allowed: true as const }) },
    approval: { ask: async () => { approvals++; return true; } },
  });
  assert.equal(calls(), 1, 'allowed + approved = executed');
  assert.equal(approvals, 1, 'the gate ALLOW did not bypass the human approval path');
});

test('gate ALLOW on a no-approval tool: executes directly (gate is invisible)', async () => {
  const { tool, calls } = countingTool('read_file');
  const reg = new Registry();
  reg.register(tool);
  await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: scriptedChat([
      { calls: [{ name: 'read_file', args: '{"q":"a"}' }], text: null },
      { text: 'done' },
    ]) as never,
    toolGate: { check: async () => ({ allowed: true as const }) },
  });
  assert.equal(calls(), 1);
});

test('repeated gate refusals count toward idle detection (stuck is stuck)', async () => {
  const { tool, calls } = countingTool('write_file');
  const reg = new Registry();
  reg.register(tool);
  const r = await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: scriptedChat([
      { calls: [{ name: 'write_file', args: '{"q":"a"}' }], text: null },
    ]) as never,
    toolGate: { check: async () => ({ allowed: false as const, reason: 'blocked for test' }) },
    maxIdleTurns: 3,
  });
  assert.equal(r.reason, 'idle', 'an agent that cannot pass the gate ends as idle, not as a silent infinite loop');
  assert.equal(calls(), 0);
  const refusals = r.messages.filter((m) => m.role === 'tool' && String(m.content).includes('[action gate]'));
  assert.equal(refusals.length, 3, 'three refusal results before the idle valve (maxIdleTurns=3)');
});
