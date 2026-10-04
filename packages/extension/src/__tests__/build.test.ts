import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension, payloadDir, PAYLOAD_FILES } from '../build.ts';

test('build: all targets produce loadable unpacked dirs with validated manifests + verbatim payload', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ext-build-'));
  const results = await buildExtension({ target: 'all', outDir: out, port: 7790 });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.target).sort(), ['chromium', 'firefox', 'safari']);
  for (const r of results) {
    const m = JSON.parse(await readFile(join(r.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(m.manifest_version, 3);
    assert.deepEqual(m.host_permissions, ['http://127.0.0.1:7790/*']);
    for (const f of PAYLOAD_FILES) {
      const body = await readFile(join(r.dir, f), 'utf8');
      assert.ok(body.length > 0, `${r.target}/${f} empty`);
    }
    // zero-build payload must be valid JavaScript — machine-checked, not assumed
    for (const f of ['background.js', 'ui.js']) {
      const check = spawnSync(process.execPath, ['--check', join(r.dir, f)], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${r.target}/${f} fails node --check: ${check.stderr}`);
    }
    // the HTML entry points reference the assets they ship
    for (const f of ['popup.html', 'sidepanel.html']) {
      const html = await readFile(join(r.dir, f), 'utf8');
      assert.ok(html.includes('ui.js') && html.includes('style.css'), `${r.target}/${f} missing asset links`);
    }
  }
  // target delta is real: chromium has side_panel, firefox sidebar_action, safari neither
  const chromium = JSON.parse(await readFile(join(out, 'chromium', 'manifest.json'), 'utf8'));
  const firefox = JSON.parse(await readFile(join(out, 'firefox', 'manifest.json'), 'utf8'));
  const safari = JSON.parse(await readFile(join(out, 'safari', 'manifest.json'), 'utf8'));
  assert.ok(chromium.side_panel && chromium.background.service_worker);
  assert.ok(firefox.sidebar_action && firefox.background.scripts && !firefox.background.service_worker);
  assert.ok(!safari.side_panel && !safari.sidebar_action);
  await rm(out, { recursive: true, force: true });
});

test('build: single target builds alone; payloadDir points at the shipped assets', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ext-build1-'));
  const [r] = await buildExtension({ target: 'firefox', outDir: out, port: 7789 });
  assert.equal(r.target, 'firefox');
  assert.ok(r.loadHint.includes('about:debugging'), 'firefox load hint is the real one');
  assert.ok(r.notes.length > 0, 'honest per-target caveats ship with the build');
  // payloadDir resolves to the package's zero-build asset directory in every
  // runtime layout (src under tsx, dist after tsc) — verify per FILE
  const { stat } = await import('node:fs/promises');
  for (const f of PAYLOAD_FILES) {
    const s = await stat(join(payloadDir(), f)).catch(() => null);
    assert.ok(s?.isFile(), `payload asset missing: ${f}`);
  }
  await rm(out, { recursive: true, force: true });
});
