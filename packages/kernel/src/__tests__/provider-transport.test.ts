/**
 * kernel http-transport (jitless-board fix, 2026-10-29): boards that must
 * run node --jitless compile out WebAssembly, so undici's fetch throws
 * "fetch failed WebAssembly is not defined" on EVERY call and provider chat
 * died retrying forever at 0% CPU. These pin the node:http fallback:
 * probe logic, streaming parity with the fetch path through the SAME SSE
 * parser, non-streaming/vision JSON paths, abort semantics, mid-stream cut
 * normalization, and the one-shot activation warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chat, chatVision } from '../provider.ts';
import { detectTransportMode, httpFetch, __resetTransportForTests } from '../http-transport.ts';

interface SeenRequest {
  method?: string;
  auth?: string;
  ctype?: string;
  body: { model?: string; stream?: boolean };
}

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

/** Run `fn` with the transport forced onto the node fallback (WebAssembly
 *  deleted, memo dropped) and the real globals restored afterwards. */
async function withNodeTransport<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { WebAssembly?: unknown };
  const realWasm = g.WebAssembly;
  g.WebAssembly = undefined;
  __resetTransportForTests();
  try {
    return await fn();
  } finally {
    g.WebAssembly = realWasm;
    __resetTransportForTests();
  }
}

// One full streamed chat on the wire: a split tool_call, a reasoning delta,
// two text halves, usage on the last event - then [DONE].
const SSE_EVENTS = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
  { choices: [{ delta: { reasoning_content: 'hmm' } }] },
  { choices: [{ delta: { content: 'Hello ' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
  { choices: [{ delta: { content: 'world' } }], usage: { prompt_tokens: 3, completion_tokens: 5 } },
];

function sseHandler(seen: SeenRequest[]): Parameters<typeof createServer>[1] {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, auth: req.headers.authorization, ctype: req.headers['content-type'], body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      void (async () => {
        for (const e of SSE_EVENTS) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
          await new Promise((r) => setTimeout(r, 10));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  };
}

test('probe: native fetch + WebAssembly -> fetch transport (normal desktop)', () => {
  assert.equal(detectTransportMode(), 'fetch');
});

test('probe: WebAssembly compiled out (jitless board) -> node transport', () => {
  const g = globalThis as { WebAssembly?: unknown };
  const real = g.WebAssembly;
  g.WebAssembly = undefined;
  try {
    assert.equal(detectTransportMode(), 'node');
  } finally {
    g.WebAssembly = real;
  }
});

test('probe: no fetch at all -> node transport', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(detectTransportMode(), 'node');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
  }
});

test('node fallback streams a full SSE chat: identical text/tool_calls/usage to the fetch path', async () => {
  const seen: SeenRequest[] = [];
  const srv = await withServer(sseHandler(seen));
  const cfg = { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 30_000 };
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const send = (sink: Array<[string, string]>) =>
    chat(cfg, [{ role: 'user', content: 'weather in Paris?' }], tools, { onDelta: (k, c) => sink.push([k, c]) });
  try {
    const nodeDeltas: Array<[string, string]> = [];
    const nodeOut = await withNodeTransport(() => send(nodeDeltas));
    assert.equal(nodeOut.message.content, 'Hello world');
    assert.deepEqual(nodeOut.message.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    assert.deepEqual(nodeOut.usage, { prompt_tokens: 3, completion_tokens: 5 });
    assert.deepEqual(nodeDeltas, [['reasoning', 'hmm'], ['text', 'Hello '], ['text', 'world']]);

    const fetchDeltas: Array<[string, string]> = [];
    const fetchOut = await send(fetchDeltas);
    // same parser, same wire bytes -> byte-identical ChatResponse either way
    assert.deepEqual(nodeOut, fetchOut);
    assert.deepEqual(nodeDeltas, fetchDeltas);

    assert.equal(seen.length, 2, 'both transports actually hit the mock server');
    for (const s of seen) {
      assert.equal(s.method, 'POST');
      assert.equal(s.auth, 'Bearer k');
      assert.equal(s.ctype, 'application/json');
      assert.equal(s.body.model, 'm');
      assert.equal(s.body.stream, true);
    }
  } finally {
    await srv.close();
  }
});

test('node fallback: non-streaming chat parses the buffered JSON body', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain answer' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  });
  try {
    const out = await withNodeTransport(() =>
      chat({ baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 15_000 }, [{ role: 'user', content: 'hi' }]));
    assert.equal(out.message.content, 'plain answer');
    assert.deepEqual(out.usage, { prompt_tokens: 1, completion_tokens: 2 });
  } finally {
    await srv.close();
  }
});

test('node fallback: chatVision parses the buffered JSON body', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'a cat, probably' } }] }));
  });
  try {
    const out = await withNodeTransport(() =>
      chatVision({ baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 15_000 }, 'what is it?', 'data:image/png;base64,iVBORw0KGgo='));
    assert.equal(out, 'a cat, probably');
  } finally {
    await srv.close();
  }
});

test('node fallback: external abort pierces a keep-alive SSE hang - fast fail, no retry', async () => {
  let calls = 0;
  const srv = await withServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // pings forever: the stream-idle guard keeps getting bumped - the exact
    // provider shape that must yield to the caller's AbortSignal
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 50);
    res.on('close', () => clearInterval(t));
  });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const err = await withNodeTransport(() =>
      chat(
        { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
        [{ role: 'user', content: 'hi' }],
        undefined,
        { onDelta: () => {}, signal: ac.signal, retry: { attempts: 6, baseMs: 50 } },
      )).then(() => null, (e: unknown) => String(e));
    assert.ok(err, 'the hang was aborted, not awaited until timeoutMs');
    assert.match(err!, /abort/i);
    assert.ok(Date.now() - t0 < 5_000, 'fails fast instead of burning retries/timeouts');
    assert.equal(calls, 1, 'a user abort is never retried');
  } finally {
    await srv.close();
  }
});

test('node fallback: mid-stream server cut surfaces as a transient error, not a silent partial answer', async () => {
  let calls = 0;
  const srv = await withServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(SSE_EVENTS[2])}\n\n`); // one text delta...
    res.destroy(); // ...then the server dies mid-body
  });
  try {
    const err = await withNodeTransport(() =>
      chat(
        { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 15_000 },
        [{ role: 'user', content: 'hi' }],
        undefined,
        { onDelta: () => {}, retry: { attempts: 1, baseMs: 50 } },
      )).then(() => null, (e: unknown) => String(e));
    assert.ok(err, 'the cut was surfaced as a failure');
    // transient shape (terminated/ECONN/aborted/fetch failed) - NOT a
    // silent partial "Hello " completion, and NOT a permanent error
    assert.match(err!, /terminated|abort|ECONN|fetch failed/i);
    assert.equal(calls, 1, 'single attempt configured');
  } finally {
    await srv.close();
  }
});

test('node fallback: connection refused normalizes to the fetch-failed error shape', async () => {
  const srv = await withServer(() => { /* never reached */ });
  const dead = srv.url;
  await srv.close();
  await withNodeTransport(async () => {
    await assert.rejects(
      httpFetch(`${dead}/chat/completions`, { method: 'POST' }),
      /fetch failed/, // same prefix undici produces -> TRANSIENT_RE semantics unchanged
    );
  });
});

test('fallback activation warns exactly once', async () => {
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  const srv = await withServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  try {
    await withNodeTransport(async () => {
      await httpFetch(`${srv.url}/x`);
      await httpFetch(`${srv.url}/x`);
    });
    const notes = warns.filter((w) => w.includes('[chat] fetch unavailable'));
    assert.equal(notes.length, 1, 'the one-shot forensics warning fires once, not per call');
    assert.match(notes[0]!, /node:http transport/);
  } finally {
    console.warn = realWarn;
    await srv.close();
  }
});
