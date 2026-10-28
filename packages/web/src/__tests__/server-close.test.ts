/**
 * server close() semantics regression (2026-10-29 Windows libuv teardown
 * fix): the old close path funneled into process.exit() from LIBRARY
 * context - it killed this very test process mid-run (the routes-* web
 * tests crashed file-level ~4s after start) and, on Windows, raced the
 * libuv teardown into
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c".
 * These tests pin the contract the fix established: close() is idempotent,
 * never exits the host process, terminates a hanging SSE connection during
 * the drain, and its promise resolves with every handle released. Reaching
 * the last assertion IS the "process did not crash / did not hang" proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('close(): idempotent + repeat calls never throw + drains a hanging SSE connection - host process survives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-close-sem-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;

    // a parked SSE stream - the exact shape that held the old
    // server.close() hostage forever (keep-alive socket never idle-times
    // out inside any useful window)
    const sseState = { ended: false };
    const firstByte = new Promise<void>((resolve) => {
      const req = get(`${base}/api/events`, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', () => resolve());
        res.once('end', () => { sseState.ended = true; });
        res.once('close', () => { sseState.ended = true; });
      });
      req.once('error', () => resolve()); // torn down before headers: fine below
    });
    await firstByte; // the stream is truly established now

    // idempotence: repeat calls return the SAME promise (one drain, ever)
    const p1 = handle.close();
    const p2 = handle.close();
    assert.equal(p1, p2, 'close() is idempotent: same promise for every call');
    await p1; // resolves once every registered handle has drained
    await p2; // awaiting again: no throw

    // the hanging SSE connection was terminated by the drain, not left to
    // its 15s heartbeat / 4s keep-alive devices
    const t0 = Date.now();
    while (!sseState.ended && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(sseState.ended, 'hanging SSE connection terminated by close()');

    // post-close: the listener is gone (connection refused) and this host
    // process is still alive and running assertions - no library-exit, no
    // libuv teardown crash
    await assert.rejects(fetch(`${base}/api/state`), /fetch failed|ECONNREFUSED/);
  } finally {
    if (close) await close(); // third call across the finally boundary: no-op
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
