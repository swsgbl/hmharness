/**
 * Weak-model guards in the loop (2026-11-26).
 *
 * The loop ends the moment the model replies without a tool call. With a local
 * 9B model, two replies that are not answers ended runs that way: a bare
 * announcement ("我来重命名…", no tool called) and an empty reply after the
 * work was done. Each gets a bounded correction; everything that is a real
 * answer - a plan-mode plan, a question back, a refusal, a normal sentence -
 * must end the loop exactly as before.
 *
 * The loop is imported as a namespace on purpose: run against a loop without
 * the guards, these tests fail on what the loop DID, not on a missing export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../loop.ts';
import type { LoopEvents } from '../loop.ts';
import type { DeltaKind } from '../provider.ts';
import type { ChatMessage, ProviderConfig, Tool } from '../types.ts';

type Reply = { message: { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }; finishReason?: 'stop' | 'length'; usage: { prompt_tokens: number; completion_tokens: number } };
const provider: ProviderConfig = { baseUrl: 'x', apiKey: 'k', model: 'm' };
const noop: Tool = {
  name: 'noop', description: 'noop', readOnly: true,
  parameters: { type: 'object', properties: {} },
  async execute() { return { output: 'ok' }; },
};
const registry = () => {
  const r = new Map<string, Tool>([['noop', noop]]);
  return { toOpenAITools: () => [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }], get: (n: string) => r.get(n) } as never;
};
const say = (content: string | null, finish?: 'length'): Reply =>
  ({ message: { role: 'assistant', content }, ...(finish ? { finishReason: finish } : {}), usage: { prompt_tokens: 1, completion_tokens: 1 } });
const call = (id: string): Reply =>
  ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'noop', arguments: '{}' } }] }, usage: { prompt_tokens: 1, completion_tokens: 1 } });
// the notes are addressed by their tag, so the wording can be tuned without breaking these
const NOTE = { intent: '[intent only]', empty: '[empty reply]', none: '[No answer:' };
const TRUNCATED_TAIL = '\n\n[Reply truncated: the model hit its output length limit. Send "continue" to have it pick up where it stopped.]';

/** A loop whose model answers from a script, one reply per call; records every
 *  request it saw and everything that was streamed. */
async function run(script: Reply[], messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'rename it' }], extra: { injectQueue?: () => string | null; signal?: AbortSignal } = {}) {
  const seen: ChatMessage[][] = [];
  const deltas: Array<[DeltaKind, string]> = [];
  const finals: string[] = [];
  const events: LoopEvents = { onDelta: (k, c) => { deltas.push([k, c]); }, onFinal: (t) => { finals.push(t); } };
  let n = 0;
  const result = await kernel.runLoop({
    provider, registry: registry(), messages, ctx: { cwd: '.', home: '.' }, events,
    chatImpl: (async (_cfg: unknown, msgs: ChatMessage[]) => {
      seen.push(msgs.map((m) => ({ ...m })));
      return script[n++] ?? say('the script ran out');
    }) as never,
    ...(extra.injectQueue ? { injectQueue: extra.injectQueue } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return { result, seen, deltas, finals, calls: n };
}
const withTag = (msgs: ChatMessage[], tag: string): ChatMessage | undefined => msgs.find((m) => m.role === 'system' && String(m.content ?? '').startsWith(tag));
const PLAN: ChatMessage = { role: 'system', content: '[plan mode] Before ANY tool use, present a concrete plan (2-5 numbered steps). Then STOP and wait for the user to confirm before executing.' };

test('isIntentOnly: the sentence a weak model stopped on, and nothing that carries content', () => {
  const guard = (kernel as Record<string, unknown>).isIntentOnly;
  assert.equal(typeof guard, 'function', 'the loop has an intent-only detector');
  const isIntentOnly = guard as (text: string) => boolean;
  assert.equal(isIntentOnly('我来重命名 `parseConfig` 函数并更新所有引用处。'), true);
  assert.equal(isIntentOnly("I'll rename the function and update every reference."), true);
  assert.equal(isIntentOnly('好的，我现在开始修改。'), true);
  assert.equal(isIntentOnly('Let me check the file first.'), true);
  // content: a second line, a colon, a question, a code block
  assert.equal(isIntentOnly('我来重命名。\n第一步：打开文件。'), false);
  assert.equal(isIntentOnly('我来解释：parseConfig 在 src/config.js。'), false);
  assert.equal(isIntentOnly('需要我现在执行吗？'), false);
  assert.equal(isIntentOnly('我来改：\n```\nexport function readConfigStrict() {}\n```'), false);
  // a refusal is an answer
  assert.equal(isIntentOnly('I will not modify files without approval.'), false);
  assert.equal(isIntentOnly('我不能修改这个文件。'), false);
  // a real answer that merely mentions intent further on, or is too long
  assert.equal(isIntentOnly('parseConfig 在 src/config.js，它把 INI 文本解析成对象。'), false);
  assert.equal(isIntentOnly('这个函数是让模型解析配置用的，我来写个例子说明它的行为，以及它在不同输入下的输出和异常处理方式，内容比较长所以分几段讲。'), false);
  assert.equal(isIntentOnly('我来' + 'x'.repeat(120)), false);
});

test('"announce and stop": the model is told once to act, and the run ends with its real answer', async () => {
  const { result, seen, calls, finals } = await run([say('我来重命名 `parseConfig` 函数并更新所有引用处。'), call('c1'), say('已改名 8 处。')]);
  assert.equal(calls, 3, 'announce, act, answer');
  assert.equal(result.text, '已改名 8 处。');
  assert.equal(result.toolUses, 1);
  assert.deepEqual(finals, ['已改名 8 处。'], 'onFinal fired once, with the real answer');
  // the second request carries the announcement and, right after it, the note
  const second = seen[1]!;
  assert.equal(second.at(-2)?.role, 'assistant');
  assert.equal(second.at(-2)?.content, '我来重命名 `parseConfig` 函数并更新所有引用处。');
  assert.ok(withTag(second, NOTE.intent), 'the note reached the model');
  assert.equal(second.at(-1), withTag(second, NOTE.intent));
  // and the third request ends with the tool result
  assert.equal(seen[2]!.at(-1)?.role, 'tool');
  // the note steers this run only: the thread a follow-up continues from keeps
  // the announcement and the answer, not the note
  assert.deepEqual(result.messages.map((m) => m.role), ['system', 'user', 'assistant', 'assistant', 'tool', 'assistant']);
});

test('"announce and stop": plan mode is exempt - the announcement is the answer the directive asked for', async () => {
  const { result, calls, seen } = await run([say('我来重命名 `parseConfig` 函数并更新所有引用处。')], [PLAN, { role: 'user', content: 'rename it' }]);
  assert.equal(calls, 1, 'no correction in plan mode');
  assert.ok(!withTag(seen[0]!, NOTE.intent) && seen.length === 1);
  assert.equal(result.text, '我来重命名 `parseConfig` 函数并更新所有引用处。');
});

test('"announce and stop": a question, a refusal, content, or a tool that already ran end the run untouched', async () => {
  const cases: Array<[string, Reply[]]> = [
    ['a question back', [say('需要我现在执行吗？')]],
    // refusals that OPEN with the intent marker and are exempt only by the negation
    ['a refusal (en)', [say('I will not modify files without approval.')]],
    ['a refusal (zh)', [say('好的，我不会修改这个文件。')]],
    ['content with a colon', [say('我来解释：parseConfig 在 src/config.js。')]],
    ['an announcement after a tool ran', [call('c1'), say('我现在开始修改。')]],
  ];
  for (const [label, script] of cases) {
    const { result, seen, calls } = await run(script);
    assert.equal(calls, script.length, label + ': no extra model call');
    assert.ok(!seen.some((msgs) => withTag(msgs, NOTE.intent)), label + ': no note was sent');
    assert.equal(result.reason, 'final', label);
  }
});

test('"announce and stop": one correction per run - a model that only announces again is taken at its word', async () => {
  const { result, calls, seen } = await run([say('我来重命名。'), say('我马上修改。')]);
  assert.equal(calls, 2);
  assert.equal(result.text, '我马上修改。');
  assert.ok(withTag(seen[1]!, NOTE.intent), 'the one correction was sent with the second request');
});

test('the empty reply: the model is asked again, the empty step leaves the transcript, the answer is what it says next', async () => {
  const { result, seen, calls, finals } = await run([call('c1'), say(''), say('已改名 8 处。')]);
  assert.equal(calls, 3);
  assert.equal(result.text, '已改名 8 处。');
  assert.equal(result.toolUses, 1);
  // the request AFTER the empty reply ends with the re-ask note, and carries no content-less assistant message
  const retry = seen[2]!;
  assert.equal(retry.at(-1), withTag(retry, NOTE.empty), 'the re-ask note is the last thing before the second try');
  assert.ok(!retry.some((m) => m.role === 'assistant' && !(m.tool_calls ?? []).length), 'no content-less assistant message went back to the provider');
  assert.deepEqual(finals, ['已改名 8 处。'], 'onFinal fired exactly once, with the real answer');
});

test('the empty reply: null and whitespace count as empty; at most two re-asks, then the user is told', async () => {
  for (const blank of [null, '   ']) {
    const { result, calls, deltas, finals } = await run([say(blank), say(blank), say(blank)]);
    assert.equal(calls, 3, 'two re-asks');
    assert.ok(result.text.startsWith(NOTE.none), 'the run ends with a visible note, not with nothing');
    assert.ok(deltas.some(([kind, chunk]) => kind === 'text' && chunk.startsWith(NOTE.none)), 'the note was streamed - surfaces render the stream');
    assert.deepEqual(finals, [result.text]);
  }
});

test('the empty reply: an answer on the second try ends the run with it', async () => {
  const { result, calls } = await run([say(''), say('做完了。')]);
  assert.equal(calls, 2);
  assert.equal(result.text, '做完了。');
  assert.ok(!result.messages.some((m) => withTag([m], NOTE.empty)), 'the note is not part of the returned conversation');
});

test('the empty reply: a reply the output cap severed keeps the truncation tail and is not re-asked', async () => {
  const { result, calls, deltas } = await run([say('', 'length')]);
  assert.equal(calls, 1, 'not re-asked');
  assert.equal(result.text, TRUNCATED_TAIL);
  assert.ok(deltas.some(([, chunk]) => chunk === TRUNCATED_TAIL));
});

test('the empty reply: a message queued while the model was replying still wins over the re-ask', async () => {
  let queued: string | null = 'and also rename loadConfigFile';
  const { result, calls, seen } = await run([say(''), say('两处都改好了。')], undefined, { injectQueue: () => { const q = queued; queued = null; return q; } });
  assert.equal(calls, 2);
  assert.equal(result.text, '两处都改好了。');
  assert.ok(!seen.some((msgs) => withTag(msgs, NOTE.empty)), 'no re-ask note: the user message went in instead');
  assert.equal(seen[1]!.at(-1)?.content, 'and also rename loadConfigFile');
});
