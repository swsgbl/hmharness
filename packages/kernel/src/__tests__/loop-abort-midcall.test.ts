/**
 * runLoop × abort during the model call (2026-11-26, found in the web end-to-end pass).
 *
 * The abort signal "pierces the in-flight call" so a hung stream can never hold a
 * session busy. Until 0.23.55 that pierce arrived at the loop as a REJECTED model call
 * and escaped as a provider failure: pressing Stop while the answer streamed showed
 * "provider: request aborted (external signal) … task child exit 1" instead of the
 * "interrupted by user" result. A stop is a stop wherever it lands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../loop.ts';
import { Registry } from '../registry.ts';

const fakeProvider = { name: 'fake', baseUrl: 'http://fake', model: 'fake-m', apiKey: 'k' } as never;

test('a stop that lands while the model call is in flight ends the run as "interrupted", not as a failure', async () => {
  const ac = new AbortController();
  const finals: Array<[string, number]> = [];
  const res = await runLoop({
    provider: fakeProvider, registry: new Registry(),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    signal: ac.signal,
    events: { onFinal: (text: string, turn: number) => { finals.push([text, turn]); } } as never,
    chatImpl: (async (_p: unknown, _m: unknown, _t: unknown, opts: { signal?: AbortSignal; onDelta?: (k: string, c: string) => void }) => {
      // the answer starts streaming, then the user's stop cuts the request - exactly
      // what the real adapter reports when its fetch is aborted
      opts.onDelta?.('text', 'partial answer');
      ac.abort();
      throw new Error('provider: request aborted (external signal): AbortError: This operation was aborted');
    }) as never,
  });
  assert.equal(res.reason, 'interrupted', 'the stop is reported as a stop');
  assert.match(res.text, /interrupted by user at turn 1/i);
  assert.equal(finals.length, 1, 'exactly one final event: the transcript is kept and closed');
});

test('a real provider failure (signal never fired) still propagates', async () => {
  await assert.rejects(runLoop({
    provider: fakeProvider, registry: new Registry(),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    signal: new AbortController().signal,
    chatImpl: (async () => { throw new Error('HTTP 500: boom'); }) as never,
  }), /HTTP 500: boom/);
});

test('a timeout of the request itself (its own signal) is not mistaken for a user stop', async () => {
  await assert.rejects(runLoop({
    provider: fakeProvider, registry: new Registry(),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: (async () => { throw new Error('provider: request timed out'); }) as never,
  }), /timed out/);
});
