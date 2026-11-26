import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, TRUNCATED_TAIL } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

/** What the loop does with finish_reason (2026-11-26).
 *
 *  'length' = the provider's output cap severed this reply. A final answer so
 *  cut used to be returned as if it were whole - the user read half a thought
 *  for the whole one. A tool call so cut used to be reported to the model as
 *  "unparseable arguments, repeat with complete JSON", which is exactly what it
 *  then did: the same oversized call, cut again.
 *
 *  The marker also has to TRAVEL as a text delta: every surface (web UI, TUI,
 *  one-shot task) renders the stream and never the returned text, so a tail
 *  appended to the return value alone was seen nowhere - the first version of
 *  this fix passed its unit tests and changed nothing on screen. */

interface Step { text?: string | null; calls?: Array<{ name: string; args: string }>; finishReason?: string }
interface Opts { onDelta?: (kind: string, chunk: string) => void }

/** A scripted model: one Step per call (the last one repeats). It streams its text like a real provider does. */
function scripted(steps: Step[]) {
  let i = 0;
  const impl = async (_p: unknown, _m: unknown, _t: unknown, opts?: Opts): Promise<object> => {
    const s = steps[Math.min(i, steps.length - 1)]!;
    i++;
    if (s.text) opts?.onDelta?.('text', s.text);
    const calls = s.calls?.map((c, j) => ({ id: 'c' + i + '_' + j, type: 'function' as const, function: { name: c.name, arguments: c.args } }));
    return {
      message: { role: 'assistant' as const, content: s.text ?? null, ...(calls ? { tool_calls: calls } : {}) },
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      ...(s.finishReason ? { finishReason: s.finishReason } : {}),
    };
  };
  return impl;
}

/** The scripted model plus every message array it was handed. */
function spied(steps: Step[]): { impl: unknown; seen: () => Array<{ role: string; content?: string | null }> } {
  const inner = scripted(steps);
  let seen: Array<{ role: string; content?: string | null }> = [];
  const impl = async (_p: unknown, m: Array<{ role: string; content?: string | null }>, t: unknown, o: unknown) => { seen = m; return inner(_p, m, t, o as Opts | undefined); };
  return { impl, seen: () => seen };
}

const echoTool: Tool = {
  name: 'echo', description: 'echo', readOnly: true,
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async execute(args) { return { output: String(args.text ?? '') }; },
};
const PROVIDER = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;
const run = async (impl: unknown, tool: Tool = echoTool) => {
  const deltas: Array<[string, string]> = [];
  const result = await runLoop({
    provider: PROVIDER,
    registry: new Registry().register(tool),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: impl as never,
    events: { onDelta: (k, c) => deltas.push([k, c]) },
  });
  return { result, streamed: deltas.filter(([k]) => k === 'text').map(([, c]) => c).join('') };
};

test('a final answer the output cap severed ends with the marker IN THE STREAM, and the return equals what was streamed', async () => {
  const { result, streamed } = await run(scripted([{ text: 'The plan is first to', finishReason: 'length' }]));
  assert.equal(result.reason, 'final', 'still a final answer');
  assert.equal(streamed, 'The plan is first to' + TRUNCATED_TAIL, 'a surface that renders only deltas shows it');
  assert.equal(result.text, streamed, 'and the returned text is exactly the stream');
  assert.match(TRUNCATED_TAIL, /continue/, 'the user is told what to do about it');
});

test('a complete final answer (finish_reason stop, or none) is streamed and returned untouched', async () => {
  for (const finishReason of ['stop', undefined]) {
    const { result, streamed } = await run(scripted([{ text: 'All done.', finishReason }]));
    assert.equal(streamed, 'All done.', `finish_reason ${finishReason}: no extra delta`);
    assert.equal(result.text, 'All done.', `finish_reason ${finishReason}: no marker`);
  }
});

test('other reasons (tool_calls, content_filter) add no marker', async () => {
  const { result, streamed } = await run(scripted([{ text: '(no content)', finishReason: 'content_filter' }]));
  assert.equal(result.text, '(no content)');
  assert.equal(streamed, '(no content)');
});

test('without an onDelta consumer the marker still rides in the returned text', async () => {
  const r = await runLoop({
    provider: PROVIDER,
    registry: new Registry().register(echoTool),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: scripted([{ text: 'cut', finishReason: 'length' }]) as never,
  });
  assert.equal(r.text, 'cut' + TRUNCATED_TAIL);
});

test('a tool call the cap severed: the model is told about the LIMIT, not just the broken JSON', async () => {
  const s = spied([
    { calls: [{ name: 'echo', args: '{"text":"aaaa' }], finishReason: 'length' },
    { text: 'split into three smaller calls' },
  ]);
  const { result } = await run(s.impl, { ...echoTool, async execute() { throw new Error('must not run'); } });
  assert.equal(result.text, 'split into three smaller calls');
  const toolMsg = s.seen().find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content!, /cut off by the model's output length limit/);
  assert.match(toolMsg.content!, /much smaller payload/);
});

test('broken JSON with no cap involved keeps the plain message (nothing is blamed on a limit that was not hit)', async () => {
  const s = spied([
    { calls: [{ name: 'echo', args: '{"text":"a"' }] },
    { text: 'ok' },
  ]);
  await run(s.impl);
  const toolMsg = s.seen().find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content!, /^unparseable tool arguments for echo/);
  assert.doesNotMatch(toolMsg.content!, /output length limit/);
});
