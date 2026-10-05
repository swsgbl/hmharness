import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { ExtensionBridgeServer, readBridgeState, stateFilePath, DEFAULT_BRIDGE_PORT, bridgePort } from '../bridge.ts';
import { issuePairingCode } from '../token.ts';
import type { BridgeCommand, TabInfo } from '../protocol.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ext-bridge-'));
}

/**
 * The test-side extension speaks EXACTLY the transport the real
 * background.js speaks: a fetch-stream SSE reader (service workers have
 * no EventSource) + POST uplink. Protocol-level e2e, no browser needed.
 */
async function attachFakeExtension(port: number, token: string, opts: { hello?: boolean } = {}) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  if (res.status !== 200) throw new Error(`attach failed HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const queue: Array<{ event: string; data: unknown }> = [];
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (data) queue.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  const uplink = async (msg: unknown): Promise<void> => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/uplink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(msg),
    });
    assert.equal(r.status, 200, `uplink ${JSON.stringify(msg).slice(0, 60)} failed`);
  };
  const next = async (event: string, timeoutMs = 4_000): Promise<{ event: string; data: any }> => {
    const start = Date.now();
    for (;;) {
      const i = queue.findIndex((b) => b.event === event);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for SSE event '${event}'`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const answerCommands = (handle: (cmd: BridgeCommand) => unknown | Promise<unknown>): void => {
    void (async () => {
      for (;;) {
        try {
          const got = await next('command', 10_000).catch(() => null);
          if (!got) return;
          const cmd = got.data as BridgeCommand;
          try {
            await uplink({ kind: 'result', id: cmd.id, ok: true, data: await handle(cmd) });
          } catch (err) {
            await uplink({ kind: 'result', id: cmd.id, ok: false, error: String(err) });
          }
        } catch { return /* reader closed */ }
      }
    })();
  };
  let pingDrainRunning = true;
  // the bridge heartbeats a REQUIRED-answer ping every 5s (round 40) —
  // drain those continuously so manual scenarios only ever see real commands
  void (async () => {
    while (pingDrainRunning) {
      const i = queue.findIndex((b) => b.event === 'command' && (b.data as BridgeCommand)?.kind === 'ping');
      if (i >= 0) {
        const ping = queue.splice(i, 1)[0]!.data as BridgeCommand;
        await uplink({ kind: 'result', id: ping.id, ok: true, data: { pong: true } }).catch(() => undefined);
        continue;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  if (opts.hello !== false) {
    await uplink({ kind: 'hello', protocol: 'hmext/1', extVersion: '0.0.0-test', browser: 'test-chromium' });
  }
  return { next, uplink, answerCommands, close: () => { pingDrainRunning = false; ac.abort(); } };
}

/** raw HTTP request with header control fetch() forbids (Host/Origin attacks) */
function rawRequest(port: number, path: string, headers: Record<string, string>, method: 'GET' | 'POST' = 'GET', body = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('bridge: e2e — pair over HTTP, attach via fetch-stream SSE, round-trip commands', async () => {
  const home = await tmpHome();
  const bridge = new ExtensionBridgeServer({ home });
  try {
    const { port } = await bridge.start(0);
    assert.ok(port > 0);
    // default port constant + env override sanity
    assert.equal(DEFAULT_BRIDGE_PORT, 7789);
    process.env.HMH_EXTENSION_PORT = '7799';
    assert.equal(bridgePort(), 7799);
    delete process.env.HMH_EXTENSION_PORT;
    assert.equal(bridgePort(), 7789);

    // status before pairing: liveness without secrets
    const st0 = await (await fetch(`http://127.0.0.1:${port}/v1/status`)).json();
    assert.equal(st0.ok, true);
    assert.equal(st0.paired, false);
    assert.equal(st0.connected, false);

    // wrong code refused over HTTP (403, not 500)
    const bad = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WRONGWRONG' }) });
    assert.equal(bad.status, 403);

    // real pair: code from the CLI path -> HTTP redeem -> bearer token
    const issued = await issuePairingCode(home);
    assert.equal(issued.ok, true);
    const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.ok ? issued.code : '' }) });
    const pj = await paired.json() as { ok: boolean; token?: string };
    assert.equal(paired.status, 200);
    assert.equal(pj.ok, true);
    const token = pj.token!;
    // single use: replaying the code is refused
    const replay = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.ok ? issued.code : '' }) });
    assert.equal(replay.status, 403);

    // events without a token: 401, no stream
    const unauth = await fetch(`http://127.0.0.1:${port}/v1/events`);
    assert.equal(unauth.status, 401);

    // attach — the FIRST SSE block is the hello ack with the protocol version
    const ext = await attachFakeExtension(port, token);
    const hello = await ext.next('hello');
    assert.equal(hello.data.protocol, 'hmext/1');

    // bridge status now shows a connected extension with the hello's facts
    const st1 = await (await fetch(`http://127.0.0.1:${port}/v1/status`)).json();
    assert.equal(st1.connected, true);
    assert.equal(st1.browser, 'test-chromium');
    assert.equal(st1.paired, true);

    // state file (the agent's sync discovery source) agrees
    const stateFile = readBridgeState(home);
    assert.ok(stateFile, 'state file written');
    assert.equal(stateFile!.connected, true);
    assert.equal(stateFile!.port, port);
    assert.match(stateFile!.agentSecret!, /^[0-9a-f]{64}$/);

    // ---- manual command scenarios FIRST (single consumer of the SSE queue) ----
    // error result rejects the pending command with the extension's message
    const failing = bridge.command('page.act' as never, { act: { action: 'click', selector: '#nope' } }).then(
      () => 'resolved (unexpected)',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
    const cmd = await ext.next('command');
    assert.equal((cmd.data as BridgeCommand).kind, 'page.act');
    await ext.uplink({ kind: 'result', id: (cmd.data as BridgeCommand).id, ok: false, error: 'selector 未命中: #nope' });
    assert.match(await failing, /未命中/);

    // timeout path: a command nobody answers rejects honestly
    const slow = bridge.command('page.read', { timeoutMs: 300 }).then(
      () => 'resolved (unexpected)',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
    await ext.next('command'); // (received, never answered)
    assert.match(await slow, /timed out/);

    // ---- then the auto-answer loop takes over the queue ----
    const fakeTabs: TabInfo[] = [{ id: 7, index: 0, title: 'Docs', url: 'https://example.com/docs', active: true, windowId: 1 }];
    ext.answerCommands((cmd2) => {
      if (cmd2.kind === 'tabs.list') return fakeTabs;
      if (cmd2.kind === 'ping') return { pong: true };
      throw new Error('unexpected ' + cmd2.kind);
    });
    assert.deepEqual(await bridge.command('tabs.list'), fakeTabs);
    const ping = (await bridge.command('ping')) as { pong: boolean };
    assert.equal(ping.pong, true);

    ext.close();
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
  // graceful stop removes the state file — sync discovery flips to absent
  assert.equal(readBridgeState(home), null);
});

test('bridge: agent channel — state-file secret gates /v1/agent/command; no-extension is an honest 502', async () => {
  const home = await tmpHome();
  const bridge = new ExtensionBridgeServer({ home });
  try {
    const { port } = await bridge.start(0);
    const state = readBridgeState(home)!;
    const secret = state.agentSecret;

    // wrong secret: 401
    const wrong = await fetch(`http://127.0.0.1:${port}/v1/agent/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + '0'.repeat(64) }, body: JSON.stringify({ kind: 'tabs.list' }) });
    assert.equal(wrong.status, 401);

    // right secret but NO extension connected: 502 with the actionable reason
    const none = await fetch(`http://127.0.0.1:${port}/v1/agent/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ kind: 'tabs.list' }) });
    assert.equal(none.status, 502);
    const nj = await none.json() as { error?: string };
    assert.match(nj.error ?? '', /没有已连接的浏览器扩展/);

    // pair + connect, then the agent channel works end-to-end
    const issued = await issuePairingCode(home);
    const paired = await (await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.ok ? issued.code : '' }) })).json() as { token: string };
    const ext = await attachFakeExtension(port, paired.token);
    await ext.next('hello');
    ext.answerCommands((cmd) => (cmd.kind === 'tabs.list' ? [{ id: 1, index: 0, title: 'A', url: 'https://a.dev', active: true, windowId: 1 }] : { pong: true }));
    const ok = await fetch(`http://127.0.0.1:${port}/v1/agent/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ kind: 'tabs.list' }) });
    assert.equal(ok.status, 200);
    const oj = await ok.json() as { ok: boolean; data: TabInfo[] };
    assert.equal(oj.data[0]!.title, 'A');

    ext.close();
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('bridge: host-header and foreign-origin requests are refused (DNS-rebinding posture)', async () => {
  const home = await tmpHome();
  const bridge = new ExtensionBridgeServer({ home });
  try {
    const { port } = await bridge.start(0);
    // forged Host (rebinding style): refused before routing
    const evilHost = await rawRequest(port, '/v1/status', { host: 'evil.example.com' });
    assert.equal(evilHost.status, 403);
    assert.match(evilHost.body, /refused Host/);
    // foreign Origin on pair: refused at the origin guard — code NOT spent
    const evilOrigin = await rawRequest(port, '/v1/pair', { origin: 'https://evil.example.com', 'content-type': 'application/json' }, 'POST', JSON.stringify({ code: 'TESTTEST' }));
    assert.equal(evilOrigin.status, 403);
    assert.match(evilOrigin.body, /refused Origin/);
    // extension origin is WELCOMED on pair: reaches the handler (wrong code
    // -> pairing error, not an origin block)
    const extOrigin = await rawRequest(port, '/v1/pair', { origin: 'chrome-extension://abcdef', 'content-type': 'application/json' }, 'POST', JSON.stringify({ code: 'TESTTEST' }));
    assert.equal(extOrigin.status, 403);
    assert.match(extOrigin.body, /配对码/);
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('bridge: a stale state file reads as NOT running (bridge killed without cleanup)', async () => {
  const home = await tmpHome();
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(home, 'cognitive'), { recursive: true });
  // a state file that claims running=true but is 10 minutes old
  await writeFile(stateFilePath(home), JSON.stringify({
    kind: 'hmharness-extension-state', version: 1, port: 7789, running: true, connected: true,
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), agentSecret: 'a'.repeat(64),
  }), 'utf8');
  assert.equal(readBridgeState(home), null, 'stale state must not count as a live bridge');
  // corrupt/absent files likewise
  await writeFile(stateFilePath(home), '{oops', 'utf8');
  assert.equal(readBridgeState(home), null);
  await rm(home, { recursive: true, force: true });
});
