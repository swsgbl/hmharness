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

/** `readOnly` mirrors the real read tools (read_file / list_dir); without it
 *  the tool is treated as state-changing. */
function countingTool(name: string, opts: { readOnly?: boolean } = {}): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    name, description: 'test tool',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    ...(opts.readOnly ? { readOnly: true } : {}),
    async execute() { calls++; return { output: 'RESULT for q=abc: the answer is 42' }; },
  };
  return { tool, calls: () => calls };
}

const fakeProvider = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;
type Result = { messages: Array<{ role: string; content?: string | null }> };
const reminders = (r: Result) => r.messages.filter((m) => m.role === 'tool' && String(m.content).includes('already ran')).length;
const call = (name: string, args = '{"q":"abc"}') => ({ name, args });

test('repeat-call dedup: identical readOnly tool calls get the cached result, tool executes once', async () => {
  const { tool, calls } = countingTool('search', { readOnly: true });
  const reg = new Registry();
  reg.register(tool);
  const chat = scriptedChat([
    { calls: [call('search')], text: null },
    { calls: [call('search')], text: null },
    { calls: [call('search')], text: null },
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
  assert.equal(reminders(r), 2, 'two cache reminders in the transcript');
});

test('different args bypass dedup (the tool executes each time)', async () => {
  const { tool, calls } = countingTool('search', { readOnly: true });
  const reg = new Registry();
  reg.register(tool);
  const chat = scriptedChat([
    { calls: [call('search')], text: null },
    { calls: [call('search', '{"q":"xyz"}')], text: null },
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

// ---- 2026-11-25 stale-cache regression ---------------------------------------
// The dedup ring (2026-10-07) cached EVERY successful call for 20 turns, and no
// write/edit/command invalidated it. In the session history it was audited on,
// 147 of 151 cache hits came AFTER a state-changing call had run: stale command
// output, stale file reads, edit_file calls that silently never executed, and
// build results served after source changes. An agent's core loop is
// edit -> re-run the same command -> read the fresh result; the ring turned it
// into a stale-feedback loop.

test('a tool without readOnly is never served from the cache: identical calls always execute (commands, builds, tests, edits)', async () => {
  const { tool, calls } = countingTool('run_tests');
  const reg = new Registry();
  reg.register(tool);
  const chat = scriptedChat([
    { calls: [call('run_tests')], text: null },
    { calls: [call('run_tests')], text: null },
    { calls: [call('run_tests')], text: null },
    { text: 'done' },
  ]);
  const r = await runLoop({
    provider: fakeProvider,
    registry: reg,
    messages: [{ role: 'user', content: 'fix the bug' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: chat as never,
  });
  assert.equal(calls(), 3, 'every identical call executed for real');
  assert.equal(reminders(r), 0, 'no cache reminder for a state-changing tool');
});

/** A read tool over a mutable "file" plus a tool that edits it. */
function filePair() {
  let content = 'BEFORE';
  let reads = 0;
  const read: Tool = {
    name: 'read_file', description: 'read', readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute() { reads++; return { output: content }; },
  };
  const edit: Tool = {
    name: 'edit_file', description: 'edit',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() { content = 'AFTER'; return { output: 'edited' }; },
  };
  const outputs = (r: Result) => r.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  return { read, edit, reads: () => reads, outputs };
}

test('a readOnly call is re-executed once a state-changing call has run (read after edit returns the NEW content)', async () => {
  const { read, edit, reads, outputs } = filePair();
  const reg = new Registry().register(read).register(edit);
  const chat = scriptedChat([
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { calls: [{ name: 'edit_file', args: '{}' }], text: null },
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { text: 'done' },
  ]);
  const r = await runLoop({ provider: fakeProvider, registry: reg, messages: [{ role: 'user', content: 'go' }], ctx: { cwd: '.', home: '.' }, chatImpl: chat as never });
  assert.equal(reads(), 2, 'the second read really ran');
  assert.deepEqual(outputs(r), ['BEFORE', 'edited', 'AFTER'], 'the re-read reflects the edit, not the cached pre-edit head');
});

test('a readOnly call is still deduped when nothing has changed in between', async () => {
  const { read, reads, outputs } = filePair();
  const reg = new Registry().register(read);
  const chat = scriptedChat([
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { text: 'done' },
  ]);
  const r = await runLoop({ provider: fakeProvider, registry: reg, messages: [{ role: 'user', content: 'go' }], ctx: { cwd: '.', home: '.' }, chatImpl: chat as never });
  assert.equal(reads(), 1, 'a pure repeat with no state change is still deduped');
  assert.match(outputs(r)[1], /already ran/);
});

test('a readOnly call batched together with a state-changing call is not served from the cache', async () => {
  const { read, edit, reads, outputs } = filePair();
  const reg = new Registry().register(read).register(edit);
  const chat = scriptedChat([
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { calls: [{ name: 'edit_file', args: '{}' }, { name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { text: 'done' },
  ]);
  const r = await runLoop({ provider: fakeProvider, registry: reg, messages: [{ role: 'user', content: 'go' }], ctx: { cwd: '.', home: '.' }, chatImpl: chat as never });
  assert.equal(reads(), 2, 'the read in the mutating batch ran for real');
});

test('a runtime injection invalidates cached reads (the user may have changed something out of band)', async () => {
  const { read, reads } = filePair();
  const reg = new Registry().register(read);
  // the injection joins the transcript right after the first tool batch, so the
  // model's very next step is the re-read
  const chat = scriptedChat([
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }], text: null },
    { text: 'done' },
  ]);
  const queue = ['[inject] I edited the file myself - read it again'];
  await runLoop({
    provider: fakeProvider, registry: reg,
    messages: [{ role: 'user', content: 'go' }], ctx: { cwd: '.', home: '.' }, chatImpl: chat as never,
    injectQueue: () => (queue.length ? queue.shift()! : null),
  });
  assert.equal(reads(), 2, 'the re-read after the user message ran for real');
});
