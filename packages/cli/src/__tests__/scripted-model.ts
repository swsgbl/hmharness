/**
 * A scripted OpenAI-compatible model for tests that start the REAL entry points
 * (REPL, TUI) in a child process. It follows one rule and records every request
 * it receives, so a test can read what the model was actually shown.
 *
 * Rule: with tools on offer, call `list_dir` once per user turn, then answer
 * "DONE turn N". A request without tools (a side call) gets a plain "ok".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChatMessage } from '@hmharness/kernel';

export interface Seen { messages: ChatMessage[]; tools: number }
export interface Scripted { url: string; seen: Seen[]; close(): Promise<void> }

/** `sideCall`: answers a request that offers no tools (a summariser, the
 *  evolution module's proposal call…) from its messages; `undefined` -> "ok". */
export async function scriptedModel(dirToList: string, sideCall?: (messages: ChatMessage[]) => string | undefined): Promise<Scripted> {
  const seen: Seen[] = [];
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
      ? [{ id: 'call_' + seen.length, type: 'function' as const, function: { name: 'list_dir', arguments: JSON.stringify({ path: dirToList }) } }]
      : undefined;
    const text = toolCall ? '' : (tools.length > 0 ? `DONE turn ${turn}` : (sideCall?.(messages) ?? 'ok'));
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

export const text = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : '');

/** The main-loop requests (tools on offer) made for one user turn, in order. */
export const requestsFor = (model: Scripted, userText: string): Seen[] =>
  model.seen.filter((s) => s.tools > 0 && s.messages.some((m) => m.role === 'user' && text(m) === userText));

/** These tests start the REAL entry points from source - tsx compiles the whole
 *  CLI on the way up, with no cache on a fresh runner - and check WHAT happens,
 *  never how fast. A 30 s wait was not enough on a loaded CI runner: on
 *  2026-11-26 the wait for the second line of the REPL timed out inside the
 *  publish run's own test gate, and the release was refused over it. */
export const PATIENCE_MS = 180_000;

/** Poll until the condition holds; resolves false (and says why) at the deadline. */
export async function until(what: string, pred: () => boolean, ms = PATIENCE_MS): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) { console.error(`   (timed out after ${ms}ms waiting for: ${what})`); return false; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}
