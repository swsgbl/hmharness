// Real-machine LSP verification against the fake server via the public surface
import { shutdownLsp, discoverServers, ProcessManager, LspClient, fileToUri } from './src/index.ts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const ws = 'G:/hmharness/.tmp-lsp-ws';
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
writeFileSync(ws + '/demo.ts', 'const x: number = 1;\nconsole.log(x);\n');

console.log('discovered real servers:', discoverServers().map((s) => s.id).join(', ') || '(none)');

const mgr = new ProcessManager({ id: 'fake', command: process.execPath, args: ['src/__tests__/fixtures/fake-server.cjs'], source: 'explicit' }, process.cwd());
const client = new LspClient(mgr.start(), { requestTimeoutMs: 10_000 });
const info = await client.initialize(fileToUri(ws));
console.log('initialized:', info.serverInfo?.name, info.serverInfo?.version);
const uri = fileToUri(ws + '/demo.ts');
client.openDoc(uri, 'typescript', 'const y = DELBERATE_ERROR_MARKER;\n');
await new Promise((r) => setTimeout(r, 400));
const hover = await client.hover({ uri }, { line: 0, character: 6 });
console.log('hover:', JSON.stringify(hover?.contents).slice(0, 80));
const def = await client.definition({ uri }, { line: 0, character: 6 });
console.log('definition:', Array.isArray(def) ? def[0]?.uri : def?.uri);
await client.shutdown();
await mgr.stop();
console.log('stopped:', mgr.running === false);
await shutdownLsp();
console.log('REAL-MACHINE (fake-server) LIFECYCLE OK — real typescript-language-server: NOT ON PATH (NOT VERIFIED against a real server this round)');
