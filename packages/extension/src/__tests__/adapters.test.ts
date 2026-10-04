import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_TARGETS, GECKO_ID, manifestFor, validateManifest } from '../adapters.ts';

test('adapters: chromium manifest — MV3 service worker + side panel + chrome floor', () => {
  const m = manifestFor('chromium', { port: 7789 }) as Record<string, any>;
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.service_worker, 'background.js');
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  assert.equal(m.action.default_popup, 'popup.html');
  assert.equal(m.minimum_chrome_version, '116');
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1:7789/*']);
  assert.ok(m.permissions.includes('scripting'));
  assert.ok(m.permissions.includes('activeTab'));
  assert.deepEqual(validateManifest('chromium', m), []);
});

test('adapters: firefox manifest — event-page scripts (NO service worker), sidebar_action, gecko id', () => {
  const m = manifestFor('firefox', { port: 7789 }) as Record<string, any>;
  assert.deepEqual(m.background.scripts, ['background.js']);
  assert.equal(m.background.service_worker, undefined, 'Firefox deliberately does not support SW backgrounds');
  assert.equal(m.sidebar_action.default_panel, 'sidepanel.html');
  assert.equal(m.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(m.browser_specific_settings.gecko.strict_min_version, '121');
  assert.equal(m.side_panel, undefined);
  assert.deepEqual(validateManifest('firefox', m), []);
});

test('adapters: safari manifest — popup-only surface, no side panel keys', () => {
  const m = manifestFor('safari', { port: 7789 }) as Record<string, any>;
  assert.equal(m.side_panel, undefined, 'Safari has no side panel API');
  assert.equal(m.sidebar_action, undefined);
  assert.equal(m.action.default_popup, 'popup.html');
  assert.deepEqual(validateManifest('safari', m), []);
});

test('adapters: port injection — the manifest points at the bridge it will talk to', () => {
  for (const t of EXTENSION_TARGETS) {
    const m = manifestFor(t, { port: 7799 }) as Record<string, any>;
    assert.deepEqual(m.host_permissions, ['http://127.0.0.1:7799/*']);
  }
});

test('adapters: anti-theater — cross-target violations FAIL validation in BOTH directions', () => {
  const chromium = manifestFor('chromium', { port: 7789 });
  const firefox = manifestFor('firefox', { port: 7789 });
  // a chromium manifest judged as firefox: service_worker present, scripts absent
  const asFf = validateManifest('firefox', chromium);
  assert.ok(asFf.some((p) => /service_worker/.test(p)));
  assert.ok(asFf.some((p) => /background.scripts/.test(p)));
  assert.ok(asFf.some((p) => /gecko.id/.test(p)));
  // a firefox manifest judged as chromium: no service_worker, no side_panel
  const asCr = validateManifest('chromium', firefox);
  assert.ok(asCr.some((p) => /service_worker/.test(p)));
  assert.ok(asCr.some((p) => /side_panel/.test(p)));
  // loopback host permission is mandatory for every target
  const noHost = validateManifest('chromium', { ...chromium, host_permissions: [] });
  assert.ok(noHost.some((p) => /127\.0\.0\.1/.test(p)));
});
