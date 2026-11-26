/**
 * `web_search` works where DuckDuckGo does not (2026-11-26).
 *
 * The tool had one engine hard-coded. On the machine this was written on
 * (China) DuckDuckGo is unreachable, so every search timed out: 0 of 23
 * succeeded, and the self-evolution layer learned to block the tool for it.
 * Now: engines are tried in order, and one that is unreachable is remembered
 * as such for a while - across processes - so the next search does not sit out
 * the timeout again.
 *
 * Every request here goes to a server the test started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebSearchTool, parseBing, parseDuckDuckGo, readEngineState, type SearchEngine } from '../tools.ts';

const BING_HTML = [
  '<ol id="b_results">',
  '<li class="b_algo" data-id="1"><div class="b_tpcn"><a class="tilk" href="https://docs.openharmony.cn/">site</a></div>',
  '<h2><a target="_blank" href="https://docs.openharmony.cn/" h="ID=SERP,1">OpenAtom <strong>OpenHarmony</strong> docs</a></h2>',
  '<div class="b_caption"><p class="b_lineclamp2 b_algoSlug">We provide a series of app &amp; samples</p></div></li>',
  '<li class="b_algo" data-id="2"><h2><a href="https://www.bing.com/ck/a?!&p=3&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL29wZW5oYXJtb255&amp;ntb=1">Mirror</a></h2>',
  '<p class="b_paractl">A read-only mirror</p></li>',
  '<li class="b_algo" data-id="3"><h2><a href="https://example.com/no-snippet">No snippet here</a></h2><div>nothing</div></li>',
  '<li class="b_algo" data-id="4"><h2><a href="https://example.com/4">Fourth</a></h2><p class="b_lineclamp4">fourth snippet</p></li>',
  '</ol>',
].join('');
const DDG_HTML = [
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.openharmony.cn%2F">OpenHarmony docs</a>',
  '<a class="result__snippet" href="x">The official documentation</a>',
  '<a class="result__a" href="https://example.com/b">Second &amp; result</a><a class="result__snippet" href="x">snippet two</a>',
].join('');

test('parsers read both engines and never mix a result up with its neighbour', () => {
  assert.deepEqual(parseBing(BING_HTML, 10), [
    '1. OpenAtom OpenHarmony docs | https://docs.openharmony.cn/ | We provide a series of app & samples',
    '2. Mirror | https://github.com/openharmony | A read-only mirror',
    '3. No snippet here | https://example.com/no-snippet',
    '4. Fourth | https://example.com/4 | fourth snippet',
  ]);
  assert.equal(parseBing(BING_HTML, 2).length, 2, 'count is honoured');
  assert.deepEqual(parseBing('<ol><li class="b_algo"><div>no title link</div></li><li class="b_algo"><h2><a href="/x">   </a></h2></li></ol>', 5), [], 'a result without a title, or with an empty one, is skipped - not guessed');
  assert.deepEqual(parseDuckDuckGo(DDG_HTML, 10), [
    '1. OpenHarmony docs | https://docs.openharmony.cn/ | The official documentation',
    '2. Second & result | https://example.com/b | snippet two',
  ]);
});

interface FakeEngines { url: (path: string) => string; hits: Record<string, number>; close(): Promise<void> }

/** A server standing in for the engines: `/ok?q=` answers with Bing results,
 *  `/down` cuts the connection, `/503`, `/404`, `/empty` behave as named. */
async function fakeEngines(): Promise<FakeEngines> {
  const hits: Record<string, number> = {};
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url || '').split('?')[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === '/down') { req.socket.destroy(); return; }
    if (path === '/503') { res.writeHead(503); res.end('later'); return; }
    if (path === '/404') { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/ddg' ? DDG_HTML : path === '/empty' ? '<html><body>nothing here</body></html>' : BING_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    hits,
    url: (path: string) => `http://127.0.0.1:${port}${path}?q=`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-search-'));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

const bing = (f: FakeEngines, name = 'Bing'): SearchEngine => ({ name, endpoint: f.url('/ok'), parse: parseBing });

test('when the first engine is unreachable the second answers', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      const tool = createWebSearchTool([{ name: 'DuckDuckGo', endpoint: f.url('/down'), parse: parseDuckDuckGo }, bing(f)], { timeoutMs: 4_000 });
      const r = await tool.execute({ query: 'openharmony docs' }, { cwd: '.', home });
      assert.notEqual(r.isError, true, r.output);
      assert.match(r.output, /^1\. OpenAtom OpenHarmony docs \| https:\/\/docs\.openharmony\.cn\//);
      assert.deepEqual([f.hits['/down'], f.hits['/ok']], [1, 1]);
    });
  } finally { await f.close(); }
});

test('an engine that was unreachable is remembered, so the next search goes straight to the working one', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      const dead = { name: 'DuckDuckGo', endpoint: f.url('/down'), parse: parseDuckDuckGo } as SearchEngine;
      const tool = createWebSearchTool([dead, bing(f)], { timeoutMs: 4_000 });
      await tool.execute({ query: 'first' }, { cwd: '.', home });
      const state = readEngineState(home);
      assert.ok((state.DuckDuckGo ?? 0) > Date.now(), 'the breaker is open for DuckDuckGo');
      assert.match(await readFile(join(home, 'search-engines.json'), 'utf8'), /"DuckDuckGo"/, 'and it is on disk: the next task is another process');
      const t0 = Date.now();
      await tool.execute({ query: 'second' }, { cwd: '.', home });
      assert.equal(f.hits['/down'], 1, 'the dead engine was not asked again');
      assert.ok(Date.now() - t0 < 2_000, 'so the second search did not wait for the timeout');
    });
  } finally { await f.close(); }
});

test('the memory expires, and an engine that answers again is cleared', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      await writeFile(join(home, 'search-engines.json'), JSON.stringify({ down: { DuckDuckGo: Date.now() - 1000 } }), 'utf8');
      const tool = createWebSearchTool([{ name: 'DuckDuckGo', endpoint: f.url('/ddg'), parse: parseDuckDuckGo }, bing(f)], { timeoutMs: 4_000 });
      const r = await tool.execute({ query: 'x' }, { cwd: '.', home });
      assert.match(r.output, /OpenHarmony docs/, 'the engine is asked again once the memory expired');
      assert.equal(f.hits['/ok'] ?? 0, 0, 'and it answered, so the fallback was not needed');
      assert.equal(f.hits['/ddg'], 1);
      assert.deepEqual(readEngineState(home), {}, 'its record is cleared');
    });
  } finally { await f.close(); }
});

test('only the engine own trouble opens the breaker: 503 and a cut connection do, a 404 does not', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      const tool = createWebSearchTool([
        { name: 'Overloaded', endpoint: f.url('/503'), parse: parseBing },
        { name: 'NotFound', endpoint: f.url('/404'), parse: parseBing },
        bing(f),
      ], { timeoutMs: 4_000 });
      const r = await tool.execute({ query: 'x' }, { cwd: '.', home });
      assert.match(r.output, /OpenHarmony docs/);
      const state = readEngineState(home);
      assert.ok((state.Overloaded ?? 0) > Date.now(), '503: remembered');
      assert.equal(state.NotFound, undefined, '404: about this request, not remembered');
    });
  } finally { await f.close(); }
});

test('when every engine is down the failure names each one', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      const tool = createWebSearchTool([{ name: 'Cut', endpoint: f.url('/down'), parse: parseBing }, { name: 'Overloaded', endpoint: f.url('/503'), parse: parseBing }], { timeoutMs: 4_000 });
      const r = await tool.execute({ query: 'x' }, { cwd: '.', home });
      assert.equal(r.isError, true);
      assert.match(r.output, /^search failed: Cut: .*\b terminated|fetch failed|other side closed/);
      assert.match(r.output, /Overloaded: HTTP 503/);
    });
  } finally { await f.close(); }
});

test('engines that answer with nothing mean "no results", not a failure', async () => {
  const f = await fakeEngines();
  try {
    await withHome(async (home) => {
      const tool = createWebSearchTool([{ name: 'Empty', endpoint: f.url('/empty'), parse: parseBing }], { timeoutMs: 4_000 });
      const r = await tool.execute({ query: 'zzz' }, { cwd: '.', home });
      assert.equal(r.isError, undefined);
      assert.equal(r.output, 'no results (try a different query)');
      assert.deepEqual(readEngineState(home), {});
    });
  } finally { await f.close(); }
});
