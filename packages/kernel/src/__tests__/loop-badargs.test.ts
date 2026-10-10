import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, sanitizeToolCalls } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

/** Both 2026-10-08 field failures replayed. agnes-3.0-flash emitted a
 *  tool call whose arguments were invalid JSON — once an empty string
 *  (executed with {} and produced a confusing shell error), once a JSON
 *  string truncated mid-write (`{"query'`). Either way the RAW call then
 *  entered the transcript, and the provider 400-rejected the entire next
 *  request ("Assistant tool call arguments must be valid JSON"), killing
 *  the task. These tests pin the fix: skip + clear error + sanitized
 *  replay, and the conversation survives. */

/** One recorded model call = the full message array that call received. */
type SeenMessages = Array<Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>>;

/** Scripted chat that records every message array it is handed. */
function recordingChat(script: Array<{ calls?: Array<{ name: string; args: string }>; text?: string | null }>, seen: SeenMessages) {
  let i = 0;
  return async (_p: unknown, messages: SeenMessages[number][number][]) => {
    seen.push(messages);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    const calls = step.calls?.map((c, j) => ({ id: 'call_' + i + '_' + j, type: 'function' as const, function: { name: c.name, arguments: c.args } }));
    return {
      message: { role: 'assistant' as const, content: step.text ?? null, ...(calls ? { tool_calls: calls } : {}) },
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  };
}

function searchTool(executed: { n: number }): Tool {
  return {
    name: 'web_search', description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    async execute() { executed.n++; return { output: 'results' }; },
  };
}

const fakeProvider = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;

test('empty-string arguments (2026-10-08 failure #1): skipped, sanitized on replay, task survives', async () => {
  const executed = { n: 0 };
  const reg = new Registry();
  reg.register(searchTool(executed));
  const seen: SeenMessages = [];
  const r = await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'install tty7' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: recordingChat([
      { calls: [{ name: 'web_search', args: '' }], text: null },
      { text: 'recovered and done' },
    ], seen) as never,
  });
  assert.equal(r.reason, 'final', 'one malformed call must NOT kill the task');
  assert.equal(r.text, 'recovered and done');
  assert.equal(executed.n, 0, 'a call with invalid-JSON arguments never executes');
  const errResult = r.messages.filter((m) => m.role === 'tool');
  assert.equal(errResult.length, 1);
  assert.match(String(errResult[0].content), /empty tool arguments .*must be valid JSON/, 'the model is told to repeat the call properly');
  // the request the provider received on turn 2 must carry VALID JSON arguments
  const replayed = seen[1].filter((m) => m.role === 'assistant' && m.tool_calls)[0];
  assert.ok(replayed, 'assistant tool_call message replayed to the provider');
  assert.equal(replayed.tool_calls![0].function.arguments, '{}', 'poisoned arguments replaced with {} before the wire');
});

test('truncated JSON arguments (2026-10-08 failure #2): same guarantees', async () => {
  const executed = { n: 0 };
  const reg = new Registry();
  reg.register(searchTool(executed));
  const seen: SeenMessages = [];
  const r = await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'install tty7' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: recordingChat([
      { calls: [{ name: 'web_search', args: '{"query' }], text: null },
      { text: 'recovered and done' },
    ], seen) as never,
  });
  assert.equal(r.reason, 'final');
  assert.equal(executed.n, 0);
  const errResult = r.messages.filter((m) => m.role === 'tool');
  assert.match(String(errResult[0].content), /unparseable tool arguments .*must be valid JSON/);
  const replayed = seen[1].filter((m) => m.role === 'assistant' && m.tool_calls)[0];
  assert.equal(replayed.tool_calls![0].function.arguments, '{}');
});

test('valid arguments pass through byte-for-byte (good models unaffected)', async () => {
  const executed = { n: 0 };
  const reg = new Registry();
  reg.register(searchTool(executed));
  const seen: SeenMessages = [];
  const r = await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'search' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: recordingChat([
      { calls: [{ name: 'web_search', args: '{"query":"l0ng-ai tty7"}' }], text: null },
      { text: 'done' },
    ], seen) as never,
  });
  assert.equal(r.reason, 'final');
  assert.equal(executed.n, 1, 'valid calls execute normally');
  const replayed = seen[1].filter((m) => m.role === 'assistant' && m.tool_calls)[0];
  assert.equal(replayed.tool_calls![0].function.arguments, '{"query":"l0ng-ai tty7"}', 'valid arguments are NOT rewritten');
});

test('sanitizeToolCalls unit: empty, truncated, undefined become {}; valid untouched', () => {
  const out = sanitizeToolCalls([
    { id: 'a', type: 'function' as const, function: { name: 'x', arguments: '' } },
    { id: 'b', type: 'function' as const, function: { name: 'x', arguments: '{"query' } },
    { id: 'c', type: 'function' as const, function: { name: 'x', arguments: undefined as unknown as string } },
    { id: 'd', type: 'function' as const, function: { name: 'x', arguments: '{"q":1}' } },
  ]);
  assert.deepEqual(out.map((c) => c.function.arguments), ['{}', '{}', '{}', '{"q":1}']);
});

/* ---- v0.23.34 hardening contract(02 号路线图 P0):非对象 arguments、
   取消、provider 400、错误可捕获不逃逸 ---- */

test('非对象 arguments(unit):"str"/null/[1,2]/42 都改写为 {},对象原样', () => {
  const out = sanitizeToolCalls([
    { id: 'a', type: 'function' as const, function: { name: 'x', arguments: '"just a string"' } },
    { id: 'b', type: 'function' as const, function: { name: 'x', arguments: 'null' } },
    { id: 'c', type: 'function' as const, function: { name: 'x', arguments: '[1,2]' } },
    { id: 'd', type: 'function' as const, function: { name: 'x', arguments: '42' } },
    { id: 'e', type: 'function' as const, function: { name: 'x', arguments: '{"q":1}' } },
  ]);
  assert.deepEqual(out.map((c) => c.function.arguments), ['{}', '{}', '{}', '{}', '{"q":1}']);
});

test('非对象 arguments(runLoop 级):跳过执行 + 明确报错 + 任务存活 + 重放 {}', async () => {
  const executed = { n: 0 };
  const reg = new Registry();
  reg.register(searchTool(executed));
  const seen: SeenMessages = [];
  const r = await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: recordingChat([
      { calls: [{ name: 'web_search', args: '"just a string"' }], text: null },
      { text: 'recovered' },
    ], seen) as never,
  });
  assert.equal(r.reason, 'final', '非对象参数不杀任务');
  assert.equal(executed.n, 0, '非对象参数的调用不执行');
  const errResult = r.messages.filter((m) => m.role === 'tool');
  assert.match(String(errResult[0].content), /arguments must be valid JSON/i, '模型收到明确指引');
  const replayed = seen[1].filter((m) => m.role === 'assistant' && m.tool_calls)[0];
  assert.equal(replayed.tool_calls![0].function.arguments, '{}', '重放前已消毒');
});

test('取消(signal):下一轮边界停止,reason=interrupted,不抛异常逃逸', async () => {
  const executed = { n: 0 };
  const reg = new Registry();
  reg.register(searchTool(executed));
  const ac = new AbortController();
  const seen: SeenMessages = [];
  const slowChat = async (_p: unknown, _m: never[]) => {
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(); // 用户在模型响应期间取消
    const step = { calls: [{ name: 'web_search', args: '{"query":"x"}' }], text: null };
    const calls = step.calls.map((c, j) => ({ id: `c_${j}`, type: 'function' as const, function: { name: c.name, arguments: c.args } }));
    return { message: { role: 'assistant' as const, content: null, tool_calls: calls }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  };
  const r = await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'long task' }],
    ctx: { cwd: '.', home: '.' },
    signal: ac.signal,
    chatImpl: slowChat as never,
  });
  void seen;
  assert.equal(r.reason, 'interrupted', '取消后以 interrupted 收场而非异常');
  assert.ok(Array.isArray(r.messages), '消息数组完整(会话可导出/续跑)');
});

test('provider 400(chat 抛错):runLoop 以可捕获异常结束,不静默挂起', async () => {
  const reg = new Registry();
  reg.register(searchTool({ n: 0 }));
  const failingChat = async (): Promise<never> => {
    const err = new Error('HTTP 400: {"error":{"message":"Assistant tool call arguments must be valid JSON"}}') as Error & { status?: number };
    err.status = 400;
    throw err;
  };
  await assert.rejects(
    runLoop({
      provider: fakeProvider, registry: reg,
      messages: [{ role: 'user', content: 'go' }],
      ctx: { cwd: '.', home: '.' },
      chatImpl: failingChat as never,
    }),
    (err: unknown) => {
      assert.match(String((err as Error).message), /HTTP 400/);
      return true;
    },
    'provider 错误必须是可捕获的 rejection(调用方决定恢复动作),而不是挂起或吞掉',
  );
});
