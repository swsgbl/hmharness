/**
 * The weak-model guards through the whole runner (2026-11-26).
 *
 * The kernel tests pin the loop's decisions. These run the same two replies
 * through `runAgentTask` with a scripted model, so the extra model turns are
 * seen by every layer the runner wires around the loop - session log, rollout,
 * cognitive recorder - and the thread a follow-up continues from is checked too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentTask, extendConversation } from '../runner.ts';
import { baseTools } from '../tools.ts';
import { Registry, defaultConfig, type ChatMessage, type Tool, type ProviderConfig } from '@hmharness/kernel';

const echo: Tool = {
  name: 'echo', description: 'echo the text back', readOnly: true,
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) { return { output: 'pong:' + String(args.text ?? '') }; },
};

type Step = { text: string | null } | { call: string; args: Record<string, unknown> };
interface Scripted { url: string; seen: ChatMessage[][]; close(): Promise<void> }

/** A model that follows a script for main-loop requests (tools on offer), one
 *  step per request, and records every request it receives. Requests without
 *  tools (side calls) always get a plain "ok". */
async function scriptedModel(steps: Step[]): Promise<Scripted> {
  const seen: ChatMessage[][] = [];
  const queue = [...steps];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const part of req) body += part;
    if (!(req.url || '').includes('/chat/completions')) {
      if ((req.url || '').includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'm' }] })); }
      else { res.writeHead(404); res.end('{}'); }
      return;
    }
    const parsed = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[]; stream?: boolean };
    const messages = parsed.messages ?? [];
    if (!(parsed.tools ?? []).length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
      return;
    }
    seen.push(messages);
    const step = queue.shift() ?? { text: null };
    const toolCall = 'call' in step ? [{ id: 'call_' + seen.length, type: 'function' as const, function: { name: step.call, arguments: JSON.stringify(step.args ?? {}) } }] : undefined;
    const text = toolCall ? null : (step as { text: string | null }).text;
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
      if (toolCall) res.write(chunk({ tool_calls: toolCall.map((c) => ({ index: 0, ...c })) }));
      if (text) res.write(chunk({ content: text }));
      res.write(chunk({}, toolCall ? 'tool_calls' : 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...(toolCall ? { tool_calls: toolCall } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }] }));
    }
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const cfgFor = (baseUrl: string): ProviderConfig => ({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 20_000 });
const reg = (): Registry => { const r = new Registry(); for (const t of baseTools) r.register(t); r.register(echo); return r; };

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-weak-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(home); } finally {
    if (prev === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The session log of a run, as records. */
async function sessionRecords(home: string): Promise<Array<Record<string, unknown>>> {
  const walk = async (d: string, out: string[] = []): Promise<string[]> => {
    for (const f of await readdir(d)) { const p = join(d, f); if ((await stat(p)).isDirectory()) await walk(p, out); else if (p.endsWith('.jsonl')) out.push(p); }
    return out;
  };
  const files = await walk(join(home, 'sessions'));
  assert.equal(files.length, 1, 'one session log');
  return (await readFile(files[0]!, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const content = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : '');
const lastNote = (msgs: ChatMessage[]): string => { const last = msgs.at(-1)!; assert.equal(last.role, 'system', 'the last message is a control note'); return content(last); };

test('runner: "announce and stop" is corrected - the task runs, the log and the thread keep what really happened', async () => {
  await withTempHome(async (home) => {
    const model = await scriptedModel([
      { text: '我来把这句话原样发送并更新所有引用处。' },
      { call: 'echo', args: { text: 'ping' } },
      { text: '已发送，回显是 pong:ping。' },
    ]);
    try {
      const r = await runAgentTask({ task: 'send ping', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      assert.equal(r.text, '已发送，回显是 pong:ping。');
      assert.equal(r.toolUses, 1);
      assert.equal(model.seen.length, 3, 'announce, act, answer');
      assert.ok(lastNote(model.seen[1]!).startsWith('[intent only]'), 'the correction reached the model');
      // the session log: the announcement, the call, the result, the answer (every
      // model message is logged, the final one too), and one final record
      const recs = await sessionRecords(home);
      assert.deepEqual(recs.map((x) => x.t), ['session/start', 'user', 'assistant', 'assistant', 'tool', 'assistant', 'final']);
      assert.equal(recs[2]?.text, '我来把这句话原样发送并更新所有引用处。', 'the announcement is on record - it is what the model said');
      assert.equal(recs.at(-1)?.text, '已发送，回显是 pong:ping。');
      // the thread a follow-up continues from: the announcement stays (it is what the model said), the note does not
      const thread = extendConversation([], 'send ping', r);
      assert.deepEqual(thread.map((m) => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
      assert.equal(content(thread[1]!), '我来把这句话原样发送并更新所有引用处。');
      assert.ok(!thread.some((m) => content(m).startsWith('[intent only]')));
    } finally { await model.close(); }
  });
});

test('runner: the empty reply is re-asked - the user gets the answer, the log has one final record', async () => {
  await withTempHome(async (home) => {
    const model = await scriptedModel([
      { call: 'echo', args: { text: 'ping' } },
      { text: '' },
      { text: '做完了，回显是 pong:ping。' },
    ]);
    try {
      const r = await runAgentTask({ task: 'send ping', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      assert.equal(r.text, '做完了，回显是 pong:ping。');
      assert.equal(r.toolUses, 1);
      assert.equal(model.seen.length, 3);
      assert.ok(lastNote(model.seen[2]!).startsWith('[empty reply]'), 'the re-ask reached the model');
      assert.ok(!model.seen[2]!.some((m) => m.role === 'assistant' && !(m.tool_calls ?? []).length && !content(m).trim()), 'the empty step did not go back');
      const recs = await sessionRecords(home);
      assert.equal(recs.filter((x) => x.t === 'final').length, 1, 'exactly one final record');
      assert.equal(recs.at(-1)?.text, '做完了，回显是 pong:ping。');
      // and the empty reply from the log is not replayed into the next turn
      const thread = extendConversation([], 'send ping', r);
      assert.deepEqual(thread.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    } finally { await model.close(); }
  });
});
