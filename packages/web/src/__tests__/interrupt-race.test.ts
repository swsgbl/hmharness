/**
 * Interrupt-vs-spawn race (2026-10-26 stuck-executor fix, companion to
 * interrupt-stuck.test.ts): runOne latches busy synchronously BEFORE the
 * child (and its stdin) exists. An interrupt arriving inside that window
 * used to hit the no-stdin path, report ok:false, and lose the abort - the
 * task then ran/hung to completion with busy latched. The fix latches the
 * intent on the exec and runOne replays it the moment stdin exists. Single
 * test per file: startServer's close() funnels into process.exit, which
 * would kill any sibling test (same shape as routes-sessions.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('an interrupt racing the spawn is not lost: intent replays once stdin exists', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-race-test-'));
  const ws = await mkdtemp(join(tmpdir(), 'hmh-race-test-ws-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  // slow but finite provider: the raced interrupt must kill the run LONG
  // before this would have completed on its own
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, 45_000);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const purl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
  await writeFile(join(home, 'config.json'), JSON.stringify({
    provider: { baseUrl: purl, apiKey: 'k', model: 'm', timeoutMs: 60_000 },
    approval: 'auto',
  }), 'utf8');
  const prevHome = process.env.HMH_HOME;
  const prevCwd = process.cwd();
  process.env.HMH_HOME = home;
  process.chdir(ws);
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;
    const busyNow = async (): Promise<boolean> =>
      Boolean(((await (await fetch(`${base}/api/queue`)).json()) as { busy: boolean }).busy);

    // fire the task and the interrupt back-to-back: no waiting for the
    // provider - the interrupt must land inside the spawn window
    const t = await fetch(`${base}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'slow task', mode: 'auto' }) });
    assert.equal(t.status, 200);
    assert.equal(await busyNow(), true, 'busy latches synchronously (pre-spawn)');
    const itr = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(itr.status, 200);
    assert.equal(((await itr.json()) as { ok: boolean }).ok, true, 'a busy session accepts the interrupt even pre-spawn');

    // the replayed abort (or its kill backstop) must clear busy in seconds,
    // long before the 45s provider answer or the 60s timeout
    const t0 = Date.now();
    let idle = false;
    for (let i = 0; i < 150; i++) { idle = !(await busyNow()); if (idle) break; await sleep(100); }
    assert.ok(idle, `busy cleared after the raced interrupt (${Math.round((Date.now() - t0) / 1000)}s in)`);
    assert.ok(Date.now() - t0 < 20_000, 'not left waiting on the provider answer/timeout');
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    process.chdir(prevCwd);
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
