import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserActBridge, desktopActBridge } from '../bridges.ts';
import { BrowserEnvironment, DesktopEnvironment } from '../adapters.ts';

function fakeExecute(log: string[]) {
  return async (toolName: string, args: Record<string, unknown>) => {
    log.push(`${toolName}:${JSON.stringify(args)}`);
    if (toolName === 'desktop_click' && Number(args.x) < 0) return { output: 'click failed: off-screen', isError: true };
    return { output: `${toolName} ok` };
  };
}

test('bridges: browser actions dispatch to the real tools', async () => {
  const log: string[] = [];
  // pin a dead CDP port so the test stays hermetic even when the host's
  // automation Chrome happens to be running on :9222
  const env = new BrowserEnvironment({ cdpBase: 'http://127.0.0.1:1', act: browserActBridge(fakeExecute(log)) });
  await env.reset();
  const nav = await env.act({ id: 'n1', type: 'navigate', args: { url: 'https://example.com' } });
  // no CDP tabs reachable -> E_NO_TABS (bridge configured but browser down)
  assert.equal(nav.outcome, 'failure');
  assert.equal(nav.error?.code, 'E_NO_TABS');
});

test('bridges: browser bridge maps action types correctly (direct call)', async () => {
  const log: string[] = [];
  const bridge = browserActBridge(fakeExecute(log));
  const r = await bridge({ id: 'x', type: 'navigate', args: { url: 'https://hmh.dev' } }, 'tab-1');
  assert.equal(r.outcome, 'success');
  assert.deepEqual(log, ['browser_open:{"url":"https://hmh.dev"}']);
  const click = await bridge({ id: 'y', type: 'click', args: { x: 100, y: 200 } }, 'tab-1');
  assert.equal(click.outcome, 'success');
  assert.match(log[1], /desktop_click/);
});

test('bridges: desktop bridge maps click/type, rejects hotkey combos honestly', async () => {
  const log: string[] = [];
  const bridge = desktopActBridge(fakeExecute(log));
  const click = await bridge({ id: 'c', type: 'desktop-click', args: { x: 5, y: 5 } });
  assert.equal(click.outcome, 'success');
  const bad = await bridge({ id: 'b', type: 'desktop-click', args: { x: -1, y: 0 } });
  assert.equal(bad.outcome, 'failure');
  assert.equal(bad.error?.code, 'E_TOOL');
  const hotkey = await bridge({ id: 'h', type: 'desktop-hotkey', args: { combo: 'ctrl+s' } });
  assert.equal(hotkey.outcome, 'failure');
  assert.equal(hotkey.error?.code, 'E_UNSUPPORTED');
});

test('bridges: DesktopEnvironment with bridge executes actions end to end', async () => {
  const log: string[] = [];
  const env = new DesktopEnvironment({ act: desktopActBridge(fakeExecute(log)) });
  await env.reset();
  const r = await env.act({ id: 't1', type: 'desktop-type', args: { text: 'hello' } });
  assert.equal(r.outcome, 'success');
  assert.deepEqual(log, ['desktop_type:{"text":"hello"}']);
});
