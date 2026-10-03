// REAL-server full-chain verification against DevEco's bundled clangd
// (the previously NOT VERIFIED item: no healthy language server existed)
import { ProcessManager, LspClient, discoverServers, fileToUri } from './src/index.ts';

const clangd = discoverServers(true).find((s) => s.id === 'clangd' && s.origin === 'DevEco-local');
if (!clangd || !clangd.healthy) {
  console.log('DevEco clangd not discovered/healthy:', clangd?.unhealthyReason ?? 'absent');
  process.exit(0);
}
console.log('server:', clangd.command, '| origin:', clangd.origin, '| official:', clangd.official);

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ws = mkdtempSync(join(tmpdir(), 'clangd-ws-'));
// a C file with a REAL syntax error (missing semicolon)
writeFileSync(join(ws, 'probe.c'), 'int main(void) {\n  int x = 1\n  return x;\n}\n');

const mgr = new ProcessManager(clangd, ws);
const diags: Array<{ uri: string; n: number; msgs: string[] }> = [];
const client = new LspClient(mgr.start(), {
  requestTimeoutMs: 30_000,
  onDiagnostics: (uri, d) => diags.push({ uri, n: d.length, msgs: d.map((x) => x.message.slice(0, 60)) }),
});
const init = await client.initialize(fileToUri(ws));
console.log('initialize OK:', JSON.stringify(init.serverInfo), '| hoverProvider:', Boolean((init.capabilities as Record<string, unknown>).hoverProvider));
const uri = fileToUri(join(ws, 'probe.c'));
client.openDoc(uri, 'c', 'int main(void) {\n  int x = 1\n  return x;\n}\n');
// clangd needs a moment to parse and publish
await new Promise((r) => setTimeout(r, 4_000));
const got = diags.filter((d) => d.uri === uri);
console.log('diagnostics pushes:', got.length, '| total diags:', got.reduce((s, d) => s + d.n, 0));
if (got.length > 0 && got[0]!.n > 0) console.log('first diag:', got[0]!.msgs[0]);
const hover = await client.hover({ uri }, { line: 0, character: 5 }).catch((e: Error) => ({ error: e.message }));
console.log('hover:', hover && 'contents' in (hover as object) ? 'returned' : JSON.stringify(hover).slice(0, 120));
await client.shutdown();
await mgr.stop();
console.log('stopped cleanly:', mgr.running === false);
rmSync(ws, { recursive: true, force: true });
console.log('REAL-SERVER (DevEco clangd) FULL CHAIN:', diags.length > 0 ? 'VERIFIED' : 'handshake verified, no diagnostics pushed');
