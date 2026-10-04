import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeRegistry } from '../runner.ts';

/** Wiring contract for the extension_* family (2026-10-04):
 *  registration follows the dead-tools rule via the bridge STATE FILE —
 *  no bridge / bridge-without-extension machines never see the tools,
 *  a connected one gets exactly the four, and opts.extension=false opts
 *  out even when connected. */

test('runner: extension_* tools appear ONLY when the bridge state file says an extension is connected', async () => {
  const prevHome = process.env.HMH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'agent-ext-'));
  process.env.HMH_HOME = home;
  try {
    const names = (reg: ReturnType<typeof nativeRegistry>) => reg.names().filter((n) => n.startsWith('extension_'));
    // 1. no bridge at all -> no extension tools (dead-tools rule)
    assert.deepEqual(names(nativeRegistry(0, { lsp: false, browser: false })), []);
    // 2. fresh state file claiming connected -> exactly the four tools
    await mkdir(join(home, 'cognitive'), { recursive: true });
    await writeFile(join(home, 'cognitive', 'extension-state.json'), JSON.stringify({
      kind: 'hmharness-extension-state', version: 1, port: 7789, running: true, connected: true,
      browser: 'chromium', updatedAt: new Date().toISOString(), agentSecret: 'c'.repeat(64),
    }), 'utf8');
    assert.deepEqual(names(nativeRegistry(0, { lsp: false, browser: false })).sort(), [
      'extension_page_act', 'extension_page_read', 'extension_status', 'extension_tabs',
    ]);
    // 3. bridge running but extension NOT connected -> still no dead tools
    await writeFile(join(home, 'cognitive', 'extension-state.json'), JSON.stringify({
      kind: 'hmharness-extension-state', version: 1, port: 7789, running: true, connected: false,
      updatedAt: new Date().toISOString(), agentSecret: 'c'.repeat(64),
    }), 'utf8');
    assert.deepEqual(names(nativeRegistry(0, { lsp: false, browser: false })), []);
    // 4. explicit opt-out even when connected
    await writeFile(join(home, 'cognitive', 'extension-state.json'), JSON.stringify({
      kind: 'hmharness-extension-state', version: 1, port: 7789, running: true, connected: true,
      updatedAt: new Date().toISOString(), agentSecret: 'c'.repeat(64),
    }), 'utf8');
    assert.deepEqual(names(nativeRegistry(0, { lsp: false, browser: false, extension: false })), []);
  } finally {
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
