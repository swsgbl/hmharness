import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpBrowser, discoverBrowsers } from '@hmharness/browser';
import { buildExtension } from '../build.ts';
import { ExtensionBridgeServer } from '../bridge.ts';
import { issuePairingCode } from '../token.ts';
import { extensionTools } from '../tools.ts';

/**
 * REAL-BROWSER e2e (the honest-label upgrade): the built extension is
 * LOADED into a real Chromium-family browser (--load-extension), its popup
 * pair form is driven over CDP, and the REAL background.js pairs over
 * HTTP, attaches its fetch-stream SSE downlink and answers agent commands.
 * Skips when no browser binary exists or the bridge port is busy — the
 * protocol-level e2e in bridge.test.ts covers the transport without a
 * browser; THIS test proves the payload itself loads and runs.
 */

const PORT = 7789; // the port baked into host_permissions at build time

function findBrowserBinary(): string | null {
  const bo = discoverBrowsers(true).find((b) => b.healthy);
  if (bo) return bo.command;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(500) });
    return false; // something answers — do not collide
  } catch {
    return true;
  }
}

const killTree = (pid: number): void => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
};

test('real browser: extension loads, pairs via popup, serves agent tools', { timeout: 120_000 }, async (t) => {
  const exe = findBrowserBinary();
  if (!exe) return t.skip('no Chromium-family binary on this machine (BrowserOS/Edge/Chrome)');
  if (!(await portFree(PORT))) return t.skip(`port ${PORT} busy — a bridge is already running`);

  const home = mkdtempSync(join(tmpdir(), 'ext-real-'));
  const profile = mkdtempSync(join(tmpdir(), 'ext-real-profile-'));
  const outDir = mkdtempSync(join(tmpdir(), 'ext-real-build-'));
  const bridge = new ExtensionBridgeServer({ home });
  let proc: ChildProcess | null = null;
  let cdp: InstanceType<typeof CdpBrowser> | null = null;
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    // self-contained: build the chromium payload FOR THIS PORT into tmp
    const [built] = await buildExtension({ target: 'chromium', outDir, port: PORT });
    assert.ok(built, 'chromium build produced a dir');

    await bridge.start(PORT);
    const issued = await issuePairingCode(home);
    assert.equal(issued.ok, true);

    proc = spawn(exe, [
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check',
      `--disable-extensions-except=${built.dir}`,
      `--load-extension=${built.dir}`,
      // port 0 = Chromium picks a free one; the ACTUAL port lands in
      // <profile>/DevToolsActivePort — no collisions with user CDP usage
      '--remote-debugging-port=0',
      '--headless=new',
      'about:blank',
    ], { stdio: 'ignore', detached: process.platform !== 'win32' });

    let CDP_PORT = 0;
    for (let i = 0; i < 40 && !CDP_PORT; i++) {
      await sleep(500);
      try {
        const txt = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim();
        CDP_PORT = Number(txt.split(/\r?\n/)[0]);
      } catch { /* browser still booting */ }
    }
    assert.ok(CDP_PORT > 0, 'DevToolsActivePort never appeared');

    // 1. find OUR SW among the extension targets (BrowserOS ships builtins)
    cdp = new CdpBrowser({ port: CDP_PORT });
    let extId: string | null = null;
    for (let i = 0; i < 40 && !extId; i++) {
      await sleep(500);
      try {
        if (!(await cdp.up())) continue;
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as Array<{ url: string; id: string }>;
        for (const sw of list.filter((x) => x.url.startsWith('chrome-extension://') && x.url.includes('background.js'))) {
          const name = await cdp.evaluate(sw.id, 'chrome.runtime.getManifest().name').catch(() => null);
          if (String(name).includes('hmharness')) { extId = new URL(sw.url).host; break; }
        }
      } catch { /* boot race */ }
    }
    assert.ok(extId, 'hmharness service worker never appeared on CDP');

    // 2. drive the popup's pair form over CDP (what a user does by hand)
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const tabId = await cdp.openTab(popupUrl);
    let clicked = false;
    for (let i = 0; i < 30 && !clicked; i++) {
      await sleep(500);
      const r = await cdp.evaluate(tabId, `(() => {
        const p = document.getElementById('port'), c = document.getElementById('code'), b = document.getElementById('pair');
        if (!p || !c || !b) return false;
        p.value = '${PORT}'; c.value = '${issued.ok ? issued.code : ''}'; b.click(); return true;
      })()`).catch(() => null);
      clicked = r === true;
    }
    assert.ok(clicked, 'popup DOM never became interactive');

    // 3. the REAL background.js attached: bridge status flips connected
    let connected = false;
    for (let i = 0; i < 30 && !connected; i++) {
      await sleep(500);
      const st = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
      connected = Boolean(st.connected);
    }
    assert.ok(connected, 'extension never connected to the bridge');

    // 4. agent tools against the REAL browser
    const ctx = { cwd: home, home };
    const tools = extensionTools({ home });
    const byName = (n: string) => tools.find((x) => x.name === n)!;

    const tabs = await byName('extension_tabs').execute({}, ctx);
    assert.equal(tabs.isError, undefined);
    assert.ok(tabs.output.includes(extId), 'real tabs include the popup tab');

    // read a plain http page (within host_permissions; the browser REFUSES
    // scripting on chrome-extension:// pages by design — surfaced honestly)
    const plain = (await cdp.tabs()).find((x) => x.url === 'about:blank');
    const readTab = plain?.targetId ?? (await cdp.openTab('about:blank'));
    await cdp.navigate(readTab, `http://127.0.0.1:${PORT}/v1/status`);
    await cdp.activateTab(readTab).catch(() => undefined);
    await sleep(1_000);
    const read = await byName('extension_page_read').execute({}, ctx);
    assert.equal(read.isError, undefined);
    assert.ok(read.output.includes('hmext/1'), 'page read carried the status payload');

    const act = await byName('extension_page_act').execute({ action: 'scroll', direction: 'top' }, ctx);
    assert.equal(act.isError, undefined);
    assert.ok(act.output.includes('scrolled'));
  } finally {
    if (proc?.pid) killTree(proc.pid);
    await cdp?.close().catch(() => undefined); // the CDP WebSocket must not hold the runner open
    await bridge.stop().catch(() => undefined);
    if (prevHome === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prevHome;
    await sleep(1_000);
    for (const d of [home, profile, outDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* .browseros lock — tmp dir, OS reaps */ }
    }
  }
});
