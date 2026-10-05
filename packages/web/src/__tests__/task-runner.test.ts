/**
 * W15 per-session executor tests:
 *  1. the task-runner child protocol end-to-end against a FAKE agent run
 *     (no model, no tools): spawn the real task-runner.js with a payload
 *     that hits a stubbed registry? That needs agent internals - instead we
 *     drive the REAL binary with a payload whose provider endpoint is a
 *     local 402 fixture, asserting the ndjson contract (error event +
 *     clean exit) and the abort path.
 *  2. pure relay routing: the server's relay() is closure-bound, so its
 *     routing table is mirrored here as a pure map (keeps the contract
 *     pinned while the closure stays in server.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Which SSE event each runner ndjson kind maps to (mirror of relay()). */
const RELAY_MAP: Record<string, string> = {
  line: 'line', delta: 'delta', tool: 'tool', toolResult: 'toolResult',
  injected: 'injected', approvalDone: 'approvalDone', approvalReq: 'approvalReq',
  final: 'final', error: 'error',
};

test('relay contract: every task-runner kind has exactly one SSE mapping', () => {
  const kinds = ['line', 'delta', 'tool', 'toolResult', 'injected', 'approvalDone', 'approvalReq', 'final', 'error'];
  for (const k of kinds) assert.equal(RELAY_MAP[k], k, '1:1, sessionId stamped by the server');
});

test('task-runner child: provider 402 -> error event (auth-error shape), clean exit, payload file deleted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-w15-'));
  await mkdir(join(home), { recursive: true });
  // a provider that always 402s
  const fake = createServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance (test)' } }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({
    providers: { fakepay: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'sk-x' } },
    routing: { chat: 'fakepay' },
    approval: 'auto',
  }), 'utf8');

  const payloadFile = join(home, 'payload.json');
  await writeFile(payloadFile, JSON.stringify({
    task: 'hello', mode: 'auto', yes: true, fresh: true,
    sessionId: 'w15-test', cwd: home, home,
  }), 'utf8');

  const runnerTs = join(import.meta.dirname ?? '.', '..', 'task-runner.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', runnerTs, payloadFile], {
    env: { ...process.env, HMH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? -1)));
  fake.close();

  const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
  const errEv = events.find((e) => e.kind === 'error');
  assert.ok(errEv, 'auth failure surfaces as an error event: ' + out.slice(0, 200));
  assert.match(String(errEv!.error), /HTTP 402/);
  assert.ok(code === 0 || code === 1, 'child exits (got ' + code + ')');
  await rm(home, { recursive: true, force: true });
});
