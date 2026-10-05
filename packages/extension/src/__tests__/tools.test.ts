import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionBridgeServer } from '../bridge.ts';
import { discoverExtensionBridge, discoverExtensionBridgeSync } from '../registry.ts';
import { extensionTools } from '../tools.ts';
import type { BridgeCommand, RawPageData, TabInfo } from '../protocol.ts';

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ext-tools-'));
}

/** minimal fetch-stream extension stub (transport-identical to background.js) */
async function connectStub(port: number, token: string, handle: (cmd: BridgeCommand) => unknown) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
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
          let id = '';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: command')) id = '!';
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (id && data) {
            const cmd = JSON.parse(data) as BridgeCommand;
            const out = await Promise.resolve(handle(cmd)).catch((e: unknown) => ({ ok: false, error: String(e) }));
            void fetch(`http://127.0.0.1:${port}/v1/uplink`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ kind: 'result', id: cmd.id, ok: true, data: out }),
            });
          }
        }
      }
    } catch { /* aborted */ }
  })();
  await fetch(`http://127.0.0.1:${port}/v1/uplink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: 'hello', protocol: 'hmext/1', extVersion: '0.0.0-test', browser: 'test-firefox' }),
  });
  return () => ac.abort();
}

test('tools: no bridge -> honest errors on every tool + sync/async discovery agree', async () => {
  const home = await tmpHome();
  const sync = discoverExtensionBridgeSync(home);
  assert.equal(sync.healthy, false);
  assert.match(sync.unhealthyReason ?? '', /serve/);
  const asyncProbe = await discoverExtensionBridge(1); // port 1: never listening
  assert.equal(asyncProbe.healthy, false);
  const [status] = extensionTools({ home });
  const r = await status.execute({}, { cwd: home, home });
  assert.equal(r.isError, true);
  assert.match(r.output, /未运行/);
  await rm(home, { recursive: true, force: true });
});

test('tools: live bridge + connected extension — status/tabs/read full round-trip; page_act is ALWAYS gated', async () => {
  const home = await tmpHome();
  const bridge = new ExtensionBridgeServer({ home });
  let detach: () => void = () => undefined;
  try {
    const { port } = await bridge.start(0);
    const paired = await (await fetch(`http://127.0.0.1:${port}/v1/announce`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://toolstest' }, body: JSON.stringify({ extBaseUrl: 'chrome-extension://toolstest/popup.html' }) })).json() as { token: string };

    const tabs: TabInfo[] = [
      { id: 3, index: 0, title: 'hmharness docs', url: 'https://hmharness.dev/docs', active: true, windowId: 1 },
      { id: 4, index: 1, title: 'GitHub', url: 'https://github.com/swsgbl/hmharness', active: false, windowId: 1 },
    ];
    const page: RawPageData = {
      url: 'https://hmharness.dev/docs', title: 'Docs', selection: 'bridge',
      headings: [{ level: 1, text: 'Docs' }], links: [{ text: 'Home', href: 'https://hmharness.dev/' }],
      inputs: [], text: 'the extension bridge documentation',
    };
    detach = await connectStub(port, paired.token, (cmd) => {
      if (cmd.kind === 'tabs.list') return tabs;
      if (cmd.kind === 'page.read') return page;
      if (cmd.kind === 'page.act') return { ok: true, detail: 'clicked #go' };
      return { pong: true };
    });
    // let hello + state land
    await new Promise((r) => setTimeout(r, 150));
    const sync = discoverExtensionBridgeSync(home);
    assert.equal(sync.healthy, true);
    assert.equal(sync.connected, true);

    const tools = extensionTools({ home });
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    assert.equal(tools.length, 4);

    const st = await byName('extension_status').execute({}, { cwd: home, home });
    assert.equal(st.isError, undefined);
    assert.match(st.output, /运行中/);
    assert.match(st.output, /test-firefox/);

    const tb = await byName('extension_tabs').execute({}, { cwd: home, home });
    assert.match(tb.output, /2 个标签页/);
    assert.match(tb.output, /hmharness docs/);
    assert.match(tb.output, /\*活动\*/);

    const rd = await byName('extension_page_read').execute({}, { cwd: home, home });
    assert.match(rd.output, /Docs/);
    assert.match(rd.output, /the extension bridge documentation/);
    assert.match(rd.output, /用户选区.*bridge|\[用户选区\] bridge/);

    // page_act: gated EVERY call — no args shape can pre-clear it
    const act = byName('extension_page_act');
    assert.equal(act.needsApproval?.({}, { cwd: home, home }), true);
    assert.equal(act.needsApproval?.({ action: 'click', selector: '#go' }, { cwd: home, home }), true);
    const okAct = await act.execute({ action: 'click', selector: '#go' }, { cwd: home, home });
    assert.match(okAct.output, /clicked #go/);
    const badAct = await act.execute({ action: 'jump' }, { cwd: home, home });
    assert.equal(badAct.isError, true);
    const noSel = await act.execute({ action: 'click' }, { cwd: home, home });
    assert.match(noSel.output, /selector/);
  } finally {
    detach();
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('tools: onPageRead observation hook — fired with RAW data on success, silent on failure', async () => {
  const home = await tmpHome();
  const bridge = new ExtensionBridgeServer({ home });
  try {
    const { port } = await bridge.start(0);
    const paired = await (await fetch(`http://127.0.0.1:${port}/v1/announce`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://hooktest' }, body: JSON.stringify({ extBaseUrl: 'chrome-extension://hooktest/popup.html' }) })).json() as { token: string };
    const good: RawPageData = { url: 'https://ok.dev', title: 'OK', selection: '', headings: [], links: [], inputs: [], text: 'body' };
    let failNext = false;
    const detach = await connectStub(port, paired.token, (cmd) => {
      if (cmd.kind === 'page.read') {
        if (failNext) return Promise.reject(new Error('extension refused'));
        return good;
      }
      return { pong: true };
    });
    await new Promise((r) => setTimeout(r, 150));
    const seen: RawPageData[] = [];
    // a THROWING hook must never fail the tool (best-effort by contract)
    const tools = extensionTools({ home, onPageRead: (raw) => { seen.push(raw); throw new Error('hook boom'); } });
    const read = tools.find((t) => t.name === 'extension_page_read')!;
    const ok = await read.execute({}, { cwd: home, home });
    assert.equal(ok.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, 'https://ok.dev');
    // failed read: error surfaced, hook NOT called
    failNext = true;
    seen.length = 0;
    const bad = await read.execute({}, { cwd: home, home });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, 0);
    detach();
  } finally {
    await bridge.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('tools: bridge dies between registry build and tool call — execute fails honestly, not a hang', async () => {
  const home = await tmpHome();
  // forge a FRESH state file pointing at a port where nothing listens
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await writeFile(join(home, 'cognitive', 'extension-state.json'), JSON.stringify({
    kind: 'hmharness-extension-state', version: 1, port: 1, running: true, connected: true,
    updatedAt: new Date().toISOString(), agentSecret: 'b'.repeat(64),
  }), 'utf8');
  const tools = extensionTools({ home });
  const [status, , read] = tools;
  const r = await read.execute({}, { cwd: home, home });
  assert.equal(r.isError, true);
  assert.match(r.output, /失联|未运行/);
  // status REPORTS the dead bridge honestly — that's its job, not an error
  const s = await status.execute({}, { cwd: home, home });
  assert.notEqual(s.isError, true);
  assert.match(s.output, /失联/);
  await rm(home, { recursive: true, force: true });
});
