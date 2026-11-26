/**
 * A conversation must remember its own turns (2026-11-26).
 *
 * The user saw it in the TUI: the second request in a session re-investigated
 * everything the first one had just established - "同一个会话当中发一次指令又
 * 独立了记忆". The cause was not compaction. `runAgentTask` returned the
 * messages it was HANDED (system prompt + history + the new user line) instead
 * of the conversation the loop had just had, so every surface that extends its
 * history from the return value (TUI, REPL, ACP hosts) carried the user's lines
 * forward and nothing of the assistant's; the browser sidebar, which passes only
 * a session id, had no earlier turns at all. The loop itself never put the final
 * answer into the working transcript either.
 *
 * Each test talks to a scripted model that records every request it receives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

interface Scripted { url: string; seen: Array<{ messages: ChatMessage[]; tools: number }>; close(): Promise<void> }

/** A model that follows one rule and records every request: with tools on
 *  offer it calls `echo` once per user turn, then answers "DONE turn N"; any
 *  request without tools (a side call) gets a plain "ok". */
async function scriptedModel(): Promise<Scripted> {
  const seen: Scripted['seen'] = [];
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
    const tools = parsed.tools ?? [];
    seen.push({ messages, tools: tools.length });
    const turn = messages.filter((m) => m.role === 'user').length;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const answered = messages.slice(lastUser + 1).some((m) => m.role === 'tool');
    const toolCall = tools.length > 0 && !answered
      ? [{ id: 'call_' + seen.length, type: 'function' as const, function: { name: 'echo', arguments: JSON.stringify({ text: 'ping' + turn }) } }]
      : undefined;
    const text = toolCall ? '' : (tools.length > 0 ? `DONE turn ${turn}: the echo said pong:ping${turn}` : 'ok');
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
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text || null, ...(toolCall ? { tool_calls: toolCall } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }] }));
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

const text = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : '');
const cfgFor = (baseUrl: string): ProviderConfig => ({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 20_000 });
const reg = (): Registry => { const r = new Registry(); for (const t of baseTools) r.register(t); r.register(echo); return r; };

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-conv-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(home); } finally {
    if (prev === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

/** The main-loop request for a given user turn (the one that offered tools). */
const requestForTurn = (model: Scripted, userText: string): ChatMessage[] => {
  const hit = model.seen.find((s) => s.tools > 0 && s.messages.some((m) => m.role === 'user' && text(m) === userText));
  assert.ok(hit, `the model was asked about "${userText}"`);
  return hit.messages;
};

test('runAgentTask returns the conversation it just had: every assistant step, every tool result, the final answer', async () => {
  await withTempHome(async () => {
    const model = await scriptedModel();
    try {
      const r1 = await runAgentTask({ task: 'first', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      const conv = r1.messages;
      assert.ok(conv.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function.name === 'echo')), 'the step that called the tool');
      assert.ok(conv.some((m) => m.role === 'tool' && text(m).includes('pong:ping1')), 'the result the tool returned');
      assert.ok(conv.some((m) => m.role === 'assistant' && text(m).includes('DONE turn 1')), 'and the final answer - the part a follow-up needs most');
      assert.equal(text(conv[conv.length - 1]), 'DONE turn 1: the echo said pong:ping1', 'the conversation ends with the answer');
    } finally { await model.close(); }
  });
});

test('a follow-up that extends the conversation the TUI / REPL / ACP way is shown everything the first turn did', async () => {
  await withTempHome(async () => {
    const model = await scriptedModel();
    try {
      const r1 = await runAgentTask({ task: 'first', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      const history = extendConversation([], 'first', r1);
      await runAgentTask({ task: 'second', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {}, resumeMessages: history, sessionId: r1.sessionId });
      const req = requestForTurn(model, 'second');
      const from = req.findIndex((m) => m.role === 'user' && text(m) === 'first');
      assert.ok(from >= 0, 'the first request is still there');
      const carried = req.slice(from);
      assert.deepEqual(carried.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user'], 'first request, the tool call, its result, the answer, then the follow-up');
      assert.ok(text(carried[3]).includes('DONE turn 1'), 'the first answer is in what the model sees for the follow-up');
      assert.equal(text(carried[4]), 'second');
    } finally { await model.close(); }
  });
});

test('continuing a session by its id alone (the browser sidebar way) also brings the earlier turns', async () => {
  await withTempHome(async () => {
    const model = await scriptedModel();
    try {
      const r1 = await runAgentTask({ task: 'first', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      await runAgentTask({ task: 'second', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {}, sessionId: r1.sessionId });
      const req = requestForTurn(model, 'second');
      assert.ok(req.some((m) => m.role === 'assistant' && text(m).includes('DONE turn 1')), 'the first answer travels with the session');
      assert.ok(req.some((m) => m.role === 'tool' && text(m).includes('pong:ping1')), 'and so does the tool result');
      assert.ok(req.some((m) => m.role === 'user' && text(m) === 'first'), 'and the first request');
    } finally { await model.close(); }
  });
});

test('an explicit empty history still means a fresh conversation (the web "new task" case)', async () => {
  await withTempHome(async () => {
    const model = await scriptedModel();
    try {
      const r1 = await runAgentTask({ task: 'first', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      await runAgentTask({ task: 'second', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {}, resumeMessages: [], sessionId: r1.sessionId });
      const req = requestForTurn(model, 'second');
      assert.ok(!req.some((m) => m.role === 'user' && text(m) === 'first'), 'nothing of the first turn');
      assert.deepEqual(req.map((m) => m.role), ['system', 'user']);
    } finally { await model.close(); }
  });
});
