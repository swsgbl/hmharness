/**
 * Chat transport fallback (node:http when fetch/WebAssembly is unavailable).
 *
 * Why the poisoned-environment suites run in a CHILD PROCESS: simulating a
 * jitless board means `globalThis.WebAssembly = undefined`; while that is set,
 * any real undici fetch anywhere in the same process trips its lazy internal
 * `WebAssembly.instantiate` and rejects asynchronously AFTER the test ends
 * (unhandledRejection took unrelated suites down on CI Linux, 2026-10-29).
 * The driver (transport-fallback-driver.mts) poisons only its own process.
 * What stays in-process: the pure probe unit tests, whose poisoned windows
 * never await anything (no fetch can run inside them).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectTransportMode, __resetTransportForTests } from '../http-transport.ts';

const here = dirname(fileURLToPath(import.meta.url));

type SeenRequest = { method?: string; auth: string | undefined; ctype: string | string[] | undefined; body: any };

async function withServer(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string; seen: SeenRequest[]; close(): Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, auth: req.headers.authorization, ctype: req.headers['content-type'], body: raw ? JSON.parse(raw) : null });
      handler?.(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

/** Run the fallback driver in a child process (poisoned env isolated there)
 * and parse its single-line JSON result. */
function runDriver(mode: string, baseUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(here, 'transport-fallback-driver.mts'), mode, baseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      const line = out.split('\n').filter(Boolean).pop();
      if (line) {
        try { resolve(JSON.parse(line)); return; } catch { /* fall through */ }
      }
      reject(new Error(`driver ${mode} exit=${code} out=${out.slice(0, 200)} err=${err.slice(-300)}`));
    });
  });
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

test('probe: native fetch + WebAssembly -> fetch transport (normal desktop)', () => {
  assert.equal(detectTransportMode(), 'fetch');
});

test('probe: WebAssembly compiled out (jitless board) -> node transport', () => {
  const g = globalThis as { WebAssembly?: unknown };
  const real = g.WebAssembly;
  g.WebAssembly = undefined;
  try {
    // no await inside the poisoned window: nothing can schedule undici work
    assert.equal(detectTransportMode(), 'node');
  } finally {
    g.WebAssembly = real;
    __resetTransportForTests();
  }
});

test('probe: no fetch at all -> node transport', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(detectTransportMode(), 'node');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
    __resetTransportForTests();
  }
});

test('node fallback (child process) streams a full SSE chat: text/tool_calls/usage/deltas identical to the fetch path', async () => {
  const srv = await withServer((_req, res) => {
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
  const { chat } = await import('../provider.ts');
  try {
    const nodeOut = await runDriver('sse', srv.url);
    assert.ok(nodeOut.ok, `driver ok: ${JSON.stringify(nodeOut).slice(0, 200)}`);
    assert.equal(nodeOut.content, 'Hello world');
    assert.deepEqual(nodeOut.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    assert.deepEqual(nodeOut.usage, { prompt_tokens: 3, completion_tokens: 5 });
    assert.deepEqual(nodeOut.deltas, [['reasoning', 'hmm'], ['text', 'Hello '], ['text', 'world']]);

    // same parser on the fetch path in THIS process: byte-identical ChatResponse
    const fetchDeltas: Array<[string, string]> = [];
    const fetchOut = await chat(
      { baseUrl: srv.url, apiKey: 'k', model: 'm', timeoutMs: 30_000 },
      [{ role: 'user', content: 'weather in Paris?' }],
      [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      { onDelta: (k, c) => fetchDeltas.push([k, c]) },
    );
    assert.equal(fetchOut.message.content, nodeOut.content);
    assert.deepEqual(fetchOut.message.tool_calls, nodeOut.tool_calls);
    assert.deepEqual(fetchOut.usage, nodeOut.usage);
    assert.deepEqual(fetchDeltas, nodeOut.deltas);
    assert.ok(srv.seen.length >= 2, 'both transports actually hit the mock server');
    for (const s of srv.seen) {
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

test('node fallback (child process): non-streaming chat parses the buffered JSON body', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain answer' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  });
  try {
    const r = await runDriver('json', srv.url);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
    assert.equal(r.content, 'plain answer');
    assert.deepEqual(r.usage, { prompt_tokens: 1, completion_tokens: 2 });
  } finally {
    await srv.close();
  }
});

test('node fallback (child process): chatVision parses the buffered JSON body', async () => {
  const srv = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'a cat, probably' } }] }));
  });
  try {
    const r = await runDriver('vision', srv.url);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
    assert.equal(r.text, 'a cat, probably');
  } finally {
    await srv.close();
  }
});

test('node fallback (child process): external abort pierces a keep-alive SSE hang - fast fail, no retry', async () => {
  let calls = 0;
  const srv = await withServer((_req, res) => {
    calls += 1;
    // hang forever: headers only, no body, keep-alive socket held open
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  });
  try {
    const r = await runDriver('abort-hang', srv.url);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
    assert.ok(r.ms < 10_000, `abort should be fast, took ${r.ms}ms`);
    assert.equal(calls, 1, 'abort must fail the attempt, not retry into new ones');
  } finally {
    await srv.close();
  }
});
