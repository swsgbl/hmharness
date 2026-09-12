import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chat } from '../provider.ts';
import { parseRetryAfterMs } from '../provider.ts';

/** Serve N failing-then-succeeding SSE attempts on a scratch port. */
async function withServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => {
      // close() alone waits for pooled keep-alive sockets (minutes); the
      // client's undici pool holds them open, so force them shut
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

test('provider: a mid-stream socket cut is retried, and clients get a reset first', async () => {
  let calls = 0;
  const srv = await withServer((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) {
      // first attempt: send a partial answer then DESTROY the socket - this is
      // the undici `TypeError: terminated` case from the bug report
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half an ans' } }] })}\n\n`);
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'complete answer' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const deltas: Array<[string, string]> = [];
    const r = await chat(
      { baseUrl: srv.url, apiKey: 'k', model: 'm' },
      [{ role: 'user', content: 'hi' }],
      undefined,
      { onDelta: (kind, chunk) => deltas.push([kind, chunk]), retry: { attempts: 3, baseMs: 30 } },
    );
    assert.equal(calls, 2, 'the cut attempt was retried exactly once');
    assert.equal(r.message.content, 'complete answer');
    // the partial text was emitted, then a reset, then the real answer
    assert.deepEqual(deltas[0], ['text', 'half an ans']);
    assert.deepEqual(deltas[1], ['reset', ''], 'a reset precedes the retry');
    assert.deepEqual(deltas[2], ['text', 'complete answer']);
  } finally { await srv.close(); }
});

test('provider: unreachable endpoint reports a readable cause after retries', async () => {
  // port 1 is reserved/unbindable - connect fails immediately
  const err = await chat(
    { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 1500 },
    [{ role: 'user', content: 'hi' }],
    undefined,
    { retry: { attempts: 2, baseMs: 30 } }, // keep the unit test fast
  ).then(() => null, (e: unknown) => String(e));
  assert.ok(err, 'the call failed');
  assert.match(err!, /failed after \d+ attempts/);
  assert.match(err!, /provider endpoint was unreachable|connection was cut/i);
  assert.doesNotMatch(err!, /^\s*TypeError: fetch failed\s*$/, 'never a bare undici error');
});

test('provider: non-streaming success still parses usage and content', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }));
  });
  try {
    const r = await chat({ baseUrl: srv.url, apiKey: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }]);
    assert.equal(r.message.content, 'hello');
    assert.equal(r.usage?.prompt_tokens, 7);
  } finally { await srv.close(); }
});

test('parseRetryAfterMs: the retry-storm regression stays fixed', () => {
  // an epoch-seconds value must never become a ~1.7e12 ms timer
  assert.equal(parseRetryAfterMs('1789105094'), 120_000);
  assert.equal(parseRetryAfterMs('2'), 2_000);
});
