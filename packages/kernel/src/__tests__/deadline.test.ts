/**
 * Declarative deadlines (2026-11-25): chatVision and McpClient.request used to
 * hand-roll `AbortController` + `setTimeout(() => ctrl.abort())` + a `finally`
 * clearing the timer. They now take one AbortSignal.timeout() per attempt
 * through deadlineSignal(). What changed on purpose: a deadline surfaces as
 * `TimeoutError` ("aborted due to timeout") instead of a bare `AbortError`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chatVision } from '../provider.ts';
import { McpClient } from '../mcp.ts';
import { deadlineSignal } from '../deadline.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

test('deadlineSignal: a positive deadline aborts with reason name TimeoutError', async () => {
  const s = deadlineSignal(40);
  assert.equal(s.aborted, false);
  await sleep(150);
  assert.equal(s.aborted, true);
  assert.equal((s.reason as DOMException).name, 'TimeoutError', 'not AbortError: callers that tell the two apart must check for both');
});

test('deadlineSignal: values setTimeout used to coerce become an immediate deadline instead of throwing', async () => {
  for (const v of [NaN, -1, 0, undefined as unknown as number, 'abc' as unknown as number, Infinity]) {
    const s = deadlineSignal(v);
    assert.doesNotThrow(() => s.aborted, `no RangeError/TypeError for ${String(v)}`);
    // like setTimeout(0), a zero deadline fires on the next tick rather than synchronously
    await sleep(30);
    assert.equal(s.aborted, true, `coerced: ${String(v)}`);
    assert.equal((s.reason as DOMException).name, 'TimeoutError');
  }
});

test('deadlineSignal: a value beyond the platform range is clamped, never rejected', () => {
  const s = deadlineSignal(1e12); // > 2^32-1: AbortSignal.timeout() would throw RangeError
  assert.equal(s.aborted, false);
});

test('chatVision: a hanging provider is cut by its deadline and reported as a timeout, with one retry', async () => {
  let calls = 0;
  const srv = await withServer(() => { calls++; /* accepts and never answers */ });
  try {
    const t0 = Date.now();
    const err = await chatVision(
      { baseUrl: srv.url, apiKey: 'k', model: 'm' } as never,
      'describe',
      'data:image/png;base64,AAAA',
      { timeoutMs: 300 },
    ).then(() => null, (e: unknown) => String(e));
    assert.match(err!, /vision call failed after retry/);
    assert.match(err!, /timeout/i);
    assert.equal(calls, 2, 'the retry is kept');
    assert.ok(Date.now() - t0 < 8_000, 'cut by the deadline, not by some default');
  } finally { await srv.close(); }
});

test('McpClient: a hanging HTTP server is cut by the deadline, annotated as transient and chained', async () => {
  let calls = 0;
  const srv = await withServer(() => { calls++; /* silence = hang */ });
  try {
    const c = new McpClient('hang', { type: 'http', url: `${srv.url}/mcp` } as never);
    const err = await c.callTool('x', {}, 300).then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof Error);
    assert.match(err.message, /^mcp\/hang: request failed \(/, 'the annotation the model reads is unchanged');
    assert.match(err.message, /unreachable or cut the connection/, 'the transient hint is still attached');
    assert.match(err.message, /timeout/i);
    assert.ok(err.cause, 'the transport error rides along as cause');
    // unchanged semantics: ONE deadline covers the whole round trip, so after a
    // timeout the retry attempt finds the signal already aborted and never reaches
    // the server again (the hand-rolled controller behaved the same way)
    assert.equal(calls, 1);
  } finally { await srv.close(); }
});

test('McpClient: a fast transient failure is retried once with the deadline still alive', async () => {
  let calls = 0;
  const srv = await withServer((_req, socket) => { calls++; socket.destroy(); /* cut the connection at once */ });
  try {
    const c = new McpClient('cut', { type: 'http', url: `${srv.url}/mcp` } as never);
    const err = await c.callTool('x', {}, 5_000).then(() => null, (e: unknown) => e as Error);
    assert.ok(err instanceof Error);
    assert.match(err.message, /^mcp\/cut: request failed \(/);
    assert.equal(calls, 2, 'the retry that matters for a dead/restarting server is kept');
  } finally { await srv.close(); }
});
