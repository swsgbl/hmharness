/**
 * @hmh/kernel - mcp
 * A zero-dependency MCP (Model Context Protocol) client: JSON-RPC 2.0 over
 * stdio (spawned server process) or Streamable HTTP (POST + SSE response).
 * Remote tools are projected onto the same Tool shape as native ones, so the
 * registry and loop never know where a capability came from. Borrowing the
 * 5800+-server ecosystem instead of rebuilding it is the whole point.
 */
import { spawn } from 'node:child_process';
import type { Tool } from './types.ts';

export type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; trusted?: boolean }
  | { type: 'http'; url: string; headers?: Record<string, string>; trusted?: boolean };

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'hmharness', version: '0.1.0' };

interface RpcResult {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Call-local incremental id; the wire only needs uniqueness per session. */
function nextId(): number {
  nextId.n = (nextId.n ?? 0) + 1;
  return nextId.n;
}
namespace nextId {
  export var n: number | undefined;
}

export class McpClient {
  readonly serverName: string;
  readonly config: McpServerConfig;
  private proc: ReturnType<typeof spawn> | null = null;
  private sessionId: string | null = null;
  private buffer = '';
  private stderrTail = '';
  private pending = new Map<number, { resolve: (r: RpcResult) => void; reject: (e: Error) => void }>();
  private ready = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /** initialize handshake. Must be called exactly once before use. */
  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.config.type === 'stdio') this.spawnStdio();
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs).then((r) => {
      if (r.error) throw new Error(`mcp/${this.serverName}: initialize failed: ${r.error.message}`);
    });
    // initialized is a notification (no id, no response expected)
    if (this.config.type === 'stdio') {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    } else {
      await this.notify('notifications/initialized');
    }
    this.ready = true;
  }

  /** Fire-and-forget notification over HTTP (server answers 202). */
  private async notify(method: string): Promise<void> {
    const cfg = this.config as Extract<McpServerConfig, { type: 'http' }>;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...cfg.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).catch(() => undefined);
  }

  private spawnStdio(): void {
    const cfg = this.config as Extract<McpServerConfig, { type: 'stdio' }>;
    // Allowlist, not passthrough: a spawned MCP server is third-party code;
    // it must not inherit HMH_* keys or anything else not explicitly needed.
    const SAFE_ENV = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TERM', 'NUMBER_OF_PROCESSORS'];
    const env: Record<string, string> = {};
    for (const k of SAFE_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...env, ...cfg.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onStdioChunk(chunk));
    this.proc.on('error', (err) => {
      // spawn failure (ENOENT etc.) - fail all in-flight requests loudly
      const e = new Error(`mcp/${this.serverName}: failed to start server: ${String(err)}`);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    this.proc.on('exit', (code) => {
      const detail = this.stderrTail.trim().slice(-300);
      const err = new Error(`mcp/${this.serverName}: server exited (code ${code})${detail ? `: ${detail}` : ''}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.proc.stderr!.setEncoding('utf8');
    // MCP servers are chatty on stderr by design (logging); keep only the
    // tail so a crash can be diagnosed without spamming the console.
    this.proc.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-500);
    });
  }

  private onStdioChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as RpcResult);
      } catch {
        /* non-JSON noise on stdout - ignore */
      }
    }
  }

  private onMessage(msg: RpcResult): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.resolve(msg);
    }
    // server-initiated requests/notifications are not needed yet - ignored.
  }

  /** One JSON-RPC round trip over whichever transport this server uses. */
  private async request(method: string, params: unknown, timeoutMs: number): Promise<RpcResult> {
    const id = nextId();
    const payload = { jsonrpc: '2.0' as const, id, method, ...(params !== undefined ? { params } : {}) };
    if (this.config.type === 'stdio') {
      if (!this.proc?.stdin?.writable) throw new Error(`mcp/${this.serverName}: server not connected`);
      return new Promise<RpcResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`mcp/${this.serverName}: "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.pending.set(id, {
          resolve: (r) => { clearTimeout(timer); resolve(r); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        this.proc!.stdin!.write(JSON.stringify(payload) + '\n');
      });
    }
    // Streamable HTTP: single POST; response is JSON or an SSE stream of one message.
    const cfg = this.config as Extract<McpServerConfig, { type: 'http' }>;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...cfg.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (!res.ok) throw new Error(`mcp/${this.serverName}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const ctype = res.headers.get('content-type') ?? '';
      let body: unknown;
      if (ctype.includes('text/event-stream')) {
        body = await this.firstSseMessage(res);
      } else {
        body = await res.json();
      }
      return body as RpcResult;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read an SSE body up to the first `data:` JSON message, then stop. */
  private async firstSseMessage(res: Response): Promise<unknown> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data && data !== '[DONE]') {
              await reader.cancel().catch(() => undefined);
              return JSON.parse(data);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(`mcp/${this.serverName}: SSE stream ended without a message`);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.ready) throw new Error(`mcp/${this.serverName}: not connected`);
    const r = await this.request('tools/list', {}, 20_000);
    if (r.error) throw new Error(`mcp/${this.serverName}: tools/list failed: ${r.error.message}`);
    const tools = (r.result as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools ?? [];
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ output: string; isError: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) return { output: `mcp/${this.serverName}: call failed: ${r.error.message}`, isError: true };
    const res = r.result as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    const output = text || (res.structuredContent ? JSON.stringify(res.structuredContent) : '(empty result)');
    return { output: output.length > 60_000 ? output.slice(0, 60_000) + '\n...[truncated]' : output, isError: res.isError === true };
  }

  close(): void {
    for (const p of this.pending.values()) p.reject(new Error(`mcp/${this.serverName}: closed`));
    this.pending.clear();
    this.proc?.kill();
    this.proc = null;
  }
}

/** OpenAI function-name charset; MCP allows dots/dashes which it forbids. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Connect + list + project. Separate from projectMcpTools so callers can
 * distinguish "server down" from "server has no tools".
 */
export async function mcpServerTools(
  serverName: string,
  config: McpServerConfig,
): Promise<{ client: McpClient; tools: Tool[] }> {
  const client = new McpClient(serverName, config);
  await client.connect();
  const remote = await client.listTools();
  const trusted = 'trusted' in config && config.trusted === true;
  const tools: Tool[] = remote.map((t) => {
    const localName = `mcp_${sanitizeToolName(serverName)}_${sanitizeToolName(t.name)}`.slice(0, 60);
    const remoteName = t.name;
    return {
      name: localName,
      description: `[mcp:${serverName}] ${t.description ?? t.name}`.slice(0, 400),
      parameters: normalizeSchema(t.inputSchema),
      needsApproval: trusted ? undefined : () => true,
      async execute(args) {
        return client.callTool(remoteName, args);
      },
    };
  });
  return { client, tools };
}

/** MCP inputSchema is already JSON-Schema; coerce loosely, never throw. */
function normalizeSchema(schema: unknown): { type: string; properties?: Record<string, unknown>; required?: string[] } {
  if (schema && typeof schema === 'object') {
    const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    return {
      type: s.type ?? 'object',
      ...(s.properties ? { properties: s.properties } : {}),
      ...(s.required ? { required: s.required } : {}),
    };
  }
  return { type: 'object' };
}
