/**
 * filesystem routes smoke (web split slice 3, 2026-10-16): nine endpoints
 * moved to routes/filesystem.ts — a live server on a throwaway home pins
 * the delegation (read-only shapes + the workspace-boundary guards; the
 * chdir-mutating /workspaces/use is covered by its 404/409 validation
 * paths only, to keep the test cwd-stable).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

test('filesystem routes served through the extracted module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-fs-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    close = () => handle.close();
    const base = `http://127.0.0.1:${handle.port}`;

    // workspaces list: shape (current + items[] with at least the cwd ws)
    const ws = await fetch(`${base}/api/workspaces`);
    assert.equal(ws.status, 200);
    const wsBody = (await ws.json()) as { current: string; items: Array<{ id: string; name: string; path: string }> };
    assert.ok(Array.isArray(wsBody.items) && wsBody.items.length >= 1, 'workspace items[]');
    assert.ok(typeof wsBody.current === 'string');

    // workspaces add: validation shapes
    const badAdd = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(badAdd.status, 400);
    assert.match((await badAdd.json() as { error: string }).error, /absolute path/);

    // workspaces use: unknown id -> 404 (validation only, no chdir attempted)
    const badUse = await fetch(`${base}/api/workspaces/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ghost' }) });
    assert.equal(badUse.status, 404);

    // fs browser: drives/roots shape (no path)
    const roots = await fetch(`${base}/api/fs`);
    assert.equal(roots.status, 200);
    const rootsBody = (await roots.json()) as { path: string; dirs: Array<{ name: string; path: string }> };
    assert.equal(rootsBody.path, '');
    assert.ok(rootsBody.dirs.length >= 1, 'drive roots listed');

    // fs browser: relative path rejected
    const rel = await fetch(`${base}/api/fs?path=relative`);
    assert.equal(rel.status, 400);

    // fs/search: q required
    const noQ = await fetch(`${base}/api/fs/search`);
    assert.equal(noQ.status, 400);

    // fs/read: outside-workspace guard fires before any disk access
    const outside = await fetch(`${base}/api/fs/read?path=C:/Windows/win.ini`);
    assert.equal(outside.status, 400);
    assert.match((await outside.json() as { error: string }).error, /inside the active workspace/);

    // fs/read: a file INSIDE the workspace reads through the extracted route
    await writeFile(join(process.cwd(), 'hmh-fs-smoke.txt'), 'hello slice3\n', 'utf8');
    try {
      const read = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(join(process.cwd(), 'hmh-fs-smoke.txt'))}`);
      assert.equal(read.status, 200);
      const readBody = (await read.json()) as { text?: string; binary?: boolean };
      assert.equal(readBody.binary, undefined);
      assert.match(readBody.text ?? '', /hello slice3/);
    } finally {
      await rm(join(process.cwd(), 'hmh-fs-smoke.txt'), { force: true });
    }

    // open: outside-workspace guard
    const badOpen = await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'C:/Windows' }) });
    assert.equal(badOpen.status, 400);
  } finally {
    if (close) await close();
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
