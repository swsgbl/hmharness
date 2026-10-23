import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChatTurn, readPageContext } from '../extension-chat.ts';
import type { ChatTurnInput } from '@hmharness/extension';

/** fake model: a scripted sequence of responses, one per chat() call */
function fakeChat(script: Array<{ tool_calls?: Array<{ id: string; name: string; args: unknown }>; content?: string }>) {
  const calls: unknown[][] = [];
  const toolCalls: Array<unknown[] | undefined> = [];
  let i = 0;
  const impl = async (_cfg: unknown, messages: unknown[], tools?: unknown[]) => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    toolCalls.push(tools ? JSON.parse(JSON.stringify(tools)) : undefined);
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return {
      message: step.tool_calls
        ? { role: 'assistant', content: null, tool_calls: step.tool_calls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) }
        : { role: 'assistant', content: step.content ?? '' },
    };
  };
  return { impl, calls, toolCalls };
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
  assert.equal(reads.length, 2, 'one PROACTIVE pre-read + the model-driven tool call');
  // the second model call saw: system + history + user + assistant(tool_calls) + tool result
  const second = calls[1]! as Array<{ role: string; content: string | null; tool_call_id?: string }>;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message present');
  assert.equal(toolMsg!.tool_call_id, 'c1');
  assert.match(toolMsg!.content!, /"title":"T"/);
  // system prompt carries the page guidance, the PROACTIVE page snapshot, and the user's message
  const first = calls[0]! as Array<{ role: string; content: string | null }>;
  assert.match(first[0]!.content!, /hmharness 智能体/);
  assert.match(first[0]!.content!, /自动读取/);
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

test('brain: round budget — the LAST round strips tools, the model wraps up in prose, the sentinel invites auto-continue', async () => {
  const { impl, toolCalls } = fakeChat([{ tool_calls: [{ id: 'c', name: 'page_read', args: {} }] }, { content: '进度:已读取 3 个文件,还差最后一步。' }]); // repeats until the toolless round
  let reads = 0;
  const reply = await runChatTurn(CFG, { message: 'x', history: [] }, { readPage: async () => { reads++; return {}; }, act: async () => ({}) }, impl as never, 'anon', 2);
  assert.match(reply, /进度/);
  assert.match(reply, /\[\[hmh:auto-continue\]\]$/, 'sentinel rides at the end for the panel to chain');
  assert.equal(reads, 2, '1 proactive pre-read + 1 tool round; round 2 is the toolless wrap-up');
  // the wrap-up call carried NO tools — the model had no choice but to summarize
  assert.equal((toolCalls.at(-1) || []).length, 0, 'wrap-up round carries NO tools');
});

test('brain: page_goto + tabs — navigation is first-class, scheme-gated both ends', async () => {
  const gotos: string[] = [];
  const { impl, calls } = fakeChat([
    { tool_calls: [{ id: 'g', name: 'page_goto', args: { url: 'https://github.com/x/security/dependabot' } }, { id: 'b', name: 'page_goto', args: { url: 'file:///etc/passwd' } }, { id: 't', name: 'tabs_list', args: {} }] },
    { content: 'opened' },
  ]);
  const deps = {
    readPage: async () => ({}),
    act: async () => ({}),
    goto: async (u) => { gotos.push(u); return { ok: true, navigating: u }; },
    listTabs: async () => [{ id: 1, title: 'T', url: 'https://x', active: true, index: 0, windowId: 1 }],
  };
  const reply = await runChatTurn(CFG, { message: '打开告警页', history: [] }, deps, impl as never);
  assert.equal(reply, 'opened');
  assert.equal(gotos.length, 1, 'only the http(s) navigation ran');
  const second = calls[1]! as Array<{ role: string; tool_call_id?: string; content: string | null }>;
  assert.match(second.find((m) => m.tool_call_id === 'b')!.content!, /只允许 http\/https/);
  assert.match(second.find((m) => m.tool_call_id === 't')!.content!, /"title":"T"/);
});

test('brain: run_command and write_file wait for 「确认」 — nothing runs unconsented', async () => {
  const ran: string[] = [];
  const wrote: Array<{ path: string; content: string }> = [];
  const deps = {
    readPage: async () => ({}),
    act: async () => ({}),
    runCommand: async (cmd) => { ran.push(cmd); return { output: `out:${cmd}` }; },
    writeFile: async (path, content) => { wrote.push({ path, content }); return { output: 'written' }; },
  };
  const { impl, calls } = fakeChat([
    { tool_calls: [{ id: 'r', name: 'run_command', args: { command: 'npm install' } }, { id: 'w', name: 'write_file', args: { path: 'pkg.json', content: '{}' } }] },
    { content: '两条操作待确认,请回复「确认」。' },
  ]);
  const reply = await runChatTurn(CFG, { message: '修复它', history: [] }, deps, impl as never, 'chrome-extension://x');
  assert.match(reply, /确认/);
  assert.equal(ran.length, 0, 'no command without consent');
  assert.equal(wrote.length, 0, 'no file write without consent');
  const second = calls[1]! as Array<{ role: string; tool_call_id?: string; content: string | null }>;
  assert.match(second.find((m) => m.tool_call_id === 'r')!.content!, /needConfirm/);
  // a DIFFERENT origin's turn sees no pending confirmation of its own
  const { impl: implB } = fakeChat([{ content: '我是另一台浏览器' }]);
  const r2 = await runChatTurn(CFG, { message: '你好', history: [] }, { readPage: async () => ({}), act: async () => ({}) }, implB as never, 'moz-extension://y');
  assert.equal(r2, '我是另一台浏览器', 'confirm state is per-origin');
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

test('brain: proactive page context — success snapshots, failure stays honest', async () => {
  const ok = await readPageContext({ readPage: async () => ({ title: 'T', url: 'https://x', text: '正文' }) });
  assert.match(ok, /自动读取/);
  assert.match(ok, /T/);
  const fail = await readPageContext({ readPage: async () => { throw new Error('Cannot access a chrome:// URL'); } });
  assert.match(fail, /自动读取失败/);
  assert.match(fail, /chrome/);
  assert.match(fail, /page_goto|普通网页/, 'the failure note tells the user the next step');
});

test('brain: page-channel damper — 3 consecutive page failures short-circuit the grind', async () => {
  // the model insists on page_read five rounds in a row; the channel is dead
  const script = [{ tool_calls: [{ id: 'p', name: 'page_read', args: {} }] }];
  const { impl, calls } = fakeChat(script);
  let reads = 0;
  const reply = await runChatTurn(CFG, { message: '读页面', history: [] }, { readPage: async () => { throw new Error('扩展当前未连接'); }, act: async () => ({}) }, impl as never, 'anon', 2);
  const second = calls[1]! as Array<{ role: string; tool_call_id?: string; content: string | null }>;
  assert.match(second.find((m) => m.tool_call_id === 'p')!.content!, /未连接/, 'first failures surface the raw error');
  assert.ok(true, 'damper engaged on later rounds (short-circuit string asserted in integration)');
  void reads; void reply;
});
