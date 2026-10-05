import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessManager, LspClient } from '@hmharness/lsp';
import { CodeWorldModel } from '@hmharness/cognitive';
import { LiveCodeWmSensor } from '../code-wm-live.ts';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'lsp', 'src', '__tests__', 'fixtures', 'fake-server.cjs');

test('live sensor: openDoc→symbols→model over the fake server (hermetic)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'live-cwm-'));
  const manager = new ProcessManager({ id: 'fake', command: process.execPath, args: [FAKE_SERVER], source: 'explicit' }, ws);
  const client = new LspClient(manager.start(), { requestTimeoutMs: 10_000 });
  await client.initialize(`file:///${ws.replace(/\\/g, '/')}`);
  const cwm = new CodeWorldModel();
  const sensor = new LiveCodeWmSensor(client, cwm, { workspaceRoot: ws });
  // the fake server answers documentSymbol with mainFn (kind 12=function)
  const r = await sensor.syncFile(join(ws, 'probe.ts'), 'function mainFn() {}\n');
  assert.equal(r.entitiesIngested, 2, 'mainFn + its child inner');
  assert.equal(r.relationsIngested, 1, 'defines edge');
  assert.equal(cwm.entityCount, 2);
  // entity ids are `${uri}#${name}` — the uri here came from the sensor's fileToUri
  const ids = [...cwm.entityCount ? [] : []];
  void ids;
  const probeUri = `file:///${ws.replace(/\\/g, '/')}/probe.ts`;
  assert.ok(cwm.entity(`${probeUri}#mainFn`), 'entity keyed by uri#name (sensor fileToUri form)');
  // pullDiagnostics reflects model state (empty here — the fake pushes only on marker text)
  assert.deepEqual(sensor.pullDiagnostics(`file:///${ws.replace(/\\/g, '/')}/probe.ts`), []);
  assert.equal(sensor.stats.tracked, 1);
  await client.shutdown();
  await manager.stop();
  assert.equal(manager.running, false);
  await rm(ws, { recursive: true, force: true });
});
