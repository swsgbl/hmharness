import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetCodeWorldRecorder, pageReadSink } from '../code-wm-recorder.ts';
import { codeWorldModelPath } from '@hmharness/cognitive';

/** Chain contract (round 38): nativeRegistry's extension_page_read carries
 *  the onPageRead hook → the recorder feeds the sensor → a debounced flush
 *  lands durable RuntimeFacts under HMH_HOME. Tested against a REAL
 *  loopback bridge with a transport-identical extension stub. */

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-cwm-'));
}

async function connectStub(port: number, token: string, handle: (cmd: any) => unknown) {
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
          if (!block.includes('event: command')) continue;
          const dline = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dline) continue;
          const cmd = JSON.parse(dline.slice(5));
          const out = await Promise.resolve(handle(cmd)).catch((e: unknown) => ({ ok: false, error: String(e) }));
          void fetch(`http://127.0.0.1:${port}/v1/uplink`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ kind: 'result', id: cmd.id, ok: true, data: out }),
          });
        }
      }
    } catch { /* aborted */ }
  })();
  await fetch(`http://127.0.0.1:${port}/v1/uplink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: 'hello', protocol: 'hmext/1', extVersion: '0.0.0-test', browser: 'test-agent-chain' }),
  });
  return () => ac.abort();
}

const waitFor = async (fn: () => Promise<boolean>, ms = 6_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return await fn();
};

test('recorder: sink → sensor → debounced persistence (unit-level)', async () => {
  resetCodeWorldRecorder();
  const home = await tmpHome();
  try {
    const sink = pageReadSink(home);
    sink({ url: 'https://a.dev', title: 'A', selection: 'focus', headings: [], links: [], inputs: [], text: 'x' });
    sink({ url: 'https://b.dev', title: 'B', selection: '', headings: [], links: [], inputs: [], text: 'y' });
    const landed = await waitFor(async () => {
      try { return (await readFile(codeWorldModelPath(home), 'utf8')).includes('ext.page.read'); } catch { return false; }
    });
    assert.ok(landed, 'debounced flush must land the runtime facts');
    const file = JSON.parse(await readFile(codeWorldModelPath(home), 'utf8'));
    assert.equal(file.kind, 'hmharness-code-world');
    const kinds = file.runtime.map((f: { kind: string }) => f.kind);
    assert.deepEqual(kinds, ['ext.page.read', 'ext.page.selection', 'ext.page.read']);
  } finally {
    resetCodeWorldRecorder();
    await rm(home, { recursive: true, force: true });
  }
});

test('recorder: FULL CHAIN — registry tool read through a live bridge lands persisted facts', async () => {
  resetCodeWorldRecorder();
  const home = await tmpHome();
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  const { ExtensionBridgeServer } = await import('@hmharness/extension');
  const { issuePairingCode } = await import('@hmharness/extension');
  const bridge = new ExtensionBridgeServer({ home });
  let detach: () => void = () => undefined;
  try {
    const { port } = await bridge.start(0);
    // state file first: nativeRegistry's sync discovery must see connected
    const code = await issuePairingCode(home);
    const paired = await (await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.ok ? code.code : '' }) })).json() as { token: string };
    const page = { url: 'https://chain.dev', title: 'Chain', selection: '', headings: [], links: [], inputs: [], text: 'body' };
    detach = await connectStub(port, paired.token, (cmd) => (cmd.kind === 'page.read' ? page : { pong: true }));
    await new Promise((r) => setTimeout(r, 200));
    // refresh the state file's timestamp (the stub attach already flipped
    // connected via hello; make sure the sync read sees it fresh)
    const { readBridgeState } = await import('@hmharness/extension');
    assert.ok(readBridgeState(home)?.connected, 'stub extension must be connected');

    const { nativeRegistry } = await import('../runner.ts');
    const reg = nativeRegistry(0, { lsp: false, browser: false });
    const read = reg.get('extension_page_read');
    assert.ok(read, 'registry must carry extension_page_read when connected');
    const out = await read!.execute({}, { cwd: home, home });
    assert.equal(out.isError, undefined);
    assert.ok(out.output.includes('chain.dev'));

    const landed = await waitFor(async () => {
      try { return (await readFile(codeWorldModelPath(home), 'utf8')).includes('chain.dev'); } catch { return false; }
    });
    assert.ok(landed, 'the registry-driven read must land in the persisted Code World Model');
  } finally {
    detach();
    await bridge.stop();
    if (prevHome === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prevHome;
    resetCodeWorldRecorder();
    await rm(home, { recursive: true, force: true });
  }
});

test('recorder: corrupt persisted model does not break later observations', async () => {
  resetCodeWorldRecorder();
  const home = await tmpHome();
  try {
    await mkdir(join(home, 'cognitive'), { recursive: true });
    await writeFile(codeWorldModelPath(home), '{corrupt', 'utf8');
    pageReadSink(home)({ url: 'https://c.dev', title: 'C', selection: '', headings: [], links: [], inputs: [], text: '' });
    const landed = await waitFor(async () => {
      try { return (await readFile(codeWorldModelPath(home), 'utf8')).includes('c.dev'); } catch { return false; }
    });
    assert.ok(landed, 'fresh-model fallback keeps observations flowing');
  } finally {
    resetCodeWorldRecorder();
    await rm(home, { recursive: true, force: true });
  }
});
