import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { CdpBrowser, discoverBrowsers } from '@hmharness/browser';
import { buildExtension } from '../build.ts';
import { ExtensionBridgeServer } from '../bridge.ts';
import { issuePairingCode, unpair } from '../token.ts';
import { extensionTools } from '../tools.ts';

/**
 * REAL-BROWSER e2e (the honest-label upgrade): the built extension is
 * LOADED — installed unpacked — into EVERY Chromium-family browser found
 * on this machine (BrowserOS, Google Chrome, Microsoft Edge; one subtest
 * each), its popup pair form is driven over CDP, and the REAL
 * background.js pairs over HTTP, attaches its fetch-stream SSE downlink
 * and answers agent commands. Skips when no browser exists or the bridge
 * port is busy — the protocol-level e2e in bridge.test.ts covers the
 * transport without a browser; THIS test proves the payload itself
 * installs and runs, per browser.
 */

const PORT = 7789; // the port baked into host_permissions at build time

function findBrowserBinaries(): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  const bo = discoverBrowsers(true).find((b) => b.healthy);
  if (bo) out.push({ name: 'browseros', command: bo.command });
  const la = process.env.LOCALAPPDATA ?? '';
  const pf = process.env.ProgramFiles ?? '';
  const candidates: Array<[string, string]> = [
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    // chromium-family peers (round 41): Brave / Opera / Quark install roots
    ['brave', join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['opera', join(la, 'Programs', 'Opera', 'opera.exe')],
    ['opera', join(pf, 'Opera', 'opera.exe')],
    ['quark', join(pf, 'Quark', 'quark.exe')],
    // gecko (round 41): Firefox via Marionette temporary install
    ['firefox', join(pf, 'Mozilla Firefox', 'firefox.exe')],
    ['firefox', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'],
    ['chrome', '/usr/bin/google-chrome'],
    ['chromium', '/usr/bin/chromium-browser'],
    ['chromium', '/usr/bin/chromium'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ];
  const seen = new Set(out.map((b) => b.command));
  for (const [name, p] of candidates) {
    if (p && p !== join('', '') && !seen.has(p) && existsSync(p)) { seen.add(p); out.push({ name, command: p }); }
  }
  // desktop shortcuts (how the user actually launches browsers): resolve
  // .lnk targets and keep ones that name a known browser executable
  try {
    const desktop = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Desktop');
    for (const f of readdirSync(desktop)) {
      if (!f.toLowerCase().endsWith('.lnk')) continue;
      const lnk = join(desktop, f);
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`], { encoding: 'utf8', timeout: 10_000 });
      const target = (r.stdout ?? '').trim();
      const base = target.split('\\').pop()?.toLowerCase() ?? '';
      const family = base === 'firefox.exe' ? 'firefox'
        : ['brave.exe', 'opera.exe', 'quark.exe'].includes(base) ? 'chromium-peer' : null;
      if (!family || !existsSync(target)) continue;
      const name = family === 'firefox' ? 'firefox' : base.replace('.exe', '');
      if (![...out].some((b) => b.command.toLowerCase() === target.toLowerCase())) {
        out.push({ name, command: target });
      }
    }
  } catch { /* no desktop or no shortcuts — optional discovery */ }
  return out;
}

/** Branded Chrome (2025+) IGNORES --load-extension — and spawning with the
 *  dead flags also poisons the DevTools loadUnpacked path (observed: with
 *  the flags present the loaded extension's pages return chrome-error; the
 *  identical spawn WITHOUT them loads fine). For brand Chrome: no extension
 *  flags at all, install purely via Extensions.loadUnpacked. */
const usesLoadExtensionFlag = (name: string): boolean => name !== 'chrome';

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

const waitFor = async (fn: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(500);
  }
  return await fn();
};

/** Branded Chrome (2025+) ignores --load-extension; the sanctioned
 *  automation path is the DevTools-protocol Extensions.loadUnpacked
 *  command over the BROWSER-level WebSocket (what Puppeteer's extension
 *  testing uses). ~30 lines, zero new dependencies. */
async function loadUnpackedViaCdp(cdpPort: number, dir: string): Promise<unknown> {
  const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() as { webSocketDebuggerUrl: string };
  return new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const fail = (e: unknown) => reject(new Error('loadUnpacked ws: ' + String(e)));
    ws.addEventListener('error', fail, { once: true });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: dir } }));
    }, { once: true });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) fail(msg.error.message);
      else resolve(msg.result);
    }, { once: true });
  });
}

/** Minimal Marionette (Gecko's automation protocol) client — just enough
 *  to install the extension temporarily and drive its popup. Wire: TCP,
 *  length-prefixed JSON; server handshake {applicationType,marionetteProtocol};
 *  commands `[0,id,name,params]`; responses `[1,id,error,result]`. Firefox
 *  release builds require SIGNED extensions EXCEPT temporary installs,
 *  whose sanctioned automation path is exactly this command. */
class Marionette {
  private sock: import('node:net').Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly handshake: Promise<void>;

  constructor(port: number) {
    this.handshake = new Promise<void>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.setEncoding('utf8');
      s.on('error', (e) => reject(e));
      s.on('data', (d: string) => {
        this.buf += d;
        for (;;) {
          const m = /^(\d+):/.exec(this.buf);
          if (!m) break;
          const len = Number(m[1]);
          const head = m[0].length;
          if (this.buf.length < head + len) break;
          const payload = this.buf.slice(head, head + len);
          this.buf = this.buf.slice(head + len);
          let msg: unknown;
          try { msg = JSON.parse(payload); } catch { continue; }
          if (Array.isArray(msg) && msg[0] === 1) {
            const p = this.pending.get(msg[1] as number);
            if (p) {
              this.pending.delete(msg[1] as number);
              if (msg[2]) p.reject(new Error(String(JSON.stringify(msg[2])).slice(0, 220)));
              else p.resolve(msg[3]);
            }
          } else if (!Array.isArray(msg)) {
            resolve(); // server handshake {applicationType, marionetteProtocol}
          }
        }
      });
      this.sock = s;
    });
  }

  ready(): Promise<void> {
    return this.handshake;
  }

  command(name: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify([0, id, name, params]);
      this.sock!.write(`${Buffer.byteLength(frame)}:${frame}`);
    });
  }

  close(): void {
    try { this.sock?.end(); } catch { /* already dead */ }
  }
}

/** Firefox flow: temporary install via Marionette, popup pairing driven
 *  through WebDriver, agent tools over the loopback (browser-agnostic). */
async function firefoxFlow(
  t: import('node:test').TestContext,
  b: { name: string; command: string },
  shared: { home: string; bridge: ExtensionBridgeServer; builtDir: string },
): Promise<void> {
  await t.test(`firefox: ${b.command}`, async () => {
    const { home, bridge, builtDir } = shared;
    const profile = mkdtempSync(join(tmpdir(), 'ext-real-ff-profile-'));
    let proc: ChildProcess | null = null;
    let mar: Marionette | null = null;
    const ctx = { cwd: home, home };
    try {
      // -no-remote: NEVER attach to the user's running Firefox
      proc = spawn(b.command, ['-no-remote', '-profile', profile, '-marionette', '--headless', 'about:blank'],
        { stdio: 'ignore' });

      assert.ok(await waitFor(async () => {
        try { const m = new Marionette(2828); await m.ready(); m.close(); return true; } catch { return false; }
      }, 30_000), 'Marionette port 2828 never came up');

      mar = new Marionette(2828);
      await mar.ready();
      const m = mar;

      // 1. session FIRST (current Firefox routes Addon:Install through the
      //    WebDriver agent — it refuses without an active session), then
      //    temporary install — try the unpacked dir, fall back to a zip
      await m.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true, browserName: 'firefox' } } });
      let installResult = await m.command('Addon:Install', { path: builtDir, temporary: true })
        .then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
      if (!installResult.ok) {
        const zip = join(profile, 'payload.zip');
        const zipped = spawnSync('powershell', ['-NoProfile', '-Command',
          `Compress-Archive -Path '${builtDir.replace(/'/g, "''")}*' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`],
          { encoding: 'utf8', timeout: 30_000 });
        if (zipped.status === 0) {
          installResult = await m.command('Addon:Install', { path: zip, temporary: true })
            .then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
        }
      }
      assert.ok(installResult.ok, `Addon:Install failed: ${installResult.ok ? '' : installResult.e.message}`);

      // 2. the UNPAIRED background announces its base URL -> popup URL
      //    (round 41 announce — the moz-extension://uuid is otherwise
      //    undiscoverable from outside the browser)
      assert.ok(await waitFor(async () => {
        const st = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
        return typeof st.extBaseUrl === 'string' && st.extBaseUrl.startsWith('moz-extension://');
      }, 25_000), 'background never announced its base URL (event page did not run?)');
      const st0 = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
      assert.ok(typeof st0.extBaseUrl === 'string' && st0.extBaseUrl.startsWith('moz-extension://'), 'announced base URL must be a moz-extension origin');

      // 3. pair from the DEMO PAGE — an unprivileged http page WebDriver
      //    CAN script (Firefox refuses script execution on privileged
      //    moz-extension:// pages AND never auto-grants MV3 host
      //    permissions, so content-script pairing is structurally out).
      //    The page posts the code to the bridge's /v1/demo-pair; the
      //    background picks the parked token up via announce-status.
      await m.command('WebDriver:Navigate', { url: `http://127.0.0.1:${PORT}/v1/demo-page` });
      const issued = await issuePairingCode(home);
      assert.equal(issued.ok, true);
      let ffProbe = '';
      assert.ok(await waitFor(async () => {
        try {
          const v = await m.command('WebDriver:ExecuteScript', {
            script: `return (() => {
              const i = document.getElementById('hmh-code'), b = document.getElementById('hmh-pair-btn');
              if (!i || !b) return 'no-widget';
              if (b.dataset.hmhClicked === '1') return 'already';
              i.value = '${issued.ok ? issued.code : ''}';
              b.dataset.hmhClicked = '1';
              b.click();
              return 'clicked';
            })();`,
          }).then((r: any) => ({ v: r?.value }), (e: Error) => ({ err: e.message.slice(0, 160) }));
          ffProbe = `script=${JSON.stringify(v)}`;
          return (v as { v?: string }).v === 'clicked';
        } catch (e) { ffProbe = 'probe-throw ' + String(e).slice(0, 120); return false; }
      }, 20_000), `firefox demo-page pair widget never fired (${ffProbe})`);

      // 4. connected + liveness (same ghost-proof gate as the chromium flow)
      assert.ok(await waitFor(async () => {
        const st = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
        return Boolean(st.connected);
      }, 20_000), 'firefox extension never connected to the bridge');
      assert.ok(await waitFor(() => bridge.command('ping', 3_000).then(() => true, () => false), 30_000), 'command path never came alive');

      // 5. agent tools against the real Firefox
      const tools = extensionTools({ home });
      const byName = (n: string) => tools.find((x) => x.name === n)!;
      await m.command('WebDriver:Navigate', { url: `http://127.0.0.1:${PORT}/v1/demo-page` });
      await sleep(1_200);
      const tabs = await byName('extension_tabs').execute({}, ctx);
      assert.ok(!tabs.isError, `extension_tabs failed: ${tabs.output}`);
      assert.ok(/demo-page/.test(tabs.output), 'real tabs include the demo page');
      // Firefox MV3 STRUCTURAL BOUNDARY (round 41, wire-verified): host
      // permissions are OPT-IN — never auto-granted, temporary installs
      // included. tabs/status/pairing/command channels all work; page
      // scripting stays refused until the user grants site access in
      // about:addons. The tool must surface that honestly (actionable
      // error, not a hang), exactly like a real user would see.
      const read = await byName('extension_page_read').execute({}, ctx);
      assert.ok(read.isError, 'un-granted Firefox MUST refuse page scripting');
      assert.match(read.output, /Missing host permission|host permission/i);
      const act = await byName('extension_page_act').execute({ action: 'scroll', direction: 'bottom' }, ctx);
      assert.ok(act.isError, 'un-granted Firefox MUST refuse page acting');
    } finally {
      if (proc?.pid) killTree(proc.pid);
      mar?.close();
      await unpair(home).catch(() => undefined); // next subtest starts unpaired
      await sleep(800);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile lock — tmp dir, OS reaps */ }
    }
  });
}

test('real browser: extension installs, pairs via popup, serves agent tools', { timeout: 300_000 }, async (t) => {
  // HMH_TEST_BROWSERS=browseros,chrome,edge narrows the set (debugging aid)
  const filter = process.env.HMH_TEST_BROWSERS?.split(',').map((s) => s.trim());
  const browsers = findBrowserBinaries().filter((b) => !filter || filter.includes(b.name));
  if (browsers.length === 0) return t.skip('no Chromium-family binary on this machine (BrowserOS/Chrome/Edge)');
  if (!(await portFree(PORT))) return t.skip(`port ${PORT} busy — a bridge is already running`);

  const home = mkdtempSync(join(tmpdir(), 'ext-real-'));
  const outDir = mkdtempSync(join(tmpdir(), 'ext-real-build-'));
  const bridge = new ExtensionBridgeServer({ home });
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    // self-contained: build BOTH payloads for this port into tmp —
    // chromium (BrowserOS/Chrome/Edge/Brave/Opera/Quark) + firefox (Marionette)
    const [builtC, builtF] = await Promise.all([
      buildExtension({ target: 'chromium', outDir, port: PORT }),
      buildExtension({ target: 'firefox', outDir, port: PORT }),
    ]);
    const built = builtC[0]!;
    const builtFf = builtF[0]!;
    assert.ok(built, 'chromium build produced a dir');
    assert.ok(builtFf, 'firefox build produced a dir');
    await bridge.start(PORT);

    for (const b of browsers) {
      if (b.name === 'firefox') {
        await firefoxFlow(t, b, { home, bridge, builtDir: builtFf.dir });
        continue;
      }
      await t.test(`${b.name}: ${b.command}`, async () => {
        const profile = mkdtempSync(join(tmpdir(), 'ext-real-profile-'));
        let proc: ChildProcess | null = null;
        let cdp: InstanceType<typeof CdpBrowser> | null = null;
        try {
          const issued = await issuePairingCode(home);
          assert.equal(issued.ok, true);

          proc = spawn(b.command, [
            `--user-data-dir=${profile}`,
            '--no-first-run', '--no-default-browser-check',
            ...(usesLoadExtensionFlag(b.name)
              ? [`--disable-extensions-except=${built.dir}`, `--load-extension=${built.dir}`]
              : [] // branded Chrome: dead flags would poison loadUnpacked too
            ),
            // port 0 = Chromium picks a free one; the ACTUAL port lands in
            // <profile>/DevToolsActivePort — no collisions with user CDP usage
            '--remote-debugging-port=0',
            '--headless=new',
            'about:blank',
          ], { stdio: 'ignore', detached: process.platform !== 'win32' });

          let cdpPort = 0;
          assert.ok(await waitFor(() => {
            try {
              const txt = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim();
              cdpPort = Number(txt.split(/\r?\n/)[0]);
              return cdpPort > 0;
            } catch { return false; }
          }, 20_000), 'DevToolsActivePort never appeared');

          // 1. find OUR SW among the extension targets (BrowserOS ships builtins)
          cdp = new CdpBrowser({ port: cdpPort });
          let extId: string | null = null;
          let lastTargets: string[] = [];
          const findOurs = async (): Promise<boolean> => {
            if (!(await cdp!.up())) return false;
            const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<{ url: string; id: string; type: string }>;
            lastTargets = list.filter((x) => x.url.startsWith('chrome-extension://')).map((x) => `${x.type} ${x.url}`);
            for (const sw of list.filter((x) => x.url.startsWith('chrome-extension://') && x.url.includes('background.js'))) {
              const name = await cdp!.evaluate(sw.id, 'chrome.runtime.getManifest().name').catch(() => null);
              if (String(name).includes('hmharness')) { extId = new URL(sw.url).host; return true; }
            }
            return false;
          };
          // first give --load-extension 8s; branded Chrome (2025+) ignores
          // that flag entirely — fall back to Extensions.loadUnpacked
          let loadUnpackedNote = '';
          assert.ok(
            await waitFor(findOurs, 8_000)
            || await (async () => {
              const r = await loadUnpackedViaCdp(cdpPort, built.dir).then(
                (ok) => ok as { id?: string },
                (e: Error) => { loadUnpackedNote = `loadUnpacked FAILED: ${e.message}`; return null; },
              );
              if (!r) return false;
              loadUnpackedNote = `loadUnpacked ok: ${JSON.stringify(r)}`;
              // wait briefly for the SW to surface, but an idle MV3 worker
              // is NOT listed in /json — trust the returned id instead:
              // opening the popup page wakes the worker
              if (!(await waitFor(findOurs, 6_000)) && r.id) extId = r.id;
              return extId !== null;
            })(),
            `hmharness extension never appeared on CDP (${loadUnpackedNote}; extension targets seen: ${JSON.stringify(lastTargets)})`,
          );

          // 2. drive the popup's pair form over CDP (what a user does by
          //    hand) — ONLY after ui.js marked itself ready: a click on a
          //    listener-less button is a silent no-op (race found by
          //    forensics: HTML parsed before the script ran)
          const popupUrl = `chrome-extension://${extId}/popup.html`;
          const tabId = await cdp.openTab(popupUrl);
          let popupLoc = '';
          assert.ok(await waitFor(async () => {
            popupLoc = String(await cdp!.evaluate(tabId, 'location.href').catch(() => 'EVAL-ERR'));
            const r = await cdp!.evaluate(tabId, `(() => {
              if (document.body?.dataset?.hmhUi !== 'ready') return false;
              const p = document.getElementById('port'), c = document.getElementById('code'), btn = document.getElementById('pair');
              if (!p || !c || !btn) return false;
              p.value = '${PORT}'; c.value = '${issued.ok ? issued.code : ''}'; btn.click(); return true;
            })()`).catch(() => null);
            return r === true;
          }, 15_000), `popup UI never became interactive (tab location: ${popupLoc})`);

          // 3. the REAL background.js attached: bridge status flips connected
          assert.ok(await waitFor(async () => {
            const st = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
            return Boolean(st.connected);
          }, 15_000), 'extension never connected to the bridge');

          // 3b. LIVENESS proof before driving the tools: the ghost-link race
          // (an MV3 worker killed + respawned onto a NEW stream while the
          // browser keeps the old socket half-open) can satisfy the check
          // above. The bridge now clears ghosts after 2 missed heartbeats
          // (~10s) and the worker re-attaches via its alarm — retry a real
          // round-trip until the command path is PROVEN alive.
          assert.ok(await waitFor(() => bridge.command('ping', 3_000).then(() => true, () => false), 45_000), 'command path never came alive (ghost link did not heal)');

          // 4. agent tools against the REAL browser
          const ctx = { cwd: home, home };
          const tools = extensionTools({ home });
          const byName = (n: string) => tools.find((x) => x.name === n)!;

          const tabs = await byName('extension_tabs').execute({}, ctx);
          if (tabs.isError) {
            // decisive forensics: bridge's live view, AND whether the
            // extension's service worker is still a CDP target (a dead SW
            // whose fetch stream never aborted = ghost connection)
            const st = await (await fetch(`http://127.0.0.1:${PORT}/v1/status`)).json();
            let swState = 'n/a';
            try {
              const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<{ url: string; id: string; type: string }>;
              const ours = list.filter((x) => x.url.includes(extId!)).map((x) => `${x.type} ${x.url}`);
              swState = ours.length ? ours.join(' | ') : `GONE (targets: ${list.filter((x) => x.url.startsWith('chrome-extension://')).length} ext)`;
              const sw = list.find((x) => x.url.includes(extId!) && x.type === 'service_worker');
              if (sw) swState += ` [eval: ${String(await cdp!.evaluate(sw.id, '(async () => JSON.stringify(await chrome.storage.local.get(["port"])))()').catch((e: unknown) => 'ERR ' + String(e)))}]`;
            } catch (e) { swState = 'probe-err ' + String(e); }
            assert.ok(false, `extension_tabs failed: ${tabs.output}\nbridge=${JSON.stringify(st)}\nsw=${swState}`);
          }
          assert.ok(tabs.output.includes(extId!), 'real tabs include the popup tab');

          // read a plain http page (within host_permissions; the browser REFUSES
          // scripting on chrome-extension:// pages by design — surfaced honestly)
          const plain = (await cdp.tabs()).find((x) => x.url === 'about:blank');
          const readTab = plain?.targetId ?? (await cdp.openTab('about:blank'));
          await cdp.navigate(readTab, `http://127.0.0.1:${PORT}/v1/status`);
          await cdp.activateTab(readTab).catch(() => undefined);
          await sleep(1_000);
          const read = await byName('extension_page_read').execute({}, ctx);
          assert.ok(!read.isError, `extension_page_read failed: ${read.output}`);
          assert.ok(read.output.includes('hmext/1'), 'page read carried the status payload');

          const act = await byName('extension_page_act').execute({ action: 'scroll', direction: 'top' }, ctx);
          assert.ok(!act.isError, `extension_page_act failed: ${act.output}`);
          assert.ok(act.output.includes('scrolled'));
        } finally {
          if (proc?.pid) killTree(proc.pid);
          await cdp?.close().catch(() => undefined); // the CDP WebSocket must not hold the runner open
          await unpair(home).catch(() => undefined); // next subtest starts unpaired
          await sleep(800);
          try { rmSync(profile, { recursive: true, force: true }); } catch { /* .browseros lock — tmp dir, OS reaps */ }
        }
      });
    }
  } finally {
    await bridge.stop().catch(() => undefined);
    if (prevHome === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prevHome;
    await sleep(500);
    for (const d of [home, outDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* lock — tmp dir, OS reaps */ }
    }
  }
});
