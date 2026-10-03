import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverBrowsers, detectRunning } from '../registry.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'browser-registry-'));
}

/** only entries under our tmp roots — PATH results on a real machine vary */
const mine = (roots: string[], found: ReturnType<typeof discoverBrowsers>) =>
  found.filter((b) => roots.some((r) => b.command.startsWith(r)));

test('registry: official install layout discovered healthy; real-binary size floor enforced', async () => {
  const dir = await tmpDir();
  const exe = join(dir, 'BrowserOS.exe');
  await writeFile(exe, Buffer.alloc(1_200_000, 7)); // >1MB = plausible Chromium binary
  const found = discoverBrowsers(true, { roots: [exe] });
  const ours = mine([dir], found);
  assert.equal(ours.length, 1);
  assert.equal(ours[0]!.origin, 'install-local');
  assert.equal(ours[0]!.healthy, true);
  assert.equal(ours[0]!.id, 'browseros');
  // a suspiciously small file is DISCOVERED but flagged unhealthy (honest, not hidden)
  const stub = join(dir, 'stub.exe');
  await writeFile(stub, Buffer.alloc(100, 7));
  const found2 = discoverBrowsers(true, { roots: [stub] });
  const ours2 = mine([dir], found2).filter((b) => b.command === stub);
  assert.equal(ours2.length, 1);
  assert.equal(ours2[0]!.healthy, false);
  assert.match(ours2[0]!.unhealthyReason ?? '', /small/);
  // same exe via explicit config path -> origin 'config', no duplicate entries
  const found3 = discoverBrowsers(true, { roots: [exe], executablePath: exe });
  const ours3 = mine([dir], found3);
  assert.equal(ours3.length, 1);
  assert.equal(ours3[0]!.origin, 'config');
  await rm(dir, { recursive: true, force: true });
});

test('registry: nothing installed -> honest empty list (never auto-download)', async () => {
  const dir = await tmpDir();
  const found = discoverBrowsers(true, { roots: [join(dir, 'missing', 'BrowserOS.exe')] });
  assert.equal(mine([join(dir, 'missing')], found).length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('registry: detectRunning reads Local State ports and proves a listener, else reports absent', async () => {
  const dir = await tmpDir();
  const userData = join(dir, 'User Data');
  await mkdir(userData, { recursive: true });
  // ports 1/2 are never open locally -> deterministic "not running"
  await writeFile(join(userData, 'Local State'), JSON.stringify({ browseros: { server: { cdp_port: 1, proxy_port: 2 } } }));
  const r = await detectRunning(userData);
  assert.equal(r.running, false);
  // no Local State at all -> absent
  assert.equal((await detectRunning(join(dir, 'nowhere'))).running, false);
  await rm(dir, { recursive: true, force: true });
});
