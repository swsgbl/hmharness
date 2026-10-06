import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionBridgeServer } from '@hmharness/extension';

/** deterministic HMH_HOME so pid-file helpers never touch the real one */
function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> | T {
  const home = mkdtempSync(join(tmpdir(), 'hmh-ext-daemon-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev !== undefined) process.env.HMH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

test('probe: recognizes OUR bridge by protocol, not by port occupancy', async () => {
  const { probeExtensionDaemon } = await import('../extension-daemon.ts');
  await withTempHome(async () => {
    // a bare socket that is NOT the bridge must read as down
    const notOurs = await probeExtensionDaemon(7788);
    assert.equal(notOurs.up, false);
    // the real thing answers /v1/status with ok:true + protocol hmext/1
    const bridge = new ExtensionBridgeServer({ home: process.env.HMH_HOME! });
    const { port } = await bridge.start(0);
    const up = await probeExtensionDaemon(port);
    assert.equal(up.up, true);
    await bridge.stop();
    const down = await probeExtensionDaemon(port);
    assert.equal(down.up, false);
  });
});

test('pid file: read back what was written; garbage and absence read as 0', async () => {
  await withTempHome(async (home) => {
    const { readExtensionPid } = await import('../extension-daemon.ts');
    assert.equal(readExtensionPid(), 0, 'no file → 0');
    writeFileSync(join(home, 'extension.pid'), '4242');
    assert.equal(readExtensionPid(), 4242);
    writeFileSync(join(home, 'extension.pid'), 'not-a-pid');
    assert.equal(readExtensionPid(), 0, 'garbage → 0');
  });
});

test('stop: removes the pid file and reports nothing killed when idle', async () => {
  await withTempHome(async (home) => {
    const { stopExtensionDaemon, readExtensionPid } = await import('../extension-daemon.ts');
    writeFileSync(join(home, 'extension.pid'), '999999999'); // not alive
    const killed = stopExtensionDaemon(0); // port 0: no netstat match possible
    assert.equal(killed, false);
    assert.equal(readExtensionPid(), 0, 'pid file cleaned even when the pid was dead');
  });
});
