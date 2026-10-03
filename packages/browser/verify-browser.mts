/**
 * Real-machine verification for @hmharness/browser (verify-live.mts
 * precedent from @hmharness/lsp).
 *
 * Drives the FULL chain through the agent TOOL surface: discovery
 * (config origin) -> auto trust-pinning -> launch (headless, dedicated
 * profile) -> CDP connect -> browser_navigate -> browser_snapshot (refs)
 * -> browser_click -> browser_type -> browser_read -> browser_tabs ->
 * browser_screenshot -> stop. Navigation targets a LOOPBACK http server
 * this script starts, so the run is deterministic and needs no internet.
 *
 * BrowserOS is a Chromium 155 fork; when it is not installed yet any
 * stock Chromium binary stands in and exercises the IDENTICAL CDP
 * surface this driver speaks (verified against Edge 155).
 *
 * Run (nothing touches ~/.hmharness or the user's daily profile — a
 * throwaway HMH_HOME is created):
 *   npx tsx packages/browser/verify-browser.mts "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
 */
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
if (!exe || !statSync(exe, { throwIfNoEntry: false })?.isFile()) {
  console.error('usage: npx tsx packages/browser/verify-browser.mts <path-to-chromium-binary>');
  process.exit(2);
}

const home = await mkdtemp(join(tmpdir(), 'hmh-browser-verify-'));
process.env.HMH_HOME = home; // kernel loadConfig + our trust/state all read this
await writeFile(join(home, 'config.json'), JSON.stringify({ browser: { executablePath: exe, headless: true } }, null, 2), 'utf8');

const PAGE = `<!doctype html><html><head><title>Verify Page</title></head><body>
<h1>hello hmh</h1>
<a href="/next">a link</a>
<input placeholder="type here">
<button onclick="document.title='CLICKED'">click me</button>
</body></html>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
const PORT = 19312;
await new Promise<void>((r) => srv.listen(PORT, '127.0.0.1', r));

const { browserTools, stopBrowser, browserTrustPath } = await import('./src/index.ts');
const tools = browserTools({ workspaceRoot: process.cwd(), home });
const byName = (n: string) => tools.find((t) => t.name === n)!;

let failures = 0;
const step = async (name: string, args: Record<string, unknown>, check: (out: string) => string | null) => {
  const r = await byName(name).execute(args, { cwd: process.cwd(), home });
  const out = String(r.output ?? '');
  const bad = r.isError ? 'tool returned isError' : check(out);
  if (bad) {
    failures++;
    console.log(`FAIL ${name}: ${bad}\n  output: ${out.slice(0, 300)}`);
  } else {
    console.log(`ok   ${name}: ${out.split('\n')[0].slice(0, 100)}`);
  }
  return out;
};

console.log(`verify-browser against: ${exe}\ntemp HMH_HOME: ${home}\n`);

// 1. navigate (implicit auto-start: discovery -> trust pin -> launch -> CDP)
await step('browser_navigate', { url: `http://127.0.0.1:${PORT}/` }, (o) => (/Verify Page/.test(o) ? null : 'title missing'));
// 2. snapshot with refs
const snap = await step('browser_snapshot', {}, (o) => (/\[\d+\]/.test(o) ? null : 'no refs in snapshot'));
// 3. click the button ref (title -> CLICKED), verified via read
const refOf = (needle: string) => {
  const line = snap.split('\n').find((l) => l.includes(needle));
  const m = (line ?? '').match(/\[(\d+)\]/);
  return m ? Number(m[1]) : null;
};
const btnRef = refOf('button');
const inputRef = refOf('input');
if (btnRef && inputRef) {
  await step('browser_click', { ref: btnRef }, (o) => (/clicked/.test(o) ? null : 'no click confirmation'));
  await step('browser_read', {}, (o) => (/CLICKED/.test(o) ? null : 'title not CLICKED after click'));
  await step('browser_type', { ref: inputRef, text: 'hmh typed' }, (o) => (/typed/.test(o) ? null : 'no type confirmation'));
  const snap2 = await step('browser_snapshot', {}, (o) => (/value="hmh typed"/.test(o) ? null : 'typed value not reflected'));
  void snap2;
} else {
  failures++;
  console.log(`FAIL refs: snapshot lacked button/input refs (btn=${btnRef} input=${inputRef})`);
}
// 4. tabs + screenshot
await step('browser_tabs', { action: 'list' }, (o) => (/tab\(s\)/.test(o) ? null : 'no tab list'));
await step('browser_screenshot', {}, (o) => {
  const p = o.split(' ')[0];
  try { return statSync(p).size > 1000 ? null : 'png suspiciously small'; } catch { return 'png not written'; }
});

// 5. trust store pinned the binary (config-origin auto-trust)
const trust = JSON.parse(await readFile(browserTrustPath(home), 'utf8'));
if (trust.entries?.browseros?.sha256?.length === 64) console.log('ok   trust: sha256 pinned for browseros (config origin)');
else { failures++; console.log('FAIL trust: no sha256 pin in store'); }

// 6. stop (kills the REAL browser pid resolved from the port listener)
const st = await stopBrowser(home);
if (st.stopped) console.log(`ok   stop: ${st.detail}`);
else { failures++; console.log(`FAIL stop: ${st.detail}`); }

srv.close();
await rm(home, { recursive: true, force: true }).catch(() => undefined);
console.log(failures === 0 ? '\nVERIFY PASS (full tool chain, real machine, loopback http)' : `\nVERIFY FAIL (${failures} steps)`);
process.exit(failures === 0 ? 0 : 1);
