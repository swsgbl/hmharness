/**
 * External-signal abort (Zode fix task, 2026-10-26): the web /api/interrupt
 * abort used to reach the kernel loop only at TURN BOUNDARIES - an in-flight
 * provider call ignored it. A provider SSE that only sends keep-alive pings
 * bumps the stream-idle guard forever, so nothing ever timed out either:
 * the session child hung permanently holding busy. These pin the fix: the
 * caller's AbortSignal pierces the in-flight fetch (and its stream reader),
 * fails fast, and is never retried (user intent outranks the resilience loop).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chat } from '../provider.ts';

async function withServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

test('provider: external abort pierces a keep-alive SSE hang - fast fail, no retry', async () => {
  let calls = 0;
  const srv = await withServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // pings forever: the 180s stream-idle guard keeps getting bumped - the
    // exact "permanently busy session" provider shape from the field reports
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 50);
    res.on('close', () => clearInterval(t));
  });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const err = await chat(
      { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
      [{ role: 'user', content: 'hi' }],
      undefined,
      { onDelta: () => {}, signal: ac.signal, retry: { attempts: 6, baseMs: 50 } },
    ).then(() => null, (e: unknown) => String(e));
    assert.ok(err, 'the hang was aborted, not awaited until timeoutMs');
    assert.match(err!, /abort/i);
    assert.ok(Date.now() - t0 < 5_000, 'fails fast instead of burning retries/timeouts');
    assert.equal(calls, 1, 'a user abort is never retried');
  } finally { await srv.close(); }
});

test('provider: external abort pierces a non-streaming hang before the first byte', async () => {
  // the server accepts the request and never answers; without the signal
  // link only the (configurable, default 120s) timeoutMs would end it
  const srv = await withServer(() => { /* silence = hang */ });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const err = await chat(
      { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
      [{ role: 'user', content: 'hi' }],
      undefined,
      { signal: ac.signal, retry: { attempts: 3, baseMs: 50 } },
    ).then(() => null, (e: unknown) => String(e));
    assert.ok(err, 'the silent hang was aborted');
    assert.match(err!, /abort/i);
  } finally { await srv.close(); }
});

test('provider: a pre-aborted signal fails immediately without contacting the endpoint', async () => {
  let calls = 0;
  const srv = await withServer(() => { calls++; });
  try {
    const ac = new AbortController();
    ac.abort();
    const err = await chat(
      { baseUrl: srv.url, apiKey: 'k', model: 'm' },
      [{ role: 'user', content: 'hi' }],
      undefined,
      { signal: ac.signal },
    ).then(() => null, (e: unknown) => String(e));
    assert.match(String(err), /abort/i);
    assert.equal(calls, 0, 'no request was ever sent');
  } finally { await srv.close(); }
});
