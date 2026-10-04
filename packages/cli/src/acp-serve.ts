/**
 * @hmharness/cli - acp-serve (Agent Client Protocol server mode)
 *
 * Makes hmharness a FIRST-CLASS agent inside ACP hosts — BrowserOS's
 * assistant panel (Custom ACP agent), Zed, and every client that speaks
 * the 2026 ACP interop baseline. The HOST owns the chat UI; hmharness
 * stays the brain: its provider config, its tool registry (incl. the
 * browser_* family that drives BrowserOS itself), its sessions.
 *
 * Protocol: ndjson JSON-RPC 2.0 over stdio (initialize / session/new /
 * session/prompt / session/cancel + session/update notifications +
 * session/request_permission agent→client round-trip), wire shapes per
 * the official @zed-industries/agent-client-protocol reference agent.
 * stdout belongs to the protocol — every stray print goes to stderr.
 *
 * Security model (mirrors mcp-server mode):
 *   - the FULL native tool registry is available (this is hmharness's
 *     own agent, not a tool projection);
 *   - gated tools route their approval through request_permission —
 *     the host's Allow/Reject buttons ARE the approval card;
 *   - cwd comes from the host's session/new (validated, fallback to
 *     process cwd); home is HMH_HOME as always.
 */
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homeDir, loadConfig, type ChatMessage } from '@hmharness/kernel';
import { buildRegistry, runAgentTask, type RunnerEvents } from '@hmharness/agent';

/* ------------------------------------------------------------------ *
 * Host-browser window recycling (BrowserOS "workspace window" answer)
 *
 * BrowserOS assigns EVERY new ACP connection its own browsing window
 * (a workspace with a fresh new-tab). Since the host re-spawns the agent
 * per message, windows accumulate one per message — protocol-level
 * loadSession keeps the CONVERSATION continuous but cannot stop the
 * window-per-connection behavior. So we recycle: snapshot the host's
 * windows when the connection initializes, and after each turn close the
 * windows that (a) appeared since and (b) contain ONLY blank pages
 * (new-tab / about:blank). A window with real content is never touched —
 * that makes the sweep safe even if the user opened something meanwhile.
 * Uses BrowserOS's extended CDP Browser domain over the attach port.
 */

async function hostBrowserCall<T>(port: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<T> {
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) })).json()) as { webSocketDebuggerUrl: string };
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch { /* gone */ } reject(new Error('hostBrowserCall timeout')); } }, timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })), { once: true });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (settled) return;
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString()) as { id?: number; result?: T; error?: { message?: string } };
      if (m.id !== 1) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* gone */ }
      if (m.error) reject(new Error(m.error.message ?? 'host Browser domain error'));
      else resolve(m.result as T);
    });
    ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('host CDP socket error')); } }, { once: true });
  });
}

async function listHostWindows(port: number): Promise<Set<number>> {
  const r = await hostBrowserCall<{ windows?: Array<{ windowId: number }> }>(port, 'Browser.getWindows');
  return new Set((r.windows ?? []).map((w) => Number(w.windowId)).filter((n) => Number.isInteger(n)));
}

async function windowIsBlank(port: number, windowId: number): Promise<boolean> {
  const tabs = await hostBrowserCall<{ tabs?: Array<{ url?: string }> }>(port, 'Browser.getTabs', { windowId });
  const urls = (tabs.tabs ?? []).map((t) => t.url ?? '');
  return urls.length > 0 && urls.every((u) => u === 'chrome://newtab/' || u === 'about:blank' || u === '');
}

/** the windows we must NEVER touch: those holding real content */
async function listContentWindows(port: number): Promise<Set<number>> {
  const all = await listHostWindows(port);
  const content = new Set<number>();
  for (const w of all) {
    try {
      if (!(await windowIsBlank(port, w))) content.add(w);
    } catch { /* unreadable window = treat as content (safe side) */ }
  }
  return content;
}

/** close every window NOT in the protected snapshot whose tabs are ALL
 *  blank (the host's per-connection workspace windows). Protected-set
 *  windows — everything that existed when our connection initialized —
 *  are never touched. Returns how many closed; never throws. */
export async function recycleBlankWindows(port: number, protectedWindows: Set<number>): Promise<number> {
  try {
    const current = await listHostWindows(port);
    let closed = 0;
    for (const windowId of current) {
      if (protectedWindows.has(windowId)) continue;
      try {
        if (await windowIsBlank(port, windowId)) {
          await hostBrowserCall(port, 'Browser.closeWindow', { windowId });
          closed++;
        }
      } catch { /* one window failing must not stop the sweep */ }
    }
    return closed;
  } catch {
    return 0; // host unreachable / domain missing: recycle is best-effort
  }
}

/** ACP content block (we only emit/consume text blocks). */
interface TextBlock {
  type: 'text';
  text: string;
}

interface AcpSession {
  cwd: string;
  /** hmh rollout id once the first prompt ran (resume appends) */
  hmhId?: string;
  /** full transcript of the last completed turn (resume input) */
  messages?: ChatMessage[];
  abort?: AbortController;
}

export interface AcpIo {
  /** write one ndjson frame to the client */
  send(frame: unknown): void;
  /** agent→client request with a matched response */
  request(method: string, params: unknown): Promise<unknown>;
}

export interface AcpRunTaskArgs {
  prompt: string;
  cwd: string;
  sessionId?: string;
  resumeMessages?: ChatMessage[];
  signal: AbortSignal;
  events: RunnerEvents;
  approvalAsk?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export type AcpRunTask = (args: AcpRunTaskArgs) => Promise<{ text: string; turns: number; toolUses: number; sessionId: string; messages: ChatMessage[] }>;

export interface CreateAcpServerOptions {
  io: AcpIo;
  /** injectable for tests; the default wires runAgentTask */
  runTask?: AcpRunTask;
  home?: string;
  /** connection lifecycle hooks (host-window recycling etc.); never throw */
  onInitialized?: () => Promise<void>;
  onTurnSettled?: () => Promise<void>;
  /** create a persistent hmh rollout id for a NEW session (default: real
   *  Session.create; tests inject a fixed id). The ACP session id IS the
   *  hmh rollout id, so session/load reconnects straight to the rollout. */
  createRollout?: (cwd: string) => Promise<string>;
  /** load a prior rollout's transcript for session/load (default: real
   *  loadTranscript; tests may stub) */
  loadRollout?: (sessionId: string) => Promise<ChatMessage[] | undefined>;
}

/** read-ish tools render as 'read', editors as 'edit', the rest 'execute' */
function kindFor(name: string): 'read' | 'edit' | 'execute' {
  if (/^(read_file|list_dir|web_fetch|web_search|see_image|lsp_|cognitive_query|browser_snapshot|browser_read|browser_tabs|desktop_screenshot)/.test(name)) return 'read';
  if (/^(edit_file|write_file|browser_type)/.test(name)) return 'edit';
  return 'execute';
}

function titleFor(name: string, args: Record<string, unknown>): string {
  const first = ['file', 'path', 'url', 'command', 'host', 'query', 'ref'].find((k) => typeof args[k] === 'string' && args[k]);
  return first ? `${name} ${String(args[first]).slice(0, 80)}` : name;
}

/** Pure protocol core — every frame in, frames/requests out. Testable
 *  without stdio or a model. */
export function createAcpServer(opts: CreateAcpServerOptions): { handle(msg: unknown): Promise<void>; sessions: Map<string, AcpSession> } {
  const io = opts.io;
  const sessions = new Map<string, AcpSession>();
  const home = () => opts.home ?? homeDir();
  // one registry for the server's lifetime (MCP handshakes are not free);
  // rebuilt only if a build fails outright
  let registryPromise: ReturnType<typeof buildRegistry> | null = null;
  const registry = () => (registryPromise ??= buildRegistry({ mcp: true, announce: false }));
  const runTask: AcpRunTask = opts.runTask ?? (async (a) => {
    const cfg = await loadConfig();
    const { reg } = await registry();
    const r = await runAgentTask({
      task: a.prompt,
      registry: reg,
      cfg,
      ctx: { cwd: a.cwd, home: home() },
      resumeMessages: a.resumeMessages,
      sessionId: a.sessionId,
      events: a.events,
      signal: a.signal,
      ...(a.approvalAsk ? { approvalAsk: a.approvalAsk } : {}),
    });
    return { text: r.text, turns: r.turns, toolUses: r.toolUses, sessionId: r.sessionId, messages: r.messages };
  });
  const createRollout = opts.createRollout ?? (async (cwd: string) => {
    const { Session } = await import('@hmharness/kernel');
    const cfg = await loadConfig();
    return Session.create(home(), cwd, cfg.provider.model).id;
  });
  const loadRollout = opts.loadRollout ?? (async (sessionId: string) => {
    try {
      const { Session, loadTranscript } = await import('@hmharness/kernel');
      const s = await Session.resume(home(), sessionId);
      return s ? (await loadTranscript(s.file))?.messages : undefined;
    } catch {
      return undefined;
    }
  });

  const update = (sessionId: string, upd: Record<string, unknown>): void => {
    io.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: upd } });
  };

  const err = (id: unknown, code: number, message: string): void => {
    if (id === null || id === undefined) return;
    io.send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  async function handle(msg: unknown): Promise<void> {
    const m = msg as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    if (!m || typeof m.method !== 'string') return; // not a request/notification — ignore
    const isRequest = m.id !== undefined && m.id !== null;
    const ok = (result: unknown): void => {
      if (isRequest) io.send({ jsonrpc: '2.0', id: m.id, result });
    };
    switch (m.method) {
      case 'initialize': {
        // echo the client's version when present: the core surface we
        // implement (initialize/new/load/prompt/cancel/update/permission) is
        // stable across the 0.4 interop baseline and later additions are
        // optional; a hard version mismatch would just refuse to connect.
        // loadSession + sessionCapabilities: the host treats agents that
        // declare session-lifecycle capabilities (close/delete/fork/list/
        // resume — observed on the built-in claude-agent-acp) as long-lived
        // manageable sessions and REUSES the connection; without them it
        // spawns a fresh agent (and a fresh workspace WINDOW) per message —
        // the exact "a new browser window on every message" bug.
        ok({
          protocolVersion: (m.params?.protocolVersion as string) ?? '0',
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: {
              additionalDirectories: {},
              close: {},
              delete: {},
              fork: {},
              list: {},
              resume: {},
            },
            // the host hands every session a browser MCP over http (with an
            // internal lease header) — declaring we speak http MCP may be
            // what keeps it from provisioning a workspace WINDOW instead
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [],
        });
        await opts.onInitialized?.().catch(() => undefined);
        return;
      }
      case 'session/close':
      case 'session/delete': {
        const sid = m.params?.sessionId as string | undefined;
        if (sid) sessions.delete(sid);
        ok({});
        return;
      }
      case 'session/list': {
        ok({ sessions: [...sessions.keys()].map((id) => ({ sessionId: id, ...(sessions.get(id)!.hmhId ? { title: sessions.get(id)!.hmhId } : {}) })) });
        return;
      }
      case 'authenticate': {
        ok({});
        return;
      }
      case 'session/new': {
        const rawCwd = typeof m.params?.cwd === 'string' ? m.params.cwd : '';
        const cwd = isAbsolute(rawCwd) && existsSync(rawCwd) ? rawCwd : process.cwd();
        const sessionId = await createRollout(resolve(cwd));
        sessions.set(sessionId, { cwd: resolve(cwd), hmhId: sessionId });
        ok({ sessionId });
        return;
      }
      case 'session/load':
      case 'session/resume': {
        // `session/resume` is the acpx host's name for the same operation
        // (observed on the wire) — both register the prior session and
        // restore its transcript from the hmh rollout.
        const sid = typeof m.params?.sessionId === 'string' ? m.params.sessionId : '';
        if (!sid) {
          err(m.id, -32602, `${m.method} needs sessionId`);
          return;
        }
        if (!sessions.has(sid)) {
          const rawCwd = typeof m.params?.cwd === 'string' ? m.params.cwd : '';
          const cwd = isAbsolute(rawCwd) && existsSync(rawCwd) ? resolve(rawCwd) : process.cwd();
          // restore the transcript from the hmh rollout; a missing/cleaned
          // rollout still loads (the runner falls back to a fresh session)
          sessions.set(sid, { cwd, hmhId: sid, messages: await loadRollout(sid) });
        }
        ok({ sessionId: sid });
        return;
      }
      case 'session/set_mode': {
        ok({});
        return;
      }
      case 'session/cancel': {
        const sid = m.params?.sessionId as string | undefined;
        if (sid) sessions.get(sid)?.abort?.abort();
        return; // notification
      }
      case 'session/prompt': {
        const sid = m.params?.sessionId as string | undefined;
        const session = sid ? sessions.get(sid) : undefined;
        if (!session) {
          err(m.id, -32602, `unknown session ${sid ?? '(none)'}`);
          return;
        }
        if (session.abort) {
          err(m.id, -32000, 'a prompt is already running in this session');
          return;
        }
        const blocks = Array.isArray(m.params?.prompt) ? (m.params!.prompt as TextBlock[]) : [];
        const prompt = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
        if (!prompt) {
          err(m.id, -32602, 'prompt contained no text');
          return;
        }
        session.abort = new AbortController();
        let seq = 0;
        const toolIds = new Map<string, string[]>(); // name -> stack of live ids
        const cfg = await loadConfig().catch(() => undefined);
        const auto = cfg?.approval === 'auto';
        const events: RunnerEvents = {
          onDelta(kind, chunk) {
            if (!chunk) return;
            update(sid!, {
              sessionUpdate: kind === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            });
          },
          onToolCall(name, args) {
            const id = `tc_${++seq}`;
            const stack = toolIds.get(name) ?? [];
            stack.push(id);
            toolIds.set(name, stack);
            update(sid!, {
              sessionUpdate: 'tool_call',
              toolCallId: id,
              title: titleFor(name, args),
              kind: kindFor(name),
              status: 'pending',
              rawInput: args,
            });
          },
          onToolResult(name, output, isError) {
            const id = toolIds.get(name)?.pop();
            if (!id) return;
            const text = output.slice(0, 2000);
            update(sid!, {
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              status: isError ? 'failed' : 'completed',
              content: [{ type: 'content', content: { type: 'text', text } }],
              rawOutput: { text, isError },
            });
          },
        };
        const approvalAsk = auto ? undefined : async (toolName: string, args: Record<string, unknown>) => {
          try {
            const r = (await io.request('session/request_permission', {
              sessionId: sid,
              toolCall: {
                toolCallId: `perm_${++seq}`,
                title: titleFor(toolName, args),
                kind: kindFor(toolName),
                status: 'pending',
                rawInput: args,
              },
              options: [
                { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
                { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
              ],
            })) as { outcome?: { outcome?: string; optionId?: string } };
            return r?.outcome?.outcome === 'selected' && r.outcome.optionId === 'allow';
          } catch {
            return false; // host without permission UI / round-trip failed: deny
          }
        };
        try {
          const r = await runTask({
            prompt,
            cwd: session.cwd,
            sessionId: session.hmhId,
            resumeMessages: session.messages,
            signal: session.abort.signal,
            events,
            approvalAsk,
          });
          session.hmhId = r.sessionId;
          session.messages = r.messages;
          ok({ stopReason: session.abort.signal.aborted ? 'cancelled' : 'end_turn' });
        } catch (e) {
          // the turn still completes — with an honest error message in the
          // chat rather than a bare protocol error the panel can't render
          update(sid!, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[error] ${String(e instanceof Error ? e.message : e).slice(0, 400)}` } });
          ok({ stopReason: session.abort.signal.aborted ? 'cancelled' : 'end_turn' });
        } finally {
          session.abort = undefined;
          // stopReason is already out; now sweep the blank workspace windows
          // this connection caused (never blocks the protocol >8s)
          await Promise.race([opts.onTurnSettled?.().catch(() => undefined), new Promise((r) => setTimeout(r, 8_000))]);
        }
        return;
      }
      default: {
        // unknown session/* methods: answer tolerantly with {} (the host's
        // extended session vocabulary evolves; a hard -32601 made it fall
        // back to fresh-session-per-message behavior). The wire log records
        // every such call so we can implement the ones the host actually
        // uses.
        if (isRequest && m.method.startsWith('session/')) {
          ok({});
          return;
        }
        if (isRequest) err(m.id, -32601, `method not found: ${m.method}`);
      }
    }
  }

  return { handle, sessions };
}

/** Wire the protocol core to real stdio. Exits when stdin closes. */
export async function serveAcp(): Promise<void> {
  // stdout is the protocol channel: silence any library prints.
  const realLog = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  void realLog;

  // Host-browser attach: when spawned by BrowserOS's ACP host, its managed
  // CDP port is recorded in ~/.browseros/server.json — the browser_* tools
  // then drive the user's REAL tabs (their pages, their logins) instead of
  // spawning a dedicated instance (which would pop a SECOND browser window
  // next to the one the user is talking to us from). Standalone acp-serve
  // (Zed etc.) finds no marker and keeps the dedicated-instance design.
  try {
    const { readFile } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const sj = JSON.parse(await readFile(pjoin(homedir(), '.browseros', 'server.json'), 'utf8')) as { cdp_port?: number };
    if (Number.isInteger(sj.cdp_port) && (sj.cdp_port as number) > 0) process.env.HMH_BROWSER_ATTACH = String(sj.cdp_port);
  } catch { /* not under BrowserOS — standalone mode */ }

  let nextReqId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const write = (frame: unknown): void => {
    process.stdout.write(JSON.stringify(frame) + '\n');
  };
  const io: AcpIo = {
    send: write,
    request(method, params) {
      const id = nextReqId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
  };
  // window-recycling (host browser only), SNAPSHOT-based — the safe design
  // after the 2026-10-04 incident. The host opens a blank workspace window
  // for every new agent connection (per-message in practice). W0 = ALL
  // window ids at initialize time; sweeps close ONLY windows that (a) are
  // not in W0 AND (b) currently hold nothing but blank tabs. The user's own
  // windows ALWAYS predate our connection → they are in W0 → they can
  // never be closed, even mid-load (the incident's failure mode). The one
  // residual risk: a blank window the USER opens during our connection
  // lifetime — accepted, it is empty by definition. No initialize (host
  // skip) → no recycling (miss, never misfire).
  const attachPort = Number(process.env.HMH_BROWSER_ATTACH ?? 0);
  let w0Snapshot: Set<number> | null = null;
  const recycleLog = async (msg: string): Promise<void> => {
    console.error(`[acp-window] ${msg}`);
    try {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const logsDir = join(homeDir(), 'logs');
      await mkdir(logsDir, { recursive: true });
      await appendFile(join(logsDir, 'acp-window.log'), `${new Date().toISOString()} pid=${process.pid} ${msg}\n`, 'utf8');
    } catch { /* logging is best-effort */ }
  };
  const sweep = async (why: string): Promise<void> => {
    if (!w0Snapshot) return; // no initialize → no snapshot → never sweep
    const closed = await recycleBlankWindows(attachPort, w0Snapshot);
    await recycleLog(`${why}: closed=${closed} (W0=${w0Snapshot.size})`);
  };
  const recycleEnabled = process.env.HMH_BROWSER_RECYCLE !== '0' && Number.isInteger(attachPort) && attachPort > 0;
  const hooks = recycleEnabled
    ? {
        onInitialized: async () => {
          w0Snapshot = await listHostWindows(attachPort).catch(() => null);
          await recycleLog(`initialize: W0 snapshot = ${w0Snapshot?.size ?? 'unavailable'} windows`);
        },
        onTurnSettled: async () => {
          await sweep('turn-settled');
        },
      }
    : {};
  let residentTimer: ReturnType<typeof setInterval> | null = null;
  if (recycleEnabled) {
    residentTimer = setInterval(() => { void sweep('resident').catch(() => undefined); }, 2_000);
    (residentTimer as unknown as { unref?: () => void }).unref?.();
  }
  const server = createAcpServer({ io, ...hooks });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown };
    try { msg = JSON.parse(text); } catch { console.error('[acp] unparseable frame:', text.slice(0, 120)); return; }
    // full wire log (host→agent frames): the single best forensic artifact
    // for host-behavior mysteries. Truncated params keep it bounded.
    void (async () => {
      try {
        const { appendFile, mkdir } = await import('node:fs/promises');
        const logsDir = join(homeDir(), 'logs');
        await mkdir(logsDir, { recursive: true });
        const m = msg as { method?: string; id?: unknown; params?: unknown };
        const brief = m.method
          ? `${m.method} id=${String(m.id)} params=${JSON.stringify(m.params ?? {}).slice(0, 400)}`
          : `response id=${String(m.id)} ${JSON.stringify(msg).slice(0, 200)}`;
        await appendFile(join(logsDir, 'acp-wire.log'), `${new Date().toISOString()} ${brief}\n`, 'utf8');
      } catch { /* best-effort */ }
    })();
    // responses to OUR agent→client requests (permissions)
    if ((msg.id !== undefined) && !('method' in (msg as object))) {
      const entry = pending.get(Number(msg.id));
      if (entry) {
        pending.delete(Number(msg.id));
        const r = msg as { result?: unknown; error?: { message?: string } };
        if (r.error) entry.reject(new Error(r.error.message ?? 'request error'));
        else entry.resolve(r.result);
        return;
      }
    }
    void server.handle(msg).catch((e) => console.error('[acp] handler error:', e));
  });
  return new Promise<void>((resolve) => {
    rl.on('close', async () => {
      for (const [, p] of pending) p.reject(new Error('client disconnected'));
      if (residentTimer) clearInterval(residentTimer);
      // last-chance sweep: the host disposes us between messages, and the
      // workspace window it gave this connection would otherwise linger
      await Promise.race([sweep('disconnect'), new Promise((r) => setTimeout(r, 6_000))]);
      resolve();
    });
  });
}
