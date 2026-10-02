import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpExpression, CdpActBridge } from '../cdp-act.ts';

test('cdp-act: navigate builds a location assignment, http(s) only', () => {
  const ok = cdpExpression({ id: 'n1', type: 'navigate', args: { url: 'https://example.com' } });
  assert.match(ok!, /document\.location\.href="https:\\?\/\\?\/example\.com"/);
  // javascript: / file: / missing url are refused before any socket opens
  assert.equal(cdpExpression({ id: 'n2', type: 'navigate', args: { url: 'javascript:alert(1)' } }), null);
  assert.equal(cdpExpression({ id: 'n3', type: 'navigate', args: {} }), null);
});

test('cdp-act: click and type-text build guarded IIFE expressions', () => {
  const click = cdpExpression({ id: 'c1', type: 'click', args: { selector: '#go' } });
  assert.match(click!, /querySelector\("#go"\)/);
  assert.match(click!, /E_NO_MATCH/);
  // the actionSpecs type for typing is `type-text`; legacy `type` also accepted
  const typed = cdpExpression({ id: 't1', type: 'type-text', args: { selector: 'input[name=q]', text: 'hmharness' } });
  assert.match(typed!, /el\.value="hmharness"/);
  assert.match(typed!, /dispatchEvent\(new Event\('input/);
  assert.equal(cdpExpression({ id: 't2', type: 'type', args: { text: 'x' } }), null); // selector required
  assert.equal(cdpExpression({ id: 't3', type: 'reload', args: {} }), null); // unknown type
});

test('cdp-act: bridge reports a dead endpoint honestly (no fake success)', async () => {
  // pin a port nothing listens on; up() and act() must both fail cleanly
  const bridge = new CdpActBridge({ cdpBase: 'http://127.0.0.1:1', timeoutMs: 500 });
  assert.equal(await bridge.up(), false);
  const r = await bridge.act({ id: 'a1', type: 'navigate', args: { url: 'https://example.com' } });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_NO_TABS');
});

test('cdp-act: bad action args are rejected before any connection', async () => {
  const bridge = new CdpActBridge({ cdpBase: 'http://127.0.0.1:1', timeoutMs: 500 });
  const r = await bridge.act({ id: 'a2', type: 'click', args: {} });
  assert.equal(r.outcome, 'failure');
  assert.equal(r.error?.code, 'E_BAD_ACTION');
});
