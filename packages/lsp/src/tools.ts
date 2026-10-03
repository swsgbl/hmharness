/**
 * @hmharness/lsp - agent tools (Tier 0, read-only)
 *
 * The agent-facing surface per the 03 方案 Tier-0 list: diagnostics,
 * hover, definition, references, symbols. All read-only, all results
 * marked `source: lsp` — LSP diagnostics are FEEDBACK, never build/test
 * proof (master prompt prohibition).
 */
import type { Tool } from '@hmharness/kernel';
import { ProcessManager } from './process-manager.ts';
import { LspClient } from './client.ts';
import { discoverServers, serverForFile, fileToUri, type DiscoveredServer } from './registry.ts';
import type { Diagnostic } from './protocol.ts';

export interface LspToolContext {
  workspaceRoot: string;
}

interface ManagedClient {
  server: DiscoveredServer;
  manager: ProcessManager;
  client: LspClient;
  diagnostics: Map<string, Diagnostic[]>;
}

/** One live client per server for the lifetime of the context. */
const clients = new Map<string, ManagedClient>();

/** Sync last-resort kill on process exit (async shutdown may not run when
 *  the host dies); children must never outlive the agent process. */
if (typeof process !== 'undefined') {
  process.once('exit', () => {
    for (const [, mc] of clients) mc.manager.killSync();
  });
}

async function clientFor(server: DiscoveredServer, workspaceRoot: string): Promise<ManagedClient> {
  const existing = clients.get(server.id);
  if (existing) return existing;
  const manager = new ProcessManager(server, workspaceRoot);
  const diagnostics = new Map<string, Diagnostic[]>();
  const client = new LspClient(manager.start(), {
    onDiagnostics: (uri, diags) => diagnostics.set(uri, diags),
  });
  await client.initialize(fileToUri(workspaceRoot));
  const entry: ManagedClient = { server, manager, client, diagnostics };
  clients.set(server.id, entry);
  return entry;
}

/** Stop every client this module started (TUI/CLI shutdown path). */
export async function shutdownLsp(): Promise<void> {
  for (const [, mc] of clients) {
    await mc.client.shutdown().catch(() => undefined);
    await mc.manager.stop();
  }
  clients.clear();
}

function fmtDiags(diags: Diagnostic[]): string {
  if (diags.length === 0) return 'no diagnostics';
  const sev = ['ERROR', 'WARN', 'INFO', 'HINT'];
  return diagnosticsSummary(diags) + '\n' + diags.slice(0, 10).map((d) => `  [${sev[(d.severity ?? 1) - 1]}] L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source ?? ''} ${d.message.slice(0, 140)}`).join('\n');
}

export function diagnosticsSummary(diags: Diagnostic[]): string {
  const errors = diags.filter((d) => (d.severity ?? 1) === 1).length;
  const warnings = diags.filter((d) => (d.severity ?? 2) === 2).length;
  return `${diags.length} diagnostics (${errors} errors, ${warnings} warnings) — source: lsp (feedback, not build/test proof)`;
}

/** Resolve the target file argument to an absolute path (workspace-bound). */
function resolveFile(ctx: LspToolContext, file: string): string {
  const abs = file.match(/^[A-Za-z]:[\\/]/) || file.startsWith('/') ? file : `${ctx.workspaceRoot}/${file}`.replace(/\\/g, '/');
  return abs;
}

export function lspTools(ctx: LspToolContext): Tool[] {
  const servers = () => discoverServers();
  const pick = (file: string) => serverForFile(servers(), file);

  const withClient = async (file: string, fn: (mc: ManagedClient, uri: string) => Promise<string>) => {
    const server = pick(file);
    if (!server) return { output: `no language server for ${file} (available: ${servers().map((s) => s.id).join(', ') || 'none on PATH'})`, isError: true };
    const abs = resolveFile(ctx, file);
    const mc = await clientFor(server, ctx.workspaceRoot);
    return { output: await fn(mc, fileToUri(abs)) };
  };

  return [
    {
      name: 'lsp_diagnostics',
      description: 'Get live language-server diagnostics for a file (errors/warnings). source:lsp — this is FEEDBACK, not build/test proof. Args: file (relative to workspace or absolute)',
      parameters: { type: 'object', properties: { file: { type: 'string', description: 'source file path' } }, required: ['file'] },
      async execute(args) {
        const abs = resolveFile(ctx, String(args.file ?? ''));
        const r = await withClient(String(args.file ?? ''), async (mc, uri) => {
          const diags = mc.diagnostics.get(uri) ?? [];
          return `[${mc.server.id}${mc.server.official ? '' : ' (community/unofficial)'}] ${uri}\n` + fmtDiags(diags);
        });
        return r;
      },
    },
    {
      name: 'lsp_hover',
      description: 'Hover info (types/docs) for a symbol at a position. Args: file, line (1-based), character (1-based)',
      parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['file', 'line', 'character'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const h = await mc.client.hover({ uri }, { line: Number(args.line ?? 1) - 1, character: Number(args.character ?? 1) - 1 });
          if (!h) return 'no hover info at position';
          return `[${mc.server.id}] ` + JSON.stringify(h.contents).slice(0, 800);
        });
      },
    },
    {
      name: 'lsp_definition',
      description: 'Go to definition of the symbol at a position. Args: file, line (1-based), character (1-based)',
      parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['file', 'line', 'character'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const loc = await mc.client.definition({ uri }, { line: Number(args.line ?? 1) - 1, character: Number(args.character ?? 1) - 1 });
          if (!loc) return 'no definition found';
          const list = Array.isArray(loc) ? loc : [loc];
          return `[${mc.server.id}] ` + list.slice(0, 5).map((l) => `${l.uri} L${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
        });
      },
    },
    {
      name: 'lsp_symbols',
      description: 'Document symbols (outline) for a file. Args: file',
      parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const syms = await mc.client.documentSymbols({ uri });
          const flat: string[] = [];
          const walk = (ss: typeof syms, depth: number) => {
            for (const s of ss.slice(0, 30)) {
              flat.push('  '.repeat(depth) + `${s.name} (kind ${s.kind}) L${s.range.start.line + 1}`);
              if (s.children) walk(s.children, depth + 1);
            }
          };
          walk(syms, 0);
          return `[${mc.server.id}] ${syms.length} top-level symbols\n` + (flat.join('\n') || '(none)');
        });
      },
    },
    {
      name: 'lsp_references',
      description: 'Find references to the symbol at a position. Args: file, line (1-based), character (1-based)',
      parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['file', 'line', 'character'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const refs = await mc.client.references({ uri }, { line: Number(args.line ?? 1) - 1, character: Number(args.character ?? 1) - 1 });
          return `[${mc.server.id}] ${refs.length} references\n` + refs.slice(0, 10).map((l) => `${l.uri} L${l.range.start.line + 1}`).join('\n');
        });
      },
    },
    {
      name: 'lsp_implementation',
      description: 'Find implementations of the interface/method at a position. Args: file, line (1-based), character (1-based)',
      parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['file', 'line', 'character'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const impls = await mc.client.implementation({ uri }, { line: Number(args.line ?? 1) - 1, character: Number(args.character ?? 1) - 1 });
          if (!impls) return 'no implementations found';
          const list = Array.isArray(impls) ? impls : [impls];
          return `[${mc.server.id}] ${list.length} implementations\n` + list.slice(0, 10).map((l) => `${l.uri} L${l.range.start.line + 1}`).join('\n');
        });
      },
    },
    {
      name: 'lsp_call_hierarchy',
      description: 'Who calls this symbol, and what does it call (incoming/outgoing). Args: file, line (1-based), character (1-based), direction=incoming|outgoing',
      parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' }, direction: { type: 'string', description: 'incoming (who calls this) or outgoing (what this calls)' } }, required: ['file', 'line', 'character'] },
      async execute(args) {
        return withClient(String(args.file ?? ''), async (mc, uri) => {
          const item = await mc.client.prepareCallHierarchy({ uri }, { line: Number(args.line ?? 1) - 1, character: Number(args.character ?? 1) - 1 });
          if (!item || (Array.isArray(item) && item.length === 0)) return 'no call hierarchy item at position';
          const first = Array.isArray(item) ? item[0] : item;
          const dir = String(args.direction ?? 'incoming');
          const calls = dir === 'outgoing' ? await mc.client.callHierarchyOutgoing(first) : await mc.client.callHierarchyIncoming(first);
          const label = (x: unknown) => {
            const it = x as { name?: string; uri?: string; range?: { start?: { line?: number } } };
            return `${it.name ?? 'unknown'} ${it.uri ? it.uri + ' ' : ''}L${((it.range?.start?.line ?? 0) + 1)}`;
          };
          const side = (c: { from?: unknown; to?: unknown }) => (dir === 'outgoing' ? c.to : c.from);
          return `[${mc.server.id}] ${dir} calls: ${calls.length}\n` + calls.slice(0, 10).map((c) => label(side(c as { from?: unknown; to?: unknown }))).join('\n');
        });
      },
    },
  ];
}
