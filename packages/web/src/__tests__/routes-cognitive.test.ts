/**
 * cognitive routes smoke (web split slice 1, 2026-10-16): the eight
 * endpoints moved VERBATIM from server.ts to routes/cognitive.ts — this
 * pins the delegation actually serves them (contract preservation proof:
 * a live server on a throwaway home answers each path with its shape).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.ts';

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cog-routes-'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  // isolate EVERYTHING: homeDir() reads HMH_HOME per call, so a temp home
  // means a fresh config (loopback exposure, no MCP servers, no tunnel) —
  // the first run accidentally used the REAL home and briefly bound LAN.
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    const handle = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      await fn(handle.port);
    } finally {
      await handle.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('cognitive routes served through the extracted module: paths and shapes intact', async () => {
  await withServer(async (port) => {
    const base = `http://127.0.0.1:${port}`;
    // main dashboard seed
    const cog = await fetch(`${base}/api/cognitive`);
    assert.equal(cog.status, 200);
    const cogBody = (await cog.json()) as Record<string, unknown>;
    assert.ok(typeof cogBody === 'object' && cogBody !== null, 'cognitiveStatus shape');

    // sub-endpoints return their documented shapes on an EMPTY home
    const drift = await fetch(`${base}/api/cognitive/drift`);
    assert.equal(drift.status, 200);
    assert.ok(Array.isArray((await drift.json() as { views: unknown[] }).views), 'drift views[]');

    const skills = await fetch(`${base}/api/cognitive/skills`);
    assert.equal(skills.status, 200);
    assert.ok(Array.isArray((await skills.json() as { candidates: unknown[] }).candidates), 'skills candidates[]');

    const trajs = await fetch(`${base}/api/cognitive/trajectories`);
    assert.equal(trajs.status, 200);
    assert.ok(Array.isArray((await trajs.json() as { trajectories: unknown[] }).trajectories), 'trajectories[]');

    const rep = await fetch(`${base}/api/cognitive/replay?id=does-not-exist`);
    assert.equal(rep.status, 404, 'unknown trajectory id → 404 (not 500)');

    const transfer = await fetch(`${base}/api/cognitive/transfer`);
    assert.equal(transfer.status, 200);
    assert.ok(Array.isArray((await transfer.json() as { experiments: unknown[] }).experiments), 'missing transfer.jsonl → empty experiments (not an error)');

    const team = await fetch(`${base}/api/cognitive/team`);
    assert.equal(team.status, 200);
    const teamBody = (await team.json()) as { events?: unknown; live?: unknown };
    assert.ok(teamBody.events !== undefined && teamBody.live !== undefined, 'team events+live shape');

    const cal = await fetch(`${base}/api/cognitive/calibration`);
    assert.equal(cal.status, 200);
  });
});
