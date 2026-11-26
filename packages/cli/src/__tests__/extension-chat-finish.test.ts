import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChatTurn } from '../extension-chat.ts';
import type { ChatTurnInput } from '@hmharness/extension';

/** What the sidebar brain does with finish_reason (2026-11-26).
 *
 *  The provider layer dropped the reason until 0.23.55, so the panel could not
 *  tell a reply the output cap severed from a finished one: half a sentence came
 *  back as the whole answer, and a content-filtered reply read as a bug
 *  ("模型返回了空回复"). The severed tool arguments then went back into the
 *  history raw, where every strict provider 400s the very next request. */

/** A model that returns each scripted response VERBATIM as the provider layer hands it over
 *  (ChatResponse: finishReason, unparseable arguments). */
function rawChat(script: unknown[]) {
  let i = 0;
  const calls: unknown[][] = [];
  const impl = async (_cfg: unknown, messages: unknown[]) => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    const res = script[Math.min(i++, script.length - 1)]!;
    return JSON.parse(JSON.stringify(res));
  };
  return { impl, calls };
}

const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm' } as never;
const INPUT: ChatTurnInput = { message: '总结这个页面', history: [] };
const DEPS = { readPage: async () => ({ title: 'T' }), act: async () => { throw new Error('不应触发'); } };

test('a reply the output cap severed joins the auto-continue chain instead of passing as the whole answer', async () => {
  // round 1 of 50 - not the last round, so before 0.23.55 this came back as a FINAL answer
  const { impl } = rawChat([{ message: { role: 'assistant', content: '第一步先打开' }, finishReason: 'length' }]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.equal(reply, '第一步先打开\n[[hmh:auto-continue]]', 'the panel auto-sends 「继续」 on this sentinel');
});

test('a complete reply on the same round is returned as is (no sentinel)', async () => {
  const { impl } = rawChat([{ message: { role: 'assistant', content: '页面讲的是测试桥' }, finishReason: 'stop' }]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.equal(reply, '页面讲的是测试桥');
});

test('a content-filtered empty reply says so - it is not "the model returned nothing"', async () => {
  const { impl } = rawChat([{ message: { role: 'assistant', content: '' }, finishReason: 'content_filter' }]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.match(reply, /content_filter/);
  assert.doesNotMatch(reply, /空回复/);
});

test('an empty reply with no reason keeps the old wording', async () => {
  const { impl } = rawChat([{ message: { role: 'assistant', content: '' } }]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.equal(reply, '(模型返回了空回复)');
});

test('a tool call the cap severed: the model hears about the limit, and the broken JSON never re-enters the request', async () => {
  const { impl, calls } = rawChat([
    { message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'page_act', arguments: '{"action":"click","selector":"#very-long' } }] }, finishReason: 'length' },
    { message: { role: 'assistant', content: '好了' } },
  ]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.equal(reply, '好了');
  const second = calls[1]! as Array<{ role: string; content: string | null; tool_calls?: Array<{ function: { arguments: string } }>; tool_call_id?: string }>;
  const toolMsg = second.find((m) => m.tool_call_id === 'w1')!;
  assert.match(toolMsg.content!, /输出长度已到上限/);
  assert.match(toolMsg.content!, /page_act/, 'names the call that was cut');
  const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls)!;
  assert.equal(assistant.tool_calls![0]!.function.arguments, '{}', 'the stored copy is sanitized: a strict provider accepts the next request');
});

test('broken arguments with no cap involved: the plain parse error, still sanitized on replay', async () => {
  const { impl, calls } = rawChat([
    { message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'page_act', arguments: '{"action":' } }] } },
    { message: { role: 'assistant', content: '好了' } },
  ]);
  const reply = await runChatTurn(CFG, INPUT, DEPS, impl as never);
  assert.equal(reply, '好了');
  const second = calls[1]! as Array<{ role: string; content: string | null; tool_calls?: Array<{ function: { arguments: string } }>; tool_call_id?: string }>;
  const toolMsg = second.find((m) => m.tool_call_id === 'w1')!;
  assert.match(toolMsg.content!, /JSON/, 'the raw parse error is still what the model sees');
  assert.doesNotMatch(toolMsg.content!, /输出长度/);
  const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls)!;
  assert.equal(assistant.tool_calls![0]!.function.arguments, '{}');
});
