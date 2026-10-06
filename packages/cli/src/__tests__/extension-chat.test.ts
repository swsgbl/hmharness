import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChatTurn } from '../extension-chat.ts';
import type { ChatTurnInput } from '@hmharness/extension';

/** fake model: a scripted sequence of responses, one per chat() call */
function fakeChat(script: Array<{ tool_calls?: Array<{ id: string; name: string; args: unknown }>; content?: string }>) {
  const calls: unknown[][] = [];
  let i = 0;
  const impl = async (_cfg: unknown, messages: unknown[], _tools: unknown[]) => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return {
      message: step.tool_calls
        ? { role: 'assistant', content: null, tool_calls: step.tool_calls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) }
        : { role: 'assistant', content: step.content ?? '' },
    };
  };
  return { impl, calls };
}

const INPUT: ChatTurnInput = { message: '总结这个页面', history: [{ role: 'user', content: '早' }, { role: 'assistant', content: '好' }] };
const CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm' } as never;

test('brain: tool loop — page_read result rides back to the model before the answer', async () => {
  const { impl, calls } = fakeChat([
    { tool_calls: [{ id: 'c1', name: 'page_read', args: {} }] },
    { content: '页面讲的是测试桥' },
  ]);
  const reads: number[] = [];
  const reply = await runChatTurn(CFG, INPUT, { readPage: async () => { reads.push(1); return { title: 'T', url: 'u', text: '内容' }; }, act: async () => { throw new Error('不应触发'); } }, impl as never);
  assert.equal(reply, '页面讲的是测试桥');
  assert.equal(reads.length, 1);
  // the second model call saw: system + history + user + assistant(tool_calls) + tool result
  const second = calls[1]! as Array<{ role: string; content: string | null; tool_call_id?: string }>;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message present');
  assert.equal(toolMsg!.tool_call_id, 'c1');
  assert.match(toolMsg!.content!, /"title":"T"/);
  // system prompt carries the page guidance and the user's message survives
  const first = calls[0]! as Array<{ role: string; content: string | null }>;
  assert.match(first[0]!.content!, /hmharness 浏览器助手/);
  assert.equal(first.at(-1)!.content, '总结这个页面');
});

test('brain: page_act is executed with parsed args and audited via log', async () => {
  const { impl, calls } = fakeChat([
    { tool_calls: [{ id: 'c1', name: 'page_act', args: { action: 'click', selector: '#go' } }, { id: 'c2', name: 'nope_tool', args: {} }] },
    { content: 'done' },
  ]);
  const acts: unknown[] = [];
  const logs: string[] = [];
  const reply = await runChatTurn(CFG, { message: '点它', history: [] }, {
    readPage: async () => ({}),
    act: async (a) => { acts.push(a); return { ok: true }; },
    log: (l) => logs.push(l),
  }, impl as never);
  assert.equal(reply, 'done');
  assert.deepEqual(acts, [{ action: 'click', selector: '#go' }]);
  assert.equal(logs.length, 1, 'page_act is audited');
  // the unknown tool got an honest error result, not a crash
  const second = calls[1]! as Array<{ role: string; tool_call_id?: string; content: string | null }>;
  const unknown = second.find((m) => m.tool_call_id === 'c2');
  assert.match(unknown!.content!, /unknown tool nope_tool/);
});

test('brain: rounds cap — an endless tool-caller is cut off honestly', async () => {
  const { impl } = fakeChat([{ tool_calls: [{ id: 'c', name: 'page_read', args: {} }] }]); // repeats forever
  let reads = 0;
  const reply = await runChatTurn(CFG, { message: 'x', history: [] }, { readPage: async () => { reads++; return {}; }, act: async () => ({}) }, impl as never);
  assert.match(reply, /工具调用太多/);
  assert.equal(reads, 6, 'MAX_ROUNDS bounds the loop');
});

test('brain: tool throwing surfaces as an error result, the loop continues', async () => {
  const { impl, calls } = fakeChat([
    { tool_calls: [{ id: 'c1', name: 'page_read', args: {} }] },
    { content: '读取失败,但对话没断' },
  ]);
  const reply = await runChatTurn(CFG, { message: 'x', history: [] }, { readPage: async () => { throw new Error('受保护页面'); }, act: async () => ({}) }, impl as never);
  assert.equal(reply, '读取失败,但对话没断');
  const second = calls[1]! as Array<{ role: string; tool_call_id?: string; content: string | null }>;
  assert.match(second.find((m) => m.role === 'tool')!.content!, /受保护页面/);
});
