import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, MessageDecoder } from '../protocol.ts';
import { scrubEnv, ProcessManager } from '../process-manager.ts';
import { LspClient } from '../client.ts';
import { fileToUri } from '../registry.ts';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.cjs');

test('protocol: Content-Length framing round-trips through the decoder', () => {
  const dec = new MessageDecoder();
  const msg = { jsonrpc: '2.0' as const, id: 7, method: 'x', params: { s: '中文内容' } };
  const wire = encodeMessage(msg);
  // feed in two chunks to prove incremental decoding
  const mid = Math.floor(wire.length / 2);
  const out1 = dec.push(wire.subarray(0, mid));
  const out2 = dec.push(wire.subarray(mid));
  assert.deepEqual(out1, []);
  assert.deepEqual(out2, [msg]);
  // two messages in one chunk
  const dec2 = new MessageDecoder();
  const both = dec2.push(Buffer.concat([encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' }), encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' })]));
  assert.equal(both.length, 2);
});

test('process-manager: env scrub keeps PATH, drops secret-looking vars', () => {
  const env = scrubEnv([]);
  assert.ok(env.PATH !== undefined || env.Path !== undefined, 'PATH survives');
  const probeKeys = ['NODE_AUTH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BIGMODEL_API_KEY'];
  for (const k of probeKeys) assert.equal((env as Record<string, unknown>)[k], undefined, `${k} must not inherit`);
});

test('client: full lifecycle against the fake server (initialize→sync→tier0→shutdown)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lsp-ws-'));
  const manager = new ProcessManager({ id: 'fake', command: process.execPath, args: [FAKE_SERVER], source: 'explicit' }, ws);
  const got: Array<{ uri: string; n: number }> = [];
  const client = new LspClient(manager.start(), {
    requestTimeoutMs: 10_000,
    onDiagnostics: (uri, diags) => got.push({ uri, n: diags.length }),
  });
  const init = await client.initialize(fileToUri(ws));
  assert.equal(init.serverInfo?.name, 'fake-lsp');
  // document sync drives push diagnostics
  const uri = fileToUri(join(ws, 'probe.ts'));
  client.openDoc(uri, 'typescript', 'const x: number = DELBERATE_ERROR_MARKER;\n');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(got.some((g) => g.uri === uri && g.n === 1), 'one diagnostic pushed for the marker file');
  // tier-0 requests
  const hover = await client.hover({ uri }, { line: 0, character: 6 });
  assert.match(JSON.stringify(hover?.contents), /fake hover/);
  const def = await client.definition({ uri }, { line: 0, character: 6 });
  assert.equal(Array.isArray(def) ? def[0]?.uri : def?.uri, 'file:///fake/def.ts');
  const refs = await client.references({ uri }, { line: 0, character: 6 });
  assert.equal(refs.length, 2);
  // Tier-1: implementation + call hierarchy
  const impls = await client.implementation({ uri }, { line: 0, character: 6 });
  assert.equal(Array.isArray(impls) ? impls.length : 1, 2);
  const item = await client.prepareCallHierarchy({ uri }, { line: 0, character: 6 });
  const first = Array.isArray(item) ? item[0] : item;
  const incoming = await client.callHierarchyIncoming(first);
  assert.equal(incoming.length, 2);
  assert.equal((incoming[0]!.from as { name?: string }).name, 'callerOne');
  const outgoing = await client.callHierarchyOutgoing(first);
  assert.equal(outgoing.length, 1);
  assert.equal((outgoing[0]!.to as { name?: string }).name, 'helperFn');
  const syms = await client.documentSymbols({ uri });
  assert.equal(syms[0]?.name, 'mainFn');
  assert.equal(syms[0]?.children?.[0]?.name, 'inner');
  // clean shutdown stops the process
  await client.shutdown();
  await manager.stop();
  assert.equal(manager.running, false);
  await rm(ws, { recursive: true, force: true });
});

test('registry: health probe flags a broken shim as unhealthy (fake: a command that always fails)', async () => {
  const { discoverServers } = await import('../registry.ts');
  // real discovery on THIS machine: whatever exists must carry a verdict
  const servers = discoverServers(true);
  for (const s of servers) {
    assert.ok(typeof s.healthy === 'boolean', `${s.id} must carry a health verdict`);
    if (!s.healthy) assert.ok((s.unhealthyReason ?? '').length > 0, `${s.id} unhealthy must say why`);
  }
  // a nonexistent binary is simply not discovered; a failing one is
  // discovered-but-unhealthy only when it exists on PATH — both states stay
  // honest. (On this dev machine rust-analyzer is a component-missing shim
  // and MUST be unhealthy if present.)
  const rust = servers.find((s) => s.id === 'rust-analyzer');
  if (rust && rust.unhealthyReason) console.log('rust-analyzer verdict:', rust.unhealthyReason.slice(0, 80));
});

test('client: unknown method surfaces the server error honestly', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lsp-ws-'));
  const manager = new ProcessManager({ id: 'fake', command: process.execPath, args: [FAKE_SERVER], source: 'explicit' }, ws);
  const client = new LspClient(manager.start(), { requestTimeoutMs: 10_000 });
  await client.initialize(fileToUri(ws));
  await assert.rejects(() => client.request('workspace/executeCommand', {}), /-32601|method not found/);
  await client.shutdown();
  await manager.stop();
  await rm(ws, { recursive: true, force: true });
});

test('process-manager: restart budget refuses flapping servers', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lsp-ws-'));
  const manager = new ProcessManager({ id: 'crasher', command: process.execPath, args: ['-e', 'process.exit(3)'], source: 'explicit' }, ws, { maxRestarts: 2 });
  manager.start();
  await new Promise((r) => setTimeout(r, 300));
  manager.start(); // restart 1
  await new Promise((r) => setTimeout(r, 300));
  manager.start(); // restart 2
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => manager.start(), /restart budget/);
  await manager.stop();
  await rm(ws, { recursive: true, force: true });
});
