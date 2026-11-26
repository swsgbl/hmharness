/**
 * finish_reason must survive the provider layer (2026-11-26).
 *
 * Until 0.23.55 both parse paths dropped it: the buffered path never read
 * `choices[0].finish_reason`, and the streaming path skipped every chunk
 * whose delta was empty - which is exactly where the reason arrives. So a
 * reply the output cap severed (finish_reason "length") reached the loop, the
 * web UI and the extension panel as a complete answer, and no caller could
 * tell a content-filtered empty reply from a broken one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chat } from '../provider.ts';

async function withServer(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handler?.(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

const CFG = (url: string) => ({ baseUrl: url, apiKey: 'k', model: 'm', timeoutMs: 30_000 });
const MSGS = [{ role: 'user' as const, content: 'go on' }];
const sse = (events: unknown[]) => (_req: unknown, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const buffered = (body: unknown) => (_req: unknown, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('buffered reply: finish_reason is carried through', async () => {
  const srv = await withServer(buffered({ choices: [{ message: { content: 'half a sent' }, finish_reason: 'length' }] }));
  try {
    const r = await chat(CFG(srv.url), MSGS);
    assert.equal(r.message.content, 'half a sent');
    assert.equal(r.finishReason, 'length');
  } finally {
    await srv.close();
  }
});

test('buffered reply: no finish_reason reported -> the field is absent, not a guess', async () => {
  const srv = await withServer(buffered({ choices: [{ message: { content: 'fine' } }] }));
  try {
    const r = await chat(CFG(srv.url), MSGS);
    assert.equal(r.message.content, 'fine');
    assert.equal('finishReason' in r, false);
  } finally {
    await srv.close();
  }
});

test('stream: the reason arrives on a chunk with an EMPTY delta and is still seen', async () => {
  // the shape every OpenAI-compatible gateway sends last: delta {} + finish_reason
  const srv = await withServer(sse([
    { choices: [{ delta: { content: 'to be cont' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
  ]));
  try {
    const deltas: Array<[string, string]> = [];
    const r = await chat(CFG(srv.url), MSGS, [], { onDelta: (k, c) => deltas.push([k, c]) });
    assert.equal(r.message.content, 'to be cont');
    assert.equal(r.finishReason, 'length');
    assert.deepEqual(deltas, [['text', 'to be cont']], 'the empty delta emits nothing');
    assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 4 });
  } finally {
    await srv.close();
  }
});

test('stream: the reason may ride a chunk that also carries text; a later one wins', async () => {
  const srv = await withServer(sse([
    { choices: [{ delta: { content: 'a' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] },
  ]));
  try {
    const r = await chat(CFG(srv.url), MSGS, [], { onDelta: () => undefined });
    assert.equal(r.message.content, 'ab');
    assert.equal(r.finishReason, 'stop', 'null is not a reason');
  } finally {
    await srv.close();
  }
});

test('stream: a stream cut with no reason at all stays absent (a severed socket is not "length")', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'cut' } }] })}\n\n`);
    res.destroy();
  });
  try {
    const r = await chat(CFG(srv.url), MSGS, [], { onDelta: () => undefined, retry: { attempts: 1 } }).catch((e: Error) => e);
    // the cut surfaces as a retryable failure (see stream-resilience.test.ts); whichever way it
    // ends, it must never be reported as a finished reply
    assert.ok(r instanceof Error ? !/length/.test(String(r)) : r.finishReason !== 'length');
  } finally {
    await srv.close();
  }
});
