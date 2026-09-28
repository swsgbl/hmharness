import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentRegistry } from '@hmharness/cognitive';
import { TerminalEnvironment } from '../terminal.ts';
import { HarmonyOsEnvironment } from '../harmonyos.ts';
import { BrowserEnvironment, DesktopEnvironment } from '../adapters.ts';

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'termenv-'));
}

test('terminal: conformance passes the shared contract test', async () => {
  const ws = await tmpWs();
  const reg = new EnvironmentRegistry();
  const result = await reg.conformance(new TerminalEnvironment({ workspaceDir: ws }));
  assert.deepEqual(result, { pass: true, failures: [] });
  await rm(ws, { recursive: true, force: true });
});

test('terminal: observe lists workspace files; act writes and runs commands', async () => {
  const ws = await tmpWs();
  const env = new TerminalEnvironment({ workspaceDir: ws });
  const obs = await env.reset();
  const files = (obs.state as { files: Array<{ path: string }> }).files;
  assert.equal(files.length, 0); // fresh workspace
  const wr = await env.act({ id: 'w1', type: 'writeFile', args: { path: 'hello.txt', content: 'hi hmh' }, reason: 'seed a file' });
  assert.equal(wr.outcome, 'success');
  const obs2 = await env.observe();
  assert.equal((obs2.state as { files: Array<{ path: string }> }).files.length, 1);
  const cmd = await env.act({ id: 'c1', type: 'command', args: { cmd: 'type hello.txt' }, reason: 'read it back' });
  assert.equal(cmd.outcome, 'success');
  assert.match(JSON.stringify(cmd.output), /hi hmh/);
  await rm(ws, { recursive: true, force: true });
});

test('terminal: path escape is rejected (workspace-only filesystem)', async () => {
  const ws = await tmpWs();
  const env = new TerminalEnvironment({ workspaceDir: ws });
  await env.reset();
  const r = await env.act({ id: 'e1', type: 'writeFile', args: { path: '../outside.txt', content: 'x' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_SCOPE');
  await rm(ws, { recursive: true, force: true });
});

test('terminal: destructive command patterns are denied', async () => {
  const ws = await tmpWs();
  const env = new TerminalEnvironment({ workspaceDir: ws });
  await env.reset();
  const r = await env.act({ id: 'd1', type: 'command', args: { cmd: 'del /f /q C:\\Windows\\System32' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_UNSAFE');
  await rm(ws, { recursive: true, force: true });
});

test('terminal: snapshot restore reports (does not fake) resurrecting deleted files', async () => {
  const ws = await tmpWs();
  const env = new TerminalEnvironment({ workspaceDir: ws });
  await env.reset();
  await env.act({ id: 'w', type: 'writeFile', args: { path: 'gone.txt', content: 'x' } });
  const snap = await env.snapshot();
  await env.act({ id: 'd', type: 'deleteFile', args: { path: 'gone.txt' } });
  await env.restore(snap);
  const obs = await env.observe();
  const outputs = (obs.state as { recentOutputs: string[] }).recentOutputs.join('\n');
  assert.match(outputs, /cannot be restored/);
  await rm(ws, { recursive: true, force: true });
});

test('harmonyos: conformance passes with no device attached (honest degraded state)', async () => {
  const reg = new EnvironmentRegistry();
  const result = await reg.conformance(new HarmonyOsEnvironment({ hdc: 'definitely-not-hdc' }));
  assert.deepEqual(result, { pass: true, failures: [] });
});

test('harmonyos: act reports E_NO_DEVICE without a device', async () => {
  const env = new HarmonyOsEnvironment({ hdc: 'definitely-not-hdc' });
  const r = await env.act({ id: 's', type: 'hdc-shell', args: { cmd: 'ls' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_NO_DEVICE');
});

test('browser: observe degrades gracefully without CDP; act refuses without bridge', async () => {
  const env = new BrowserEnvironment({ cdpBase: 'http://127.0.0.1:1' }); // nothing listens here
  const obs = await env.reset();
  assert.equal((obs.state as { tabs: unknown[] }).tabs.length, 0);
  const r = await env.act({ id: 'n', type: 'navigate', args: { url: 'https://example.com' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_NO_CDP_BRIDGE');
});

test('browser: capabilities declare the act-bridge limitation honestly', async () => {
  const env = new BrowserEnvironment();
  const caps = await env.capabilities();
  const act = caps.find((c) => c.kind === 'act');
  assert.ok(act?.limitation, 'unconfigured act bridge must be declared as limitation');
});

test('desktop: observe enumerates windows; act refuses without bridge', async () => {
  const env = new DesktopEnvironment();
  const obs = await env.reset();
  assert.ok(Array.isArray((obs.state as { windows: unknown[] }).windows));
  const r = await env.act({ id: 'k', type: 'desktop-hotkey', args: { combo: 'ctrl+s' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_NO_AUTOMATION_BRIDGE');
});
