/**
 * Real-machine verification for `hmh acp-serve` — spawns the CLI as a real
 * ACP agent subprocess and speaks ndjson JSON-RPC over stdio exactly like a
 * host (BrowserOS assistant panel / Zed) would: initialize -> session/new ->
 * session/prompt -> collect agent_message_chunk notifications -> assert the
 * agent's answer. Uses the machine's real hmh provider config (one tiny
 * model call, same shape as `npm run test:e2e`).
 *
 * Run: npx tsx packages/cli/verify-acp.mts
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', 'acp-serve'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'inherit'],
});

const frames: Array<Record<string, any>> = [];
let lineWaiter: (() => void) | null = null;
const rl = readline.createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try { frames.push(JSON.parse(line)); } catch { console.error('unparseable:', line.slice(0, 120)); return; }
  lineWaiter?.();
  lineWaiter = null;
});
/** wait for the NEXT stdout line (not "any frame exists" — old frames must
 *  not satisfy the wait or the loop starves the event loop) */
const waitForLine = (): Promise<void> => new Promise((r) => { lineWaiter = r; });

async function request(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  while (!frames.some((f) => f.id === id)) await waitForLine();
  const f = frames.find((x) => x.id === id)!;
  if (f.error) throw new Error('rpc error: ' + JSON.stringify(f.error));
  return f.result;
}

const timeout = setTimeout(() => { console.error('TIMEOUT'); child.kill(); process.exit(1); }, 180_000);
const t0 = Date.now();
const init = await request(1, 'initialize', { protocolVersion: '0.4.5', clientCapabilities: {} });
console.log(`ok   initialize (v${init.protocolVersion}) ${Date.now() - t0}ms`);
const news = await request(2, 'session/new', { cwd: process.cwd() });
const sid = news.sessionId;
console.log(`ok   session/new -> ${sid}`);
const promptDone = request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'reply with exactly: HMH-ACP-OK' }] });
const stop = await promptDone;
// give trailing notifications a beat to land
await new Promise((r) => setTimeout(r, 300));
const chunks = frames
  .filter((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'agent_message_chunk')
  .map((f) => f.params.update.content.text)
  .join('');
const kinds = [...new Set(frames.filter((f) => f.method === 'session/update').map((f) => f.params.update.sessionUpdate))];
console.log(`ok   session/prompt -> stopReason=${stop.stopReason} (${Date.now() - t0}ms, updates: ${kinds.join(',')})`);
console.log(`     agent said: ${chunks.slice(0, 200)}`);
clearTimeout(timeout);
child.stdin.end();
const pass = stop.stopReason === 'end_turn' && chunks.includes('HMH-ACP-OK');
console.log(pass ? '\nVERIFY PASS (real stdio ACP round-trip, real provider)' : '\nVERIFY FAIL');
setTimeout(() => process.exit(pass ? 0 : 1), 200);
