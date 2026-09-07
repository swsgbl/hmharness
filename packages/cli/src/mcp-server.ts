/**
 * @hmharness/cli - mcp-server (stdio MCP server mode)
 * Turns hmharness into a native tool provider for MCP hosts (Claude Code,
 * Codex, Cursor, ...): they call harmony_build / harmony_api_lookup / ... as
 * first-class tools - no nested agent loop, no double context, and the host's
 * per-tool permission UI becomes the approval gate.
 *
 * Security model in server mode (deliberate, documented):
 *   - EXPOSED: only tools matching /^harmony_/ by default (the HarmonyOS
 *     domain surface). Generic tools (run_command, write_file, ...) stay
 *     private - the host already has bash/file tools of its own. Override
 *     with HMH_MCP_TOOLS="name_or_prefix,name_or_prefix,...".
 *   - APPROVAL: tool-level needsApproval is intentionally NOT consulted -
 *     the host prompts its user per tool call. What still applies is the
 *     hard walls INSIDE every tool (destructive-command deny, path red
 *     lines): those never depended on interaction and stay server-side.
 *   - OBSERVABILITY: every tools/call is appended to
 *     insights/mcp-calls.jsonl (tool, ok, ms) - external agents' HarmonyOS
 *     usage becomes visible to the radar/insight pipeline (observation only;
 *     the skill gate stays exclusive to native hmh sessions).
 *
 * Protocol: line-delimited JSON-RPC 2.0 over stdio (initialize /
 * notifications/initialized / tools/list / tools/call / ping), the same
 * shape scripts/test-mcp-server.mjs proved in-repo. stdout belongs to the
 * protocol - every stray console.log is redirected to stderr.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';
import { buildRegistry } from '@hmharness/agent';
import type { Tool } from '@hmharness/kernel';

const VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version; } catch { return '0.0.0'; }
})();

function exposedFilter(): (t: Tool) => boolean {
  const raw = process.env.HMH_MCP_TOOLS;
  if (raw && raw.trim()) {
    const pats = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return (t) => pats.some((p) => t.name === p || t.name.startsWith(p.endsWith('_') || p.endsWith('-') ? p : p + '_'));
  }
  return (t) => t.name.startsWith('harmony_');
}

export async function serveMcp(): Promise<void> {
  // stdout is the protocol channel: silence any library prints.
  const realLog = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  void realLog;

  const { reg } = await buildRegistry({ mcp: false, announce: false });
  const tools = reg.list().filter(exposedFilter());
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ctx = { cwd: process.cwd(), home: homeDir() };

  const logCall = async (tool: string, ok: boolean, ms: number) => {
    try {
      const dir = join(ctx.home, 'insights');
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'mcp-calls.jsonl'), JSON.stringify({ time: new Date().toISOString(), tool, ok, ms }) + '\n', 'utf8');
    } catch { /* observation is best-effort, never fails a call */ }
  };

  const reply = (id: unknown, result: unknown, error?: { code: number; message: string }) => {
    const out: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) out.error = error;
    else out.result = result;
    process.stdout.write(JSON.stringify(out) + '\n');
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // notification (notifications/initialized etc.) - no reply
    switch (msg.method) {
      case 'initialize':
        reply(msg.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'hmharness', version: VERSION },
        });
        break;
      case 'ping':
        reply(msg.id, {});
        break;
      case 'tools/list':
        reply(msg.id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description.slice(0, 1000),
            inputSchema: t.parameters,
          })),
        });
        break;
      case 'tools/call': {
        const name = msg.params?.name ?? '';
        const tool = byName.get(name);
        if (!tool) {
          void logCall(name, false, 0);
          reply(msg.id, { content: [{ type: 'text', text: `unknown or not exposed tool: ${name}` }], isError: true });
          break;
        }
        const t0 = Date.now();
        tool.execute(msg.params?.arguments ?? {}, ctx)
          .then(async (r) => {
            await logCall(name, r.isError !== true, Date.now() - t0);
            reply(msg.id, { content: [{ type: 'text', text: r.output }], ...(r.isError === true ? { isError: true } : {}) });
          })
          .catch(async (err) => {
            await logCall(name, false, Date.now() - t0);
            reply(msg.id, { content: [{ type: 'text', text: String(err) }], isError: true });
          });
        break;
      }
      default:
        reply(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
    }
  });
  // stdin closed (host shut us down) - exit cleanly.
  rl.on('close', () => process.exit(0));
}
