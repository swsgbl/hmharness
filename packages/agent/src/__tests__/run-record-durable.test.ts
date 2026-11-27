/**
 * The run record is on disk when the task is reported done (2026-11-27).
 *
 * The observability recorder appends through a fire-and-forget queue; its
 * finish() resolves once every queued append and the summary are durable. The
 * runner used to fire it without the await, so at the moment a task returned
 * its record was often still incomplete (measured on the released code: 22 of
 * 40 runs, 37 of 40 with every core busy - the last events, or the summary,
 * were not on disk yet). Anything that reads the record right after a task - a
 * test, a list refresh, an export - could find its tail missing. It surfaced as
 * a flaky gate test on a slow CI runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as agent from '../runner.ts';
import { baseTools } from '../tools.ts';
import { Registry, defaultConfig, type ChatMessage, type Tool, type ProviderConfig } from '@hmharness/kernel';

const echo: Tool = {
  name: 'echo', description: 'echo the text back', readOnly: true,
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) { return { output: 'pong:' + String(args.text ?? '') }; },
};

/** A model that calls `echo` eight times in one turn, then answers - or, with
 *  `fail`, answers every request with HTTP 401 (an authentication error: the
 *  kernel does not retry it, so the task fails at once - a 500 is retried with
 *  backoff for ~90 s). The eight calls put a burst of events in the recorder's
 *  queue right before the end of the run: exactly the tail the old runner
 *  returned ahead of. Records every main-loop request it receives. */
async function scriptedModel(opts: { fail?: boolean } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const part of req) body += part;
    if (!(req.url ?? '').includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    if (opts.fail) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } })); return; }
    const parsed = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[]; stream?: boolean };
    const messages = parsed.messages ?? [];
    if (!(parsed.tools ?? []).length) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); return; }
    const answered = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).some((m) => m.role === 'tool');
    const calls = answered ? [] : Array.from({ length: 8 }, (_, i) => ({ id: `call_${i}`, type: 'function' as const, function: { name: 'echo', arguments: '{"text":"hi"}' } }));
    const text = calls.length ? null : 'done';
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
      if (calls.length) res.write(chunk({ tool_calls: calls.map((c, i) => ({ index: i, ...c })) }));
      if (text) res.write(chunk({ content: text }));
      res.write(chunk({}, calls.length ? 'tool_calls' : 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
    }
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const cfgFor = (baseUrl: string): ProviderConfig => ({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 20_000 });
const reg = (): Registry => { const r = new Registry(); for (const t of baseTools) r.register(t); r.register(echo); return r; };

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-runrec-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(home); } finally {
    if (prev === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The run record as it is on disk at the moment this is called - nothing waited for. */
async function runRecordNow(home: string): Promise<{ exists: boolean; last: string; toolDone: number; summary: string }> {
  const runDir = join(home, 'runs');
  let id: string;
  try { [id] = await readdir(runDir); } catch { return { exists: false, last: '', toolDone: 0, summary: '' }; }
  if (!id) return { exists: false, last: '', toolDone: 0, summary: '' };
  let last = '';
  let toolDone = 0;
  try {
    const lines = (await readFile(join(runDir, id, 'trajectory.jsonl'), 'utf8')).split('\n').filter(Boolean);
    last = lines.length ? String((JSON.parse(lines.at(-1)!) as { type?: string }).type) : '';
    toolDone = lines.filter((l) => l.includes('"type":"tool.completed"')).length;
  } catch { /* not there yet */ }
  let summary = '';
  try { summary = await readFile(join(runDir, id, 'summary.json'), 'utf8'); } catch { /* not there yet */ }
  return { exists: true, last, toolDone, summary };
}

test('a finished task has its whole run record and its summary on disk the moment it returns', async () => {
  assert.equal(typeof (agent as Record<string, unknown>).runAgentTask, 'function');
  await withTempHome(async (home) => {
    const model = await scriptedModel();
    try {
      const r = await agent.runAgentTask({ task: 'echo eight times, then answer', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} });
      assert.equal(r.reason, 'final');
      // no pause, no retry: read at once
      const record = await runRecordNow(home);
      assert.ok(record.exists, 'the run directory is there the instant the task returned');
      assert.ok(record.toolDone >= 8, 'the burst of tool events is on record (got ' + record.toolDone + ')');
      assert.equal(record.last, 'run.completed', 'the end event is the last line on disk');
      assert.match(record.summary, /"success"\s*:\s*true/, 'and so is the summary');
    } finally { await model.close(); }
  });
});

test('a failed task too: the failure is on record before it surfaces', async () => {
  await withTempHome(async (home) => {
    const model = await scriptedModel({ fail: true });
    try {
      await assert.rejects(() => agent.runAgentTask({ task: 'echo eight times, then answer', registry: reg(), cfg: { ...defaultConfig(), provider: cfgFor(model.url) }, yes: true, events: {} }));
      const record = await runRecordNow(home);
      assert.ok(record.exists, 'the run directory is there the instant the task threw');
      assert.equal(record.last, 'run.failed');
      assert.match(record.summary, /"success"\s*:\s*false/);
    } finally { await model.close(); }
  });
});
