/**
 * Stuck-executor interrupt (Zode fix task, 2026-10-26): a provider stream
 * that only sends keep-alive pings parked the per-session child forever -
 * /api/interrupt returned 200 but the abort never pierced the in-flight
 * fetch, and busy only cleared on child exit, which never came. Full-chain
 * pin: hang -> interrupt -> busy clears long before the provider timeout
 * could fire (signal pierce first, grace-period kill as the backstop).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keep-alive-only SSE provider, releasable on demand so the test can always
 *  unwind the child (even if the fix regressed) instead of leaking it. */
async function hangProvider(): Promise<{
  url: string;
  requests: { n: number };
  release: () => void;
  close: () => Promise<void>;
}> {
  const requests = { n: 0 };
  let released = false;
  const pendings = new Set<import('node:http').ServerResponse>();
  const finish = (res: import('node:http').ServerResponse) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'released' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
    requests.n++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    pendings.add(res);
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 100);
    res.on('close', () => { clearInterval(t); pendings.delete(res); });
    if (released) finish(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    release: () => { released = true; for (const res of pendings) { try { finish(res); } catch { /* gone */ } } },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

test('interrupt clears a hung session: busy -> interrupt -> idle (before any provider timeout)', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-stuck-test-'));
  const ws = await mkdtemp(join(tmpdir(), 'hmh-stuck-test-ws-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const provider = await hangProvider();
  // generous timeoutMs: the fix must NOT rely on it firing - busy has to
  // clear in seconds, long before the 60s provider timeout could self-heal
  await writeFile(join(home, 'config.json'), JSON.stringify({
    provider: { baseUrl: provider.url, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
    approval: 'auto',
  }), 'utf8');
  const prevHome = process.env.HMH_HOME;
  const prevCwd = process.cwd();
  process.env.HMH_HOME = home;
  process.chdir(ws); // child cwd: empty scratch dir (fast context pack, no repo IO)
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;
    const busyNow = async (): Promise<boolean> =>
      Boolean(((await (await fetch(`${base}/api/queue`)).json()) as { busy: boolean }).busy);

    const t = await fetch(`${base}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hang forever', mode: 'auto' }) });
    assert.equal(t.status, 200);

    // the task must actually reach the hung provider - guards against a
    // spawn/config failure that would make this test pass vacuously
    for (let i = 0; i < 100 && provider.requests.n === 0; i++) await sleep(100);
    assert.ok(provider.requests.n > 0, 'the child reached the provider (task really running)');
    for (let i = 0; i < 100 && !(await busyNow()); i++) await sleep(100);
    assert.equal(await busyNow(), true, 'session is busy while the provider hangs');

    const itr = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(itr.status, 200);

    // the fix: busy clears within seconds (abort pierce now, kill grace at 5s)
    const t0 = Date.now();
    let idle = false;
    for (let i = 0; i < 150; i++) { idle = !(await busyNow()); if (idle) break; await sleep(100); }
    assert.ok(idle, `busy cleared after interrupt (${Math.round((Date.now() - t0) / 1000)}s in)`);
    assert.ok(Date.now() - t0 < 20_000, 'cleared promptly - not via the 60s provider timeout');
  } finally {
    // deterministic unwind even on regression: finish the stream so a parked
    // child can exit instead of leaking past the test
    provider.release();
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    process.chdir(prevCwd);
    await provider.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
