/**
 * Stuck-executor reproduction (Zode fix task, 2026-10-26): a provider SSE
 * stream that only sends keep-alive pings (never [DONE]) hangs the per-session
 * child forever - the 180s stream-idle guard keeps getting bumped, the
 * /api/interrupt abort signal never pierces the in-flight fetch, and the
 * session stays busy until the daemon is restarted.
 *
 * Run: node --import tsx scripts/repro-stuck.mjs
 * Exit 0 = interrupt cleared busy (fix present); exit 1 = stuck (bug live).
 *
 * The provider is releasable on demand so the script exits cleanly on BOTH
 * the unfixed and fixed trees: after the verdict, release() finishes the
 * stream, the child hits the turn boundary (signal aborted), exits, and busy
 * clears without leaving orphan processes behind.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERDICT_WAIT_MS = 10_000;

/** Keep-alive-only SSE: the exact provider shape from the field reports -
 *  every ping bumps the stream-idle timer, so nothing ever times out. */
async function hangProvider() {
  const requests = { n: 0 };
  let released = false;
  const pendings = new Set();
  const server = createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
    requests.n++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    pendings.add(res);
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 100);
    res.on('close', () => { clearInterval(t); pendings.delete(res); });
    if (released) finish(res);
  });
  const finish = (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'released' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    release: () => { released = true; for (const res of pendings) { try { finish(res); } catch { /* gone */ } } },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const home = await mkdtemp(join(tmpdir(), 'hmh-stuck-repro-'));
const ws = await mkdtemp(join(tmpdir(), 'hmh-stuck-repro-ws-'));
await mkdir(join(home, 'sessions'), { recursive: true });
const provider = await hangProvider();
process.env.HMH_HOME = home;
// generous timeoutMs: the bug must show without the provider timeout ever
// firing - the fix (or the stuck verdict) has to land long before 60s
await writeFile(join(home, 'config.json'), JSON.stringify({
  provider: { baseUrl: provider.url, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
  approval: 'auto',
}), 'utf8');
process.chdir(ws);

const { startServer } = await import(pathToFileURL('G:/hmharness/packages/web/src/server.ts').href);
const handle = await startServer({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${handle.port}`;
const busyNow = async () => {
  const r = await fetch(`${base}/api/queue`);
  return Boolean((await r.json()).busy);
};

let exitCode = 1;
try {
  console.log(`repro: server ${base} · provider ${provider.url}`);
  const t = await fetch(`${base}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hang forever', mode: 'auto' }) });
  console.log(`repro: /api/task -> ${t.status}`);
  for (let i = 0; i < 100 && provider.requests.n === 0; i++) await sleep(100);
  if (provider.requests.n === 0) throw new Error('task never reached the provider (spawn/config failure - not the bug under test)');
  for (let i = 0; i < 100 && !(await busyNow()); i++) await sleep(100);
  console.log(`repro: provider hit ${provider.requests.n}x · busy=${await busyNow()} (child parked on the hanging stream)`);

  const itr = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(`repro: /api/interrupt -> ${JSON.stringify(await itr.json())}`);
  const t0 = Date.now();
  let idle = false;
  for (let i = 0; i < VERDICT_WAIT_MS / 100; i++) { idle = !(await busyNow()); if (idle) break; await sleep(100); }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (idle) {
    console.log(`repro: PASS - busy cleared ${secs}s after interrupt (abort pierces the in-flight fetch / kill backstop)`);
    exitCode = 0;
  } else {
    console.log(`repro: FAIL - interrupt returned ok but busy held for ${secs}s+ (signal never reaches the in-flight provider call; busy only clears on child exit, which never comes)`);
  }
} catch (err) {
  console.error('repro: harness error -', String(err).slice(0, 300));
} finally {
  // deterministic cleanup on both trees: finish the stream so the parked
  // child reaches its turn boundary (signal already aborted) and exits
  provider.release();
  for (let i = 0; i < 100 && (await busyNow().catch(() => false)); i++) await sleep(100);
  // NOTE: handle.close() funnels into the server shutdown path which calls
  // process.exit(0) - exiting here FIRST so the verdict code survives
  await provider.close().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
