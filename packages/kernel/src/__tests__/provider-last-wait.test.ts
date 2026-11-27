/**
 * A backoff waits BETWEEN attempts, never after the last one (2026-11-27).
 *
 * chat() used to sleep once more after its final failed attempt, then throw.
 * Against a provider that cannot be reached that is the difference between
 * 158.7 s (measured) and the ~95 s its own policy sums to: the last 60 s were
 * spent waiting for an attempt that never comes. chatVision() did the same on
 * a small scale (1.5 s + 3 s).
 *
 * The tests record the delays that were asked for rather than timing the call:
 * which waits happened is the fact, however fast or slow the machine is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chat, chatVision } from '../provider.ts';
import type { ChatMessage, ProviderConfig } from '../types.ts';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

/** Record the delay of every timer the retry loop starts, and nothing else: a
 *  timer counts when its call stack passes through the provider module. The
 *  runtime's own HTTP client (undici) starts timers too - one of exactly
 *  3000 ms, which reads just like a backoff. Each still runs for its real time. */
function recordTimers(): { delays: number[]; stop(): void } {
  const real = globalThis.setTimeout as unknown as (...args: unknown[]) => unknown;
  const delays: number[] = [];
  globalThis.setTimeout = ((...args: unknown[]) => {
    if (/provider\.(ts|js|mjs):\d+/.test(new Error().stack ?? '')) delays.push(Number(args[1]));
    return real(...args);
  }) as unknown as typeof setTimeout;
  return { delays, stop: () => { globalThis.setTimeout = real as unknown as typeof setTimeout; } };
}
const between = (delays: number[], from: number, to: number): number => delays.filter((d) => d >= from && d < to).length;

/** A provider that refuses every request: HTTP 429 (Retry-After: 1 s) or 503. */
async function refusing(kind: '429' | '503'): Promise<{ cfg: ProviderConfig; hits: () => number; close(): Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      if (kind === '429') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{"error":"slow down"}'); return; }
      res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"overloaded"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    cfg: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }, hits: () => hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A loopback port that is closed for sure: bind, read the number, release it. */
async function closedPortUrl(): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return `http://127.0.0.1:${port}/v1`;
}

test('chat: a backoff waits between attempts only - never after the last one', async () => {
  // 429 with Retry-After: 1 -> a 1-2 s wait (jitter) after every failed attempt
  const limited = await refusing('429');
  try {
    const timers = recordTimers();
    try { await assert.rejects(chat(limited.cfg, MESSAGES, [], { retry: { attempts: 2 } }), /failed after 2 attempts/); } finally { timers.stop(); }
    assert.equal(limited.hits(), 2, 'two attempts were made');
    assert.equal(between(timers.delays, 1_000, 2_000), 1, 'one wait, between the two attempts - a second would be a wait for an attempt that never comes: ' + timers.delays);
  } finally { await limited.close(); }

  // 503 -> the 2 s, 4 s ladder: the 4 s one sits after the LAST attempt
  const down = await refusing('503');
  try {
    const timers = recordTimers();
    try { await assert.rejects(chat(down.cfg, MESSAGES, [], { retry: { attempts: 2 } }), /failed after 2 attempts/); } finally { timers.stop(); }
    assert.equal(down.hits(), 2, 'two attempts were made');
    assert.equal(between(timers.delays, 2_000, 3_000), 1, 'the wait between the attempts is kept: ' + timers.delays);
    assert.equal(between(timers.delays, 4_000, 5_000), 0, 'no wait after the last attempt: ' + timers.delays);
  } finally { await down.close(); }

  // a provider that cannot be reached at all (base 50 ms: waits of 50-100 ms, then 100-150 ms)
  const dead: ProviderConfig = { baseUrl: await closedPortUrl(), apiKey: 'k', model: 'm', timeoutMs: 300 };
  const timers = recordTimers();
  try { await assert.rejects(chat(dead, MESSAGES, [], { retry: { attempts: 2, baseMs: 50 }, timeoutMs: 300 }), /failed after 2 attempts/); } finally { timers.stop(); }
  assert.equal(between(timers.delays, 50, 100), 1, 'the wait between the attempts is kept: ' + timers.delays);
  assert.equal(between(timers.delays, 100, 150), 0, 'no wait after the last attempt: ' + timers.delays);
});

test('chatVision: the same - no wait after its last attempt', async () => {
  const down = await refusing('503');
  try {
    const timers = recordTimers();
    try { await assert.rejects(chatVision(down.cfg, 'describe', 'data:image/png;base64,AAAA'), /vision call failed after retry/); } finally { timers.stop(); }
    assert.equal(down.hits(), 2, 'two attempts were made');
    assert.equal(between(timers.delays, 1_500, 2_500), 1, 'the wait between the attempts is kept: ' + timers.delays);
    assert.equal(between(timers.delays, 3_000, 4_000), 0, 'no wait after the last attempt: ' + timers.delays);
  } finally { await down.close(); }

  // a provider that accepts and never answers: the deadline cuts every attempt,
  // and that failure takes the other way out of the loop (the catch branch)
  const silent: Server = createServer(() => { /* accept, say nothing */ });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const { port } = silent.address() as { port: number };
  try {
    const timers = recordTimers();
    try { await assert.rejects(chatVision({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }, 'describe', 'data:image/png;base64,AAAA', { timeoutMs: 100 }), /vision call failed after retry/); } finally { timers.stop(); }
    assert.equal(between(timers.delays, 1_500, 2_500), 1, 'the wait between the attempts is kept: ' + timers.delays);
    assert.equal(between(timers.delays, 3_000, 4_000), 0, 'no wait after the last attempt: ' + timers.delays);
  } finally { silent.closeAllConnections?.(); await new Promise<void>((r) => silent.close(() => r())); }
});
