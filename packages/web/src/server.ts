/**
 * @hmharness/web - server
 * Local web frontend for hmharness: node:http only, zero runtime deps.
 * One task runs at a time; its events stream to every connected browser
 * via SSE; the approval gate is bridged to the page (request -> human
 * clicks -> decision resolves the kernel's ask()). Binds 127.0.0.1 only -
 * this is a local companion, never exposed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, rename, mkdir, writeFile, stat, open, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, basename, isAbsolute, resolve, dirname } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  homeDir, isBareProbe, loadConfig, loadTranscript, resolveProvider, listProviders, setChatRoute,
  setLocale, addProviders, detectLocalProviders, chatVision, visionProviderChain, isVisionRefusal,
  saveProvider, deleteProvider, patchConfig, getGoal, setGoal, isProviderAuthError,
  findSessionFile, listSessions, exportSessionMarkdown, PROVIDER_PRESETS, type ChatMessage, type HmhConfig,
} from '@hmharness/kernel';
import { listDrafts, listSkills, readInsights, labelableSessions, labelSession, readLabels } from '@hmharness/evolution';
import { buildRegistry, runAgentTask } from '@hmharness/agent';
import { PAGE } from './page.ts';
import { tunnel, isInternetTunnelHost, type TunnelState } from './tunnel.ts';
import {
  insideRoot, toRel, fuzzyScore, parseImageDataUrl, buildAttachmentsPrefix, buildImagePrefix,
  isBinaryHead, SKIP_DIRS, MAX_SEARCH_DEPTH, MAX_SEARCH_ENTRIES, MAX_SEARCH_RESULTS, type SearchHit,
} from './fs-utils.ts';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/* ---- mobile pairing (2026-09-28, deepseek-harness Desktop pattern) ----
   The phone proves itself ONCE with a QR-borne one-time token (5-min TTL),
   then holds a session cookie; on WiFi the paired LAN IP also stays trusted
   (same-network position). The long-term cfg.web.token (?key=) remains as a
   power-user fallback. Internet mode relays through a free tunnel
   (cloudflared Quick Tunnel / pinggy) so no firewall or port-forward config
   is ever needed from ANY network. */
const PAIRING_TTL_MS = 5 * 60_000;
const MOBILE_COOKIE = 'hmh_mobile';
interface MobileSession { cookie: string; remote: string; at: number }
const mobileSessions = new Map<string, MobileSession>(); // cookie -> session
const trustedLanIps = new Set<string>(); // DSH-style LAN position trust
let pairToken = '';
let pairExpiresAt = 0;
let pairPin = '';

function rotatePairing(): void {
  pairToken = randomBytes(32).toString('base64url');
  pairPin = String(100000 + Math.floor(Math.random() * 900000));
  pairExpiresAt = Date.now() + PAIRING_TTL_MS;
}
function pairingValid(): boolean {
  return Boolean(pairToken && pairExpiresAt >= Date.now());
}
function safeEqual(a: string, b: string): boolean {
  const l = Buffer.from(a);
  const r = Buffer.from(b);
  return l.length === r.length && timingSafeEqual(l, r);
}
function cookieValue(req: IncomingMessage, name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m?.[1] ?? '';
}
function transportIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}
const isRfc1918 = (a: string) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);

/** The LAN address a phone on the same WiFi can actually reach. Enumerating
   os.networkInterfaces() naively grabs the FIRST IPv4 — on machines with
   Tailscale/VMware/WSL that is a virtual adapter the phone cannot route to
   (the 2026-09-28 "QR scans but page won't load" bug: we QR'd the Tailscale
   100.x address). Prefer real physical adapters, RFC1918 only. */
function preferredLanAddress(): string {
  const VIRTUAL = /vmware|virtual|hyper-?v|vethernet|wsl|tailscale|loopback|bluetooth|vbox|docker|tap-|pseudo/i;
  let fallback = '';
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal || !isRfc1918(n.address)) continue;
      if (!VIRTUAL.test(name)) return n.address;
      if (!fallback) fallback = n.address;
    }
  }
  return fallback;
}
function requestIsFromLoopbackTransport(req: IncomingMessage): boolean {
  const ip = transportIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}
/** tunnel requests arrive from the LOCAL cloudflared process (loopback
   transport) but carry the public tunnel Host — detect like DSH does. */
function requestConnectionMode(req: IncomingMessage): 'lan' | 'tunnel' {
  const host = (req.headers.host ?? '').split(':', 1)[0]?.toLowerCase() ?? '';
  if (!requestIsFromLoopbackTransport(req)) return 'lan';
  return isInternetTunnelHost(host) ? 'tunnel' : 'lan';
}
function mobileAuthorized(req: IncomingMessage): boolean {
  const cookie = cookieValue(req, MOBILE_COOKIE);
  if (cookie && mobileSessions.has(cookie)) return true;
  if (requestConnectionMode(req) === 'lan' && trustedLanIps.has(transportIp(req))) return true;
  return false;
}
function issueMobileCookie(res: ServerResponse, remote: string): void {
  const cookie = randomBytes(32).toString('base64url');
  mobileSessions.set(cookie, { cookie, remote, at: Date.now() });
  if (mobileSessions.size > 16) mobileSessions.delete(mobileSessions.keys().next().value as string);
  if (requestConnectionMode(res.req as IncomingMessage) === 'lan' && remote && isRfc1918(remote)) {
    trustedLanIps.add(remote);
    if (trustedLanIps.size > 32) trustedLanIps.delete(trustedLanIps.values().next().value as string);
  }
  persistMobileSessions();
  res.setHeader('set-cookie', `${MOBILE_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}
/** Paired phones survive a server restart (no re-scan): the session store
    lives next to config.json. Restarted with a fresh process otherwise. */
function persistMobileSessions(): void {
  try {
    const file = join(homeDir(), 'web-mobile.json');
    const rows = [...mobileSessions.values()].map((s) => ({ cookie: s.cookie, remote: s.remote, at: s.at }));
    void writeFile(file, JSON.stringify(rows, null, 2), 'utf8').catch(() => undefined);
  } catch { /* best-effort */ }
}
async function loadMobileSessions(): Promise<void> {
  try {
    const file = join(homeDir(), 'web-mobile.json');
    const rows = JSON.parse(await readFile(file, 'utf8')) as Array<{ cookie: string; remote: string; at: number }>;
    for (const r of rows ?? []) {
      if (typeof r.cookie === 'string' && r.cookie.length >= 32) {
        mobileSessions.set(r.cookie, { cookie: r.cookie, remote: String(r.remote ?? ''), at: Number(r.at) || Date.now() });
        if (isRfc1918(r.remote)) trustedLanIps.add(r.remote);
      }
    }
  } catch { /* absent/corrupt file: start clean */ }
}
/** CSRF guard for pairing POSTs (DSH verifyTrustedOrigin pattern). */
function sameOriginOk(req: IncomingMessage): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try { if (new URL(String(origin)).host !== host) return false; } catch { return false; }
  }
  return true;
}
const pinFailures = new Map<string, { n: number; until: number }>();
function pinRateLimited(ip: string): number {
  const f = pinFailures.get(ip);
  if (!f) return 0;
  return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function recordPinFailure(ip: string): void {
  const f = pinFailures.get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 3) { f.until = Date.now() + 60_000; f.n = 0; }
  pinFailures.set(ip, f);
}

/** Phone-side PIN entry page (internet pairing only; minimal, self-contained). */
const PIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>配对 hmh</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#141416;color:#f5f5f6;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{width:100%;max-width:320px;padding:28px 24px;text-align:center}
h1{font-size:18px;margin:0 0 6px}
p{color:#95979d;font-size:13px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:12px;font:24px/1 monospace;letter-spacing:8px;text-align:center;border-radius:10px;border:1px solid #33353a;background:#1e2024;color:#f5f5f6;outline:none}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#2f81f7;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
#st{margin-top:12px;font-size:12px;color:#95979d;min-height:18px}
.err{color:#f85149}
</style></head><body><div class="card"><h1>输入配对密码</h1>
<p>密码显示在电脑上的配对窗口中（6 位数字）</p>
<input id="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" autofocus>
<button onclick="go()">连接</button><div id="st"></div>
<script>
var st=document.getElementById('st');
document.getElementById('pin').addEventListener('keydown',function(e){if(e.key==='Enter')go()});
async function go(){
  var pin=document.getElementById('pin').value.trim();
  if(pin.length!==6){st.className='err';st.textContent='请输入 6 位密码';return}
  st.className='';st.textContent='正在验证…';
  try{
    var r=await fetch('/pair/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin})});
    var j=await r.json();
    if(j.ok){st.textContent='配对成功，正在进入…';location.href='/';return}
    st.className='err';st.textContent=j.error||'验证失败';
    if(j.rescan)st.textContent='二维码已过期，请在电脑上重新扫码';
  }catch(e){st.className='err';st.textContent='网络异常，请重试'}
}
</script></div></body></html>`;

/** Version of THIS serving process's code. The CLI's version-aware daemon
 *  check compares the SERVED value against its own instead of trusting the
 *  pid/version FILES — a file can be overwritten by a spawn that died on
 *  EADDRINUSE while an older listener keeps the port (the stale-daemon
 *  class of bugs, 0.6.4 lesson; the file-based check lied in the field). */
const DAEMON_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version as string; } catch { return ''; }
})();

/** cfg fields the web settings center manages but HmhConfig does not (yet)
 *  declare (theme). Cast locally instead of widening the kernel contract. */
type WebCfg = HmhConfig & { theme?: 'dark' | 'light' | 'system' };

/** /help text for the web subset - one command per line, zh/en short. */
const COMMAND_HELP = [
  '/help — 命令清单 / command list',
  '/tools — 列出工具 / list tools',
  '/skills — 列出技能 / list skills',
  '/model — 列出模型路由；/model <name> 切换 / list routes; /model <name> switches',
  '/lang [zh|en] — 切换语言 / switch UI language',
  '/yolo [on|off] — 自动批准开关 / toggle auto-approve',
  '/providers — 检测可用 provider；/providers scan 合并 / detect; scan merges',
  '/mcp — MCP 服务器列表 / list MCP servers',
  '/ops — HarmonyOS 环境体检；/ops scan 雷达扫描 / env check; scan',
  '/status — 一行状态 / one-line status',
  '/resume — 回看会话 / resume a session',
  '/web — 本 UI 地址 / this UI',
  '/exit — 退出提示 / how to exit',
].join('\n');

interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
  resolve(granted: boolean): void;
  timer: NodeJS.Timeout;
}

interface WsItem {
  id: string;
  name: string;
  path: string;
}

async function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('body too large');
  }
  return data;
}

/** 组合式生命周期句柄:HMH Desktop 的 host supervisor 消费(2026-10-09)。
 *  port 是实际绑定端口(port 0 时为 OS 分配值);close() 幂等。 */
export interface WebServerHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

export async function startServer(opts: {
  port: number;
  host?: string;
  version?: string;
  /** 桌面桥模式(HMH Desktop ADR-003 同款合同):强制 loopback 信任 +
   *  全 API 校验高熵 token + stdout 引导行 + /api/desktop/shutdown。
   *  token 只经环境变量传递,绝不进 URL/日志。 */
  desktop?: { token: string };
}): Promise<WebServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const desktop = opts.desktop;
  // the version the CLI spawns us with (the daemon's code snapshot); used by
  // the version-aware staleness check. Absent (foreground debug) -> the web
  // package's own version, which is never equal to the CLI's, so foreground
  // servers always read as "fresh" only when the CLI passes its version.
  const daemonVersion = opts.version ?? DAEMON_VERSION;
  const home = homeDir();
  const cfg = await loadConfig();
  await loadMobileSessions();
  const { reg, clients } = await buildRegistry();

  // ---- W15: per-session independent execution (dsh parity) ----
  // Every session runs its tasks in a CHILD PROCESS (task-runner.ts): real
  // cwd isolation (no global chdir), crash containment, daemon death does
  // not kill the run. busy/queue/approval/inject/breaker are ALL per
  // session now; the old global single slot is gone.
  interface QueuedItem { text: string; mode: string; yes: boolean; fresh: boolean; sessionId?: string }
  interface SessionExec {
    busy: boolean;
    queue: QueuedItem[];
    proc: import('node:child_process').ChildProcess | null;
    stdin: import('node:stream').Writable | null;
    pending: (PendingApproval & { id: number }) | null;
    authError: boolean;
  }
  const executors = new Map<string, SessionExec>();
  const execFor = (sid: string): SessionExec => {
    let e = executors.get(sid);
    if (!e) {
      e = { busy: false, queue: [], proc: null, stdin: null, pending: null, authError: false };
      executors.set(sid, e);
    }
    return e;
  };
  const anyBusy = () => [...executors.values()].some((e) => e.busy);
  const allQueued = () => [...executors.values()].flatMap((e) => e.queue.map((q) => ({ ...q, owner: e })));
  let activeSessionId = '';
  const sseClients = new Set<ServerResponse>();
  // queue persistence (survives daemon death): per-session pending items
  const queueFile = join(home, 'web-queues.json');
  const saveQueues = () =>
    writeFile(queueFile, JSON.stringify([...executors.entries()].map(([sid, e]) => ({ sid, queue: e.queue }))), 'utf8')
      .catch(() => { /* best effort */ });
  // 2026-09-28 deepseek-harness semantics transplant: every session is an
  // INDEPENDENT thread. The old single global `conversation` meant viewing a
  // history session and following up corrupted the live thread, and outputs
  // from one thread leaked into another. Threads are keyed by the client's
  // session id; a history session resumes its own rollout transcript.
  interface SessionThread { conversation: ChatMessage[]; cwd: string; rolloutId?: string }
  const sessionThreads = new Map<string, SessionThread>();
  const threadFor = (id: string): SessionThread => {
    let t = sessionThreads.get(id);
    if (!t) {
      t = { conversation: [], cwd: wsRoot() };
      sessionThreads.set(id, t);
    }
    return t;
  };
  const threadCap = 40;
  if (sessionThreads.size > threadCap) {
    // bound memory: drop the oldest non-active threads (history is durable on disk)
    for (const k of sessionThreads.keys()) {
      if (sessionThreads.size <= threadCap) break;
      if (k !== activeSessionId) sessionThreads.delete(k);
    }
  }

  // ---- workspaces: the agent's project contexts ----
  // A workspace is a project directory; switching one chdirs the server so
  // every task (and its session audit cwd) runs inside that project, and the
  // sidebar groups sessions by workspace path.
  let wsItems: WsItem[] = [];
  let wsCurrent = '';
  const wsFile = join(home, 'workspaces.json');
  const saveWorkspaces = () =>
    writeFile(wsFile, JSON.stringify({ current: wsCurrent, items: wsItems }, null, 2), 'utf8');
  const currentWs = (): WsItem | undefined => wsItems.find((w) => w.id === wsCurrent);
  // workspace file surface: search/read/attachments all resolve against the
  // active workspace (or the server cwd when none is selected)
  const wsRoot = () => currentWs()?.path ?? process.cwd();
  const insideWs = (p: string) => insideRoot(wsRoot(), p);
  try {
    const d = JSON.parse(await readFile(wsFile, 'utf8')) as { current?: string; items?: WsItem[] };
    wsItems = Array.isArray(d.items) ? d.items : [];
    wsCurrent = typeof d.current === 'string' ? d.current : '';
  } catch {
    wsItems = [];
    wsCurrent = '';
  }
  if (!wsItems.length) {
    wsItems = [{ id: `ws-${Math.random().toString(36).slice(2, 8)}`, name: basename(process.cwd()) || 'workspace', path: process.cwd() }];
    wsCurrent = wsItems[0].id;
    await saveWorkspaces();
  }
  if (!wsItems.some((w) => w.id === wsCurrent)) wsCurrent = wsItems[0].id;
  {
    const cur = currentWs();
    if (cur) {
      try {
        process.chdir(cur.path);
      } catch {
        /* recorded directory vanished; keep server cwd */
      }
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  // monotonic SSE event sequence (docx P1 #2 reconnect): every event carries
  // an id; a reconnecting browser sends Last-Event-ID and we replay nothing
  // older than it (frontend also dedups by id as belt-and-braces)
  let sseSeq = 0;
  const sseSend = (res: ServerResponse, event: string, data: unknown) => {
    const id = ++sseSeq;
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // keep a short replay ring so a reconnect can catch up missed events
    sseRing.push({ id, event, data });
    if (sseRing.length > 200) sseRing.splice(0, sseRing.length - 200);
  };
  const sseRing: Array<{ id: number; event: string; data: unknown }> = [];

  // ---- desktop bridge envelopes (2026-10-10, HMH Desktop 阶段E) ----
  // desktop 模式下,run 生命周期事件同时以 EventEnvelope 形状发出
  // (event: hmh;schemaVersion/eventId/sessionId/runId/seq/occurredAt/kind),
  // 与既有事件名并存迁移。高频 line/delta 不是 run 生命周期,不造假映射,
  // 继续只走原事件名。信封同样进 sseRing → Last-Event-ID 断线补拉生效。
  const envSeqByRun = new Map<string, number>();
  const sendEnvelope = (
    sessionId: string,
    runId: string,
    kind: 'run.started' | 'tool.started' | 'tool.completed' | 'approval.required' | 'artifact.created' | 'run.completed' | 'run.failed',
    payload: Record<string, unknown>,
  ): void => {
    if (!desktop) return;
    const key = `${sessionId}\0${runId}`;
    const seq = (envSeqByRun.get(key) ?? 0) + 1;
    envSeqByRun.set(key, seq);
    if (envSeqByRun.size > 500) envSeqByRun.delete(envSeqByRun.keys().next().value as string);
    for (const res of sseClients) {
      sseSend(res, 'hmh', {
        schemaVersion: 1,
        eventId: randomUUID(),
        sessionId,
        runId,
        seq,
        occurredAt: new Date().toISOString(),
        kind,
        payload,
      });
    }
  };
  const preview = (v: unknown, max = 2000): string => {
    try { return JSON.stringify(v ?? {}).slice(0, max); } catch { return String(v).slice(0, max); }
  };
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  /** 只读收集一个目录的 git 变更(status --porcelain + diff --stat)。
   *  供 /api/diff(Diff 面板)与 desktop 桥的 artifact.created(交付物)共用;
   *  非 git 目录返回 {git:false},永不写状态。 */
  const collectGitChanges = async (cwd: string): Promise<{ git: boolean; changed: Array<{ state: string; path: string }>; stat: string }> => {
    const run = (args: string[]): Promise<{ ok: boolean; out: string }> =>
      new Promise((resolve) => {
        execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeout: 8_000, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout) => {
          if (err || typeof stdout !== 'string') resolve({ ok: false, out: '' });
          else resolve({ ok: true, out: stdout });
        });
      });
    const status = await run(['status', '--porcelain']);
    if (!status.ok) return { git: false, changed: [], stat: '' };
    const stat = await run(['diff', 'HEAD', '--stat']);
    const changed = status.out.split(/\r?\n/).filter((l) => l.trim()).slice(0, 400)
      .map((l) => ({ state: l.slice(0, 2).trim(), path: l.slice(3) }));
    return { git: true, changed, stat: stat.out.slice(0, 8_000) };
  };

  const broadcast = (event: string, data: unknown) => {
    for (const r of sseClients) sseSend(r, event, data);
  };
  const broadcastQueue = () => {
    // per-session queue event (the multi-session views key on it) + the
    // legacy flat view (concatenated) for the single-bar fallback
    for (const [sid, e] of executors) broadcast('queue', { sessionId: sid, items: e.queue.map((t) => t.text) });
    broadcast('queue', { items: allQueued().map((t) => t.text) });
  };

  /** Spawn the per-session child executor (W15). The child relays runner
   *  events as ndjson on stdout; steering (inject/abort/approvals) flows
   *  back over its stdin. The daemon never runs agent code in-process
   *  anymore - a runaway task cannot take the UI down, and a daemon crash
   *  leaves the child free to finish (the rollout is durable either way). */
  const runOne = async (item: QueuedItem, fromQueue = false): Promise<void> => {
    const sid = item.sessionId || `web-${Date.now().toString(36)}`;
    const exec = execFor(sid);
    exec.busy = true;
    exec.authError = false; // fresh latch per task attempt
    activeSessionId = sid;
    const thread = threadFor(sid);
    // history-session follow-up: adopt that rollout's transcript + cwd as the
    // thread, so "continue chatting in an old session" is a REAL resume
    if (!thread.rolloutId && !item.fresh) {
      try {
        const file = await findSessionFile(home, sid);
        if (file) {
          const tr = await loadTranscript(file);
          if (tr) {
            thread.conversation = tr.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
            thread.rolloutId = tr.id ?? sid;
            if (tr.cwd) thread.cwd = tr.cwd;
          }
        }
      } catch { /* not a known rollout - fresh thread */ }
    }
    const resume = item.fresh ? [] : thread.conversation;
    // desktop envelope run id: one per task attempt (restart-safe: a retried
    // task is a NEW run; the desktop EventStore keys dedup by eventId anyway)
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    broadcast('busy', { busy: true, task: item.text, mode: item.mode, fromQueue, sessionId: sid, cwd: thread.cwd, runId });
    sendEnvelope(sid, runId, 'run.started', { task: item.text, mode: item.mode });

    const { spawn } = await import('node:child_process');
    const { createInterface: rlCreate } = await import('node:readline');
    const { writeFile: wf, rm: rmf } = await import('node:fs/promises');
    // dist build: <web>/dist/task-runner.js sits next to server.js; source
    // runs (tsx): fall back to task-runner.ts through the tsx loader,
    // resolved to an ABSOLUTE file URL - the child's cwd is the session's
    // project dir, where a bare 'tsx' specifier would not resolve
    const here = import.meta.dirname ?? '.';
    const runnerJs = join(here, 'task-runner.js');
    const runnerTs = join(here, 'task-runner.ts');
    const useTs = !existsSync(runnerJs);
    let runnerArgs: string[];
    if (useTs) {
      const req = createRequire(import.meta.url);
      const { pathToFileURL } = await import('node:url');
      runnerArgs = ['--import', pathToFileURL(req.resolve('tsx')).href, runnerTs];
    } else {
      runnerArgs = [runnerJs];
    }
    const payloadFile = join((await import('node:os')).tmpdir(), `hmh-task-${process.pid}-${Date.now().toString(36)}.json`);
    try {
      await wf(payloadFile, JSON.stringify({
        task: item.text,
        mode: item.mode,
        yes: item.yes,
        fresh: item.fresh,
        sessionId: item.fresh ? sid : thread.rolloutId ?? sid,
        cwd: thread.cwd,
        home,
        resumeMessages: resume,
        goal: item.fresh ? undefined : await getGoal(home, thread.rolloutId ?? sid),
      }), 'utf8');
    } catch (err) {
      broadcast('error', { message: 'payload write failed: ' + String(err).slice(0, 200), sessionId: sid });
      exec.busy = false;
      broadcast('busy', { busy: false, sessionId: sid });
      return;
    }

    const child = spawn(process.execPath, [...runnerArgs, payloadFile], {
      cwd: thread.cwd,
      env: { ...process.env, HMH_HOME: home },
      windowsHide: true,
      detached: true, // survives a daemon crash; the rollout keeps the record
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.unref();
    exec.proc = child;
    exec.stdin = child.stdin;

    const relay = (ev: Record<string, unknown>) => {
      const kind = String(ev.kind ?? '');
      if (kind === 'line') broadcast('line', { text: ev.text, sessionId: sid });
      else if (kind === 'delta') broadcast('delta', { kind: ev.k, chunk: ev.chunk, sessionId: sid });
      else if (kind === 'tool') {
        broadcast('tool', { name: ev.name, args: ev.args, sessionId: sid });
        sendEnvelope(sid, runId, 'tool.started', { name: String(ev.name ?? ''), argsPreview: preview(ev.args) });
      }
      else if (kind === 'toolResult') {
        broadcast('toolResult', { name: ev.name, isError: ev.isError === true, preview: String(ev.output ?? '').slice(0, 300), full: String(ev.output ?? '').slice(0, 8000), sessionId: sid });
        sendEnvelope(sid, runId, 'tool.completed', { name: String(ev.name ?? ''), isError: ev.isError === true, outputPreview: String(ev.output ?? '').slice(0, 2000) });
      }
      else if (kind === 'injected') broadcast('injected', { text: ev.text, sessionId: sid });
      else if (kind === 'approvalDone') broadcast('approvalDone', { name: ev.name, args: ev.args, granted: ev.granted === true, sessionId: sid });
      else if (kind === 'approvalReq') {
        const id = Number(ev.id ?? 0);
        const send = (granted: boolean) => {
          try { exec.stdin?.write(JSON.stringify({ type: 'approval', id, granted }) + '\n'); } catch { /* gone */ }
        };
        const timer = setTimeout(() => {
          if (exec.pending?.id === id) exec.pending = null;
          broadcast('approvalDone', { name: ev.name, granted: false, timeout: true, sessionId: sid });
          send(false);
        }, APPROVAL_TIMEOUT_MS);
        exec.pending = { name: String(ev.name ?? ''), args: ev.args as Record<string, unknown>, resolve: send, timer, id };
        broadcast('approvalReq', { name: ev.name, args: ev.args, sessionId: sid });
        sendEnvelope(sid, runId, 'approval.required', {
          approvalId: String(id),
          tool: String(ev.name ?? ''),
          argsPreview: preview(ev.args),
          risk: `执行工具 ${String(ev.name ?? '')}(参数见上);批准后由 runtime 在沙箱内执行`,
        });
      } else if (kind === 'final') {
        sawFinal = true;
        const msgs = (ev.messages ?? []) as ChatMessage[];
        thread.conversation = msgs.length
          ? msgs
          : [...resume, { role: 'user', content: item.text }];
        thread.rolloutId = String(ev.sessionId ?? sid);
        broadcast('final', {
          text: ev.text, sessionId: sid, runId, turns: ev.turns, toolUses: ev.toolUses, usage: ev.usage,
          turnsInThread: Math.floor(thread.conversation.length / 2),
        });
        // desktop 桥:交付物先于终态(artifact.created ← 任务在会话 cwd 留下的
        // git 变更;Desktop 的终态不回退规则保证 completed 不被拉回 running)
        if (desktop) {
          const done = async (): Promise<void> => {
            try {
              const changes = await collectGitChanges(thread.cwd);
              for (const c of changes.changed.slice(0, 50)) {
                sendEnvelope(sid, runId, 'artifact.created', {
                  artifact: { relPath: c.path, kind: 'file', title: c.path },
                });
              }
            } catch { /* git 不可用:跳过交付物,不影响终态 */ }
            sendEnvelope(sid, runId, 'run.completed', {
              text: String(ev.text ?? ''),
              turns: Number(ev.turns ?? 0),
              toolUses: Number(ev.toolUses ?? 0),
              ...(isRecord(ev.usage) ? { usage: ev.usage as Record<string, number> } : {}),
            });
          };
          void done();
        } else {
          sendEnvelope(sid, runId, 'run.completed', {
            text: String(ev.text ?? ''),
            turns: Number(ev.turns ?? 0),
            toolUses: Number(ev.toolUses ?? 0),
            ...(isRecord(ev.usage) ? { usage: ev.usage as Record<string, number> } : {}),
          });
        }
      } else if (kind === 'error') {
        exec.authError = isProviderAuthError(String(ev.error ?? ''));
        broadcast('error', { message: String(ev.error ?? '').slice(0, 400), sessionId: sid });
        // task-level failure → run.failed;the 6 bridge codes are reused
        // (provider auth/balance → AUTH_FAILED, anything else → RUNTIME_CRASHED)
        sendEnvelope(sid, runId, 'run.failed', {
          error: {
            code: exec.authError ? 'AUTH_FAILED' : 'RUNTIME_CRASHED',
            message: String(ev.error ?? '').slice(0, 400),
            retryable: !exec.authError,
          },
        });
      }
    };

    const out = rlCreate({ input: child.stdout! });
    out.on('line', (line) => {
      if (!line.trim()) return;
      try { relay(JSON.parse(line) as Record<string, unknown>); } catch { /* malformed line: skip */ }
    });
    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-600); });

    let sawFinal = false; // relay('final') sets it; child exit without it = crashed run
    const finish = async (code: number) => {
      if (exec.pending) { clearTimeout(exec.pending.timer); exec.pending = null; }
      exec.busy = false;
      exec.proc = null;
      exec.stdin = null;
      if (code !== 0 && !sawFinal) {
        const msg = stderrTail.trim() ? 'task child exit ' + code + ': ' + stderrTail.trim().slice(0, 300) : 'task child exit ' + code;
        broadcast('error', { message: msg, sessionId: sid });
        // no final event ever arrived: the desktop reducer would sit in
        // 'running' forever - close the run envelope explicitly
        sendEnvelope(sid, runId, 'run.failed', {
          error: { code: 'RUNTIME_CRASHED', message: msg, retryable: true },
        });
      }
      broadcast('busy', { busy: false, sessionId: sid });
      broadcast('state', await stateObject());
      pumpSession(sid);
    };
    child.on('exit', (code) => { void finish(code ?? -1); });
    child.on('error', (err) => {
      broadcast('error', { message: 'spawn failed: ' + String(err).slice(0, 300), sessionId: sid });
      void rmf(payloadFile, { force: true }).catch(() => {});
      void finish(-1);
    });
  };

  /** Per-session pump: after a task lands (or dies), the NEXT queued item of
   *  THAT session starts. Other sessions never waited on this one - that is
   *  the whole point of W15. Circuit breaker (T24) is per session. */
  const pumpSession = (sid: string): void => {
    const exec = execFor(sid);
    if (exec.busy || exec.queue.length === 0) { saveQueues(); return; }
    if (exec.authError) {
      broadcast('line', { text: `⛔ provider auth/balance error - session queue held (${exec.queue.length} task(s)); fix the key/balance or switch provider, then resubmit`, sessionId: sid });
      broadcastQueue();
      saveQueues();
      return;
    }
    const next = exec.queue.shift();
    if (!next) { saveQueues(); return; }
    broadcastQueue();
    saveQueues();
    void runOne(next, true);
  };

  // restore queues persisted before a daemon death (W15 self-healing): a
  // queued item never started, so resuming it cannot double-run anything
  try {
    const restored = JSON.parse(await readFile(queueFile, 'utf8')) as Array<{ sid?: unknown; queue?: unknown }>;
    let n = 0;
    for (const r of restored) {
      if (typeof r.sid !== 'string' || !Array.isArray(r.queue)) continue;
      const exec = execFor(r.sid);
      for (const q of r.queue) {
        if (q && typeof (q as QueuedItem).text === 'string') { exec.queue.push(q as QueuedItem); n++; }
      }
    }
    if (n > 0) {
      broadcast('line', { text: `⟲ ${n} 个排队任务已从上次守护退出中恢复，即将继续`, sessionId: '' });
      broadcastQueue();
      for (const sid of executors.keys()) pumpSession(sid);
    }
    await rm(join(home, 'web-queues.json'), { force: true }).catch(() => {});
  } catch { /* no persisted queues */ }


  const stateObject = async () => {
    const [active, drafts, insights] = await Promise.all([listSkills(home), listDrafts(home), readInsights(home, 8)]);
    let evolution: Array<Record<string, unknown>> = [];
    try {
      evolution = (await readFile(join(home, 'evolution', 'log.jsonl'), 'utf8'))
        .trim().split('\n').filter(Boolean).slice(-3)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      /* no evolution history yet */
    }
    return {
      model: resolveProvider(cfg, 'chat').model,
      home,
      locale: cfg.locale ?? 'zh',
      busy: anyBusy(),
      busySessions: [...executors.entries()].filter(([, e]) => e.busy).map(([sid]) => sid),
      approvalPending: [...executors.values()].some((e) => e.pending !== null),
      queue: allQueued().map((t) => t.text),
      // the session whose task is currently running (or last ran) - the web
      // topbar follows THIS, not the global workspace, when showing status
      activeSessionId,
      activeThreadCwd: activeSessionId ? sessionThreads.get(activeSessionId)?.cwd ?? '' : '',
      exposure,
      workspace: currentWs() ?? null,
      daemonVersion,
      providers: listProviders(cfg).map((p) => ({ name: p.name, model: p.model, purposes: p.purposes })),
      sshHosts: Object.entries(cfg.sshHosts ?? {}).map(([name, h]) => ({ name, host: h.host, user: h.user, port: h.port ?? 22 })),
      providerPresets: PROVIDER_PRESETS
        .filter((p) => !cfg.providers?.[p.name])
        .map((p) => ({ name: p.name, model: p.model, envVar: p.envVar, local: p.envVar === '' })),
      skills: {
        active: active.map((s) => ({ name: s.name, description: s.description })),
        drafts: drafts.map((s) => ({ name: s.name, description: s.description })),
      },
      insights: insights.map((i) => ({ time: i.time, task: i.task, outcome: i.outcome, tools: i.toolsUsed })),
      evolution,
      // settings center snapshot: defaults mirror the kernel's documented ones
      settings: {
        approval: cfg.approval ?? 'ask',
        autoEvolveEvery: cfg.autoEvolveEvery ?? 3,
        autoPatch: cfg.evolution?.autoPatch ?? false,
        theme: (cfg as WebCfg).theme ?? 'dark',
      },
      // provider detail for the settings UI. apiKey NEVER leaves the server:
      // only presence + last-4 tail are exposed (a tail is a secret to no one
      // but enough for the user to recognize which key is configured).
      providersDetail: listProviders(cfg).map((p) => {
        const raw = cfg.providers?.[p.name];
        // the fallback 'default' row is backed by cfg.provider, not providers[]
        const key = raw?.apiKey ?? (p.name === 'default' ? cfg.provider.apiKey : undefined);
        return {
          name: p.name,
          model: p.model,
          baseUrl: p.baseUrl,
          authHeader: raw?.authHeader,
          supportsVision: raw?.supportsVision,
          timeoutMs: raw?.timeoutMs,
          contextWindow: raw?.contextWindow,
          hasKey: Boolean(key),
          keyTail: key && key.length >= 4 ? key.slice(-4) : undefined,
          purposes: p.purposes,
        };
      }),
      // per-session persistent goal ('web' key when no thread is open yet)
      goal: await getGoal(home, activeSessionId || 'web'),
    };
  };

  // desktop mode is ALWAYS loopback: no LAN/WAN/tunnel surface, period.
  const exposure = desktop !== undefined ? 'loopback' : ((cfg as WebCfg).web?.exposure ?? 'loopback');
  const remoteToken = (cfg as WebCfg).web?.token ?? '';
  // starts as the requested port; becomes the actually-bound port after
  // listen() (port 0 → OS-assigned). The Host allowlist reads it per-request.
  let actualPort = opts.port;
  const server = createServer(async (req, res) => {
    // ---- mobile pairing routes run BEFORE the exposure gate: the phone's
    // ONLY proof is the QR-borne one-time token (or the tunnel PIN). These
    // two routes never expose task data by themselves. ----
    // actualPort is assigned after listen(); the request handler only runs
    // post-listen, so the Host allowlist already sees the real (possibly
    // OS-assigned) port instead of the requested literal (port 0).
    const port = String(actualPort);
    const host = (req.headers.host ?? '').toLowerCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/pair') {
        if (exposure === 'loopback') { json(res, 403, { error: 'pairing requires --exposure=lan|wan' }); return; }
        if (mobileAuthorized(req) || loopbackHost()) {
          res.writeHead(302, { location: '/' }); res.end(); return;
        }
        if (!pairingValid() || !safeEqual(url.searchParams.get('token') ?? '', pairToken)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:15px/1.6 -apple-system,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#141416;color:#f5f5f6"><div style=text-align:center><div style=font-size:44px>⏱️</div><h3>配对链接已失效</h3><p style=color:#95979d>请在电脑上的 hmh 网页点 📱 重新扫码</p></div></body>');
          return;
        }
        if (requestConnectionMode(req) === 'lan') {
          // WiFi pairing: token proof is enough — issue the session cookie
          // and remember this LAN IP (DSH semantics: no PIN on WiFi).
          issueMobileCookie(res, transportIp(req));
          res.writeHead(302, { location: '/' }); res.end(); return;
        }
        // internet pairing: the QR token opened the door, the 6-digit PIN
        // (shown on the computer) keeps anyone else who copied the link out.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PIN_PAGE);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/pair/verify') {
        if (!sameOriginOk(req)) { json(res, 403, { ok: false, error: 'cross-origin rejected' }); return; }
        if (requestConnectionMode(req) !== 'tunnel') {
          json(res, 400, { ok: false, error: 'PIN verification is only used for internet pairing' });
          return;
        }
        const ip = transportIp(req);
        const retry = pinRateLimited(ip);
        if (retry) { res.setHeader('retry-after', String(retry)); json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试', retryAfter: retry }); return; }
        let pin = '';
        try {
          const body = await new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
          pin = String(JSON.parse(body).pin ?? '').trim();
        } catch { pin = ''; }
        if (!pairingValid() || !pairPin || !safeEqual(pin, pairPin)) {
          if (!pairingValid() || !pairPin) { json(res, 401, { ok: false, error: 'expired', rescan: true }); return; }
          recordPinFailure(ip);
          json(res, 401, { ok: false, error: '配对密码不正确' });
          return;
        }
        pinFailures.clear();
        issueMobileCookie(res, ip);
        json(res, 200, { ok: true });
        return;
      }
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 200) });
      return;
    }
    // ---- desktop bridge gate (2026-10-09, HMH Desktop) ----
    // Desktop host mode: a fresh high-entropy token (env-borne only) guards
    // EVERY route on top of the loopback Host/Origin checks below. The 401
    // body is the DesktopError shape so the desktop client can map codes.
    if (desktop && req.headers['x-hmh-key'] !== desktop.token) {
      json(res, 401, { code: 'AUTH_FAILED', message: 'missing or invalid x-hmh-key', retryable: false });
      return;
    }
    // ---- exposure gate (2026-09-28 remote control) ----
    // Trust ladder, most-local first:
    //   1. loopback Host (desktop sitting at the machine)
    //   2. paired mobile: session cookie OR remembered LAN IP (WiFi trust)
    //   3. long-term cfg.web.token (X-Hmh-Key header or ?key= link)
    // loopback: the old DNS-rebinding guard (Host/Origin must be our own).
    const origin = (req.headers.origin ?? '').toLowerCase();
    function loopbackHost(): boolean {
      return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
    }
    let authorized = true;
    if (exposure !== 'loopback') {
      if (loopbackHost()) {
        authorized = true; // same-machine: no token needed
      } else if (mobileAuthorized(req)) {
        authorized = true; // paired phone (cookie / trusted LAN IP)
      } else {
        authorized = false;
        const hdr = String(req.headers['x-hmh-key'] ?? '');
        const qk = url.searchParams.get('key') ?? '';
        if (remoteToken && (hdr === remoteToken || qk === remoteToken)) authorized = true;
        if (!authorized) {
          json(res, 403, {
            error: 'invalid or missing key',
            code: 'auth-required',
            recoverable: true,
            action: 'zh: 在电脑上的 hmh 网页点 📱 扫码配对，或用带 ?key=<web.token> 的链接访问',
          });
          return;
        }
      }
    } else {
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (!allowedHosts.has(host)) authorized = false;
      const originAllowed = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
      if (!originAllowed) authorized = false;
    }
    if (!authorized) {
      json(res, 403, {
        error: exposure === 'loopback' ? 'forbidden host/origin' : 'invalid or missing key',
        code: exposure === 'loopback' ? 'forbidden-host' : 'auth-required',
        recoverable: exposure !== 'loopback',
        action: exposure === 'loopback' ? 'open via http://127.0.0.1:' + port : 'zh: 在电脑上的 hmh 网页点 📱 扫码配对',
      });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') {
        // QR code SVG for phone pairing (docx remote control): rendered by
        // the `qrcode` npm lib (battle-tested, always scannable). The old
        // hand-rolled encoder produced unscannable codes (format-info bug).
        const text = url.searchParams.get('text') ?? '';
        if (!text || text.length > 500) { json(res, 400, { error: 'text required (max 500 chars)' }); return; }
        try {
          const QR = (await import('qrcode')).default;
          const svg = await QR.toString(text, { type: 'svg', margin: 2, width: 260 });
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
          res.end(svg);
          return;
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
          return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/remote-info') {
        // phone pairing helper (docx remote control): the page needs the LAN
        // IP + token to build the QR URL. This is read-only metadata; auth
        // is enforced by the exposure gate above.
        const lanIp = preferredLanAddress();
        const webCfg = (cfg as WebCfg).web ?? {};
        json(res, 200, {
          lanIp,
          token: webCfg.token ?? '',
          exposure: webCfg.exposure ?? 'loopback',
          port: opts.port,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/pair-info') {
        // Desktop pairing-window feed (DSH snapshot() pattern): one-time
        // pairing URL + countdown + tunnel state. The PIN is only ever sent
        // to the loopback desktop — never to a paired phone or the tunnel.
        if (exposure === 'loopback') { json(res, 400, { error: 'pairing requires --exposure=lan|wan' }); return; }
        if (!pairingValid()) rotatePairing();
        const t = tunnel.state;
        const lanIp = preferredLanAddress();
        const lanUrl = lanIp ? `http://${lanIp}:${opts.port}/pair?token=${pairToken}` : '';
        const tunnelUrl = t.url ? `${t.url}/pair?token=${pairToken}` : '';
        json(res, 200, {
          lanIp,
          port: opts.port,
          pairingUrl: t.url ? tunnelUrl : lanUrl,
          lanPairingUrl: lanUrl,
          tunnelPairingUrl: tunnelUrl,
          expiresAt: pairExpiresAt,
          now: Date.now(),
          connected: mobileSessions.size > 0,
          pin: requestIsFromLoopbackTransport(req) && requestConnectionMode(req) === 'lan' ? pairPin : '',
          tunnel: t,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/rotate') {
        rotatePairing();
        json(res, 200, { ok: true, expiresAt: pairExpiresAt });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tunnel/toggle') {
        if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
          json(res, 403, { ok: false, error: 'desktop only' });
          return;
        }
        if (!sameOriginOk(req)) { json(res, 403, { ok: false, error: 'cross-origin rejected' }); return; }
        let enable = true;
        try {
          const body = await new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
          if (body) enable = JSON.parse(body).enable !== false;
        } catch { /* default enable */ }
        // persist the intent: a restart must bring the tunnel back, or every
        // printed QR keeps pointing at a dead trycloudflare URL (1033)
        try {
          const cur = ((cfg as WebCfg).web ?? {}) as { exposure?: 'loopback' | 'lan' | 'wan'; token?: string; tunnel?: boolean };
          if ((cur.tunnel ?? false) !== enable) await patchConfig({ web: { ...cur, tunnel: enable } });
          (cfg as WebCfg).web = { ...cur, tunnel: enable };
        } catch { /* config write failed — runtime toggle still applies */ }
        const t: TunnelState = enable
          ? await tunnel.start(opts.port, 'cloudflare', (m) => console.log(m))
          : await tunnel.stop().then(() => tunnel.state);
        json(res, 200, { ok: !t.error, tunnel: t });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tunnel/switch-line') {
        if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
          json(res, 403, { ok: false, error: 'desktop only' });
          return;
        }
        if (!sameOriginOk(req)) { json(res, 403, { ok: false, error: 'cross-origin rejected' }); return; }
        const t = await tunnel.switchLine(opts.port, (m) => console.log(m));
        json(res, 200, { ok: !t.error, tunnel: t });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mobile/disconnect') {
        if (!requestIsFromLoopbackTransport(req) || requestConnectionMode(req) !== 'lan') {
          json(res, 403, { ok: false, error: 'desktop only' });
          return;
        }
        mobileSessions.clear();
        trustedLanIps.clear();
        rotatePairing();
        persistMobileSessions();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/drift') {
        try {
          const { analyzeGoalDrift } = await import('@hmharness/cognitive');
          const order = url.searchParams.get('order') === 'time' ? 'time' : 'score';
          json(res, 200, { views: (await analyzeGoalDrift(home, 100, order)).slice(0, 12) });
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/skills') {
        try {
          const { skillCandidatesFromHistory } = await import('@hmharness/cognitive');
          json(res, 200, { candidates: (await skillCandidatesFromHistory(home)).slice(0, 8) });
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/trajectories') {
        try {
          const { listTrajectoryIds } = await import('@hmharness/cognitive');
          json(res, 200, { trajectories: await listTrajectoryIds(home, 30) });
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/replay') {
        try {
          const { replayTrajectory } = await import('@hmharness/cognitive');
          const id = url.searchParams.get('id') ?? 'latest';
          const view = await replayTrajectory(home, id);
          if (!view) { json(res, 404, { error: `trajectory '${id}' not found` }); return; }
          json(res, 200, view);
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/transfer') {
        try {
          const { readFile } = await import('node:fs/promises');
          const { join: j } = await import('node:path');
          const text = await readFile(join(home, 'cognitive', 'transfer.jsonl'), 'utf8');
          const experiments = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).slice(-50);
          json(res, 200, { experiments });
        } catch {
          json(res, 200, { experiments: [] });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/team') {
        try {
          const { teamLog, liveTopologySnapshot } = await import('@hmharness/agent');
          json(res, 200, { events: await teamLog(40), live: liveTopologySnapshot() });
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive/calibration') {
        try {
          const { calibrationReport, calibrationTrend } = await import('@hmharness/cognitive');
          const env = url.searchParams.get('env') ?? undefined;
          if (url.searchParams.get('trend') === '1') {
            json(res, 200, await calibrationTrend(home, 5, env));
          } else {
            json(res, 200, await calibrationReport(home));
          }
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cognitive') {
        // research dashboard seed (blueprint RD-001..008): read-only status
        // of the cognitive subsystems — memory layers, trajectory store,
        // evolution audit tail, environment registry.
        try {
          const { cognitiveStatus } = await import('@hmharness/cognitive');
          json(res, 200, await cognitiveStatus(home));
        } catch (err) {
          json(res, 500, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (desktop && req.method === 'POST' && url.pathname === '/api/desktop/shutdown') {
        // desktop bridge graceful stop: the desktop supervisor calls this
        // (token-gated above) BEFORE falling back to killing its own child.
        json(res, 200, { ok: true });
        shutdown();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, await stateObject());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.flushHeaders?.();
        sseClients.add(res);
        // reconnect catch-up (docx): Last-Event-ID replays everything the
        // client missed while disconnected (capped ring), then live flow
        const lastId = Number(req.headers['last-event-id'] ?? 0);
        if (Number.isFinite(lastId) && lastId > 0) {
          for (const e of sseRing) {
            if (e.id > lastId) {
              res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
            }
          }
        }
        sseSend(res, 'hello', await stateObject());
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/extension/status') {
        // Read-only probe of the browser-extension bridge (loopback). The
        // web server takes ZERO new dependencies for this: it speaks plain
        // HTTP to the bridge exactly the way the extension does. Unreachable
        // bridge = honest available:false, never a 500.
        const extPort = Number(process.env.HMH_EXTENSION_PORT ?? 0) || 7789;
        try {
          const r = await fetch(`http://127.0.0.1:${extPort}/v1/status`, { signal: AbortSignal.timeout(1_500) });
          const j = await r.json() as { ok?: boolean; paired?: boolean; connected?: boolean; browser?: string; extVersion?: string };
          if (r.ok && j.ok) {
            json(res, 200, { available: true, port: extPort, paired: j.paired, connected: j.connected, browser: j.browser, extVersion: j.extVersion });
            return;
          }
        } catch { /* not running */ }
        json(res, 200, { available: false, port: extPort });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        // Read-only device inventory via hdc (local dev tool). Never mutates.
        const probe = await new Promise<{ ok: boolean; devices: Array<{ target: string; kind: string }> }>((resolve) => {
          execFile('hdc', ['list', 'targets'], { timeout: 4000, windowsHide: true }, (err, out) => {
            if (err || typeof out !== 'string') {
              resolve({ ok: false, devices: [] });
              return;
            }
            resolve({
              ok: true,
              devices: out
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l && !/^\[Empty\]$/.test(l) && !l.startsWith('OHOS'))
                .map((target) => ({
                  target,
                  kind: /^127\.0\.0\.1:\d+$/.test(target) ? 'emulator' : 'usb',
                })),
            });
          });
        });
        json(res, 200, { devices: probe.devices, hdcAvailable: probe.ok });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workspaces') {
        json(res, 200, { current: wsCurrent, items: wsItems });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces') {
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; path?: string };
        const path = isAbsolute(String(body.path ?? '')) ? resolve(String(body.path)) : '';
        const name = String(body.name ?? '').trim() || (path ? basename(path) : '');
        if (!path || !name) {
          json(res, 400, { error: 'absolute path and name required' });
          return;
        }
        let isDir = false;
        try {
          isDir = (await stat(path)).isDirectory();
        } catch {
          /* missing */
        }
        if (!isDir) {
          json(res, 400, { error: `not a directory: ${path}` });
          return;
        }
        if (wsItems.some((w) => w.path.toLowerCase() === path.toLowerCase())) {
          json(res, 409, { error: 'workspace already registered' });
          return;
        }
        const item: WsItem = { id: `ws-${Math.random().toString(36).slice(2, 8)}`, name, path };
        wsItems.push(item);
        await saveWorkspaces();
        json(res, 200, { ok: true, current: wsCurrent, items: wsItems });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces/use') {
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: string };
        const target = wsItems.find((w) => w.id === body.id);
        if (!target) {
          json(res, 404, { error: 'workspace not found' });
          return;
        }
        if (anyBusy()) {
          json(res, 409, { error: 'a task is already running' });
          return;
        }
        try {
          process.chdir(target.path);
        } catch (err) {
          json(res, 400, { error: `cannot enter ${target.path}: ${String(err).slice(0, 120)}` });
          return;
        }
        wsCurrent = target.id;
        await saveWorkspaces();
        broadcast('state', await stateObject());
        json(res, 200, { ok: true, current: wsCurrent, items: wsItems });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces/delete') {
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: string };
        if (wsItems.length <= 1) {
          json(res, 400, { error: 'at least one workspace must remain' });
          return;
        }
        if (body.id === wsCurrent) {
          json(res, 400, { error: 'cannot delete the active workspace' });
          return;
        }
        wsItems = wsItems.filter((w) => w.id !== body.id);
        await saveWorkspaces();
        json(res, 200, { ok: true, current: wsCurrent, items: wsItems });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        // 工作区变更(只读,HMH Desktop Diff 面板/M4):会话 cwd 的 git
        // status --porcelain + diff --stat。非 git 目录返回 git:false,
        // 不报错(UI 显示"非 git 工作区")。绝不写任何状态。
        const sidDiff = url.searchParams.get('sessionId') ?? '';
        const thDiff = sessionThreads.get(sidDiff);
        const cwdDiff = thDiff?.cwd ?? wsRoot();
        const d = await collectGitChanges(cwdDiff);
        json(res, 200, { git: d.git, cwd: cwdDiff, changed: d.changed, stat: d.stat });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/fs') {
        // Directory browser backing the workspace picker: lists drives
        // (no path) or the subdirectories of one absolute path. Read-only,
        // directories only - never file contents.
        const q = url.searchParams.get('path') ?? '';
        if (!q) {
          const roots: Array<{ name: string; path: string }> = [];
          if (process.platform === 'win32') {
            for (let c = 65; c <= 90; c++) {
              const drive = `${String.fromCharCode(c)}:\\`;
              try {
                if ((await stat(drive)).isDirectory()) roots.push({ name: drive, path: drive });
              } catch {
                /* absent drive */
              }
            }
          } else {
            roots.push({ name: '/', path: '/' });
          }
          json(res, 200, { path: '', segments: [], parent: '', dirs: roots });
          return;
        }
        const target = isAbsolute(q) ? resolve(q) : '';
        if (!target) {
          json(res, 400, { error: 'absolute path required' });
          return;
        }
        try {
          if (!(await stat(target)).isDirectory()) {
            json(res, 400, { error: `not a directory: ${target}` });
            return;
          }
        } catch {
          json(res, 404, { error: `not found: ${target}` });
          return;
        }
        let entries;
        try {
          entries = await readdir(target, { withFileTypes: true });
        } catch {
          json(res, 200, { path: target, segments: [{ name: basename(target) || target, path: target }], parent: dirname(target) === target ? '' : dirname(target), dirs: [] });
          return;
        }
        const dirs = entries
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => ({ name: e.name, path: join(target, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        // ?files=1 (right-column file tree): also list regular files, capped,
        // each with a workspace-root-relative path for the preview tab
        const withFiles = url.searchParams.get('files') === '1';
        const files = withFiles
          ? entries
              .filter((e) => e.isFile())
              .slice(0, 200)
              .map((e) => {
                const abs = join(target, e.name);
                return { name: e.name, path: abs, rel: toRel(wsRoot(), abs) };
              })
              .sort((a, b) => a.name.localeCompare(b.name))
          : undefined;
        // breadcrumb segments, e.g. C: > Users > user
        const segments: Array<{ name: string; path: string }> = [];
        if (process.platform === 'win32') {
          const parts = target.split(/[\\/]+/).filter(Boolean);
          let acc = '';
          for (const p of parts) {
            acc = acc ? join(acc, p) : `${p}\\`;
            segments.push({ name: p.endsWith(':') ? p : p, path: acc });
          }
        } else {
          const parts = target.split('/').filter(Boolean);
          let acc = '';
          segments.push({ name: '/', path: '/' });
          for (const p of parts) {
            acc = `${acc}/${p}`;
            segments.push({ name: p, path: acc });
          }
        }
        const parent = dirname(target) === target ? '' : dirname(target);
        json(res, 200, { path: target, segments, parent, dirs, ...(files !== undefined ? { files } : {}) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        // shared kernel listing (codex get_threads transplant): date-nested +
        // legacy layouts, cursor paging, head-read titles. cwd query param
        // scopes to one workspace (the sidebar groups client-side anyway).
        const qLimit = Number(url.searchParams.get('limit') ?? '200');
        const qCwd = url.searchParams.get('cwd');
        const page = await listSessions(home, {
          limit: Number.isFinite(qLimit) && qLimit > 0 ? Math.min(qLimit, 200) : 200,
          sort: url.searchParams.get('sort') === 'created' ? 'created' : 'updated',
          ...(qCwd ? { cwd: qCwd } : {}),
        });
        // board cards come from the insight archive (task/outcome/turns/tools)
        const bySession = new Map((await readInsights(home, 200)).map((i) => [i.session, i]));
        // custom titles (rename) ride in workspaces.json; audit files stay immutable
        let sessionTitles: Record<string, string> = {};
        try {
          const wsRaw = JSON.parse(await readFile(join(home, 'workspaces.json'), 'utf8')) as Record<string, unknown>;
          sessionTitles = (wsRaw.sessionTitles ?? {}) as Record<string, string>;
        } catch { /* none yet */ }
        const sessions = page.items.map((s) => ({
          id: s.id,
          title: sessionTitles[s.id] ?? '',
          // first user message straight from the rollout head (kernel readSessionHead)
          task: s.title || bySession.get(s.id)?.task || '',
          outcome: bySession.get(s.id)?.outcome ?? '',
          turns: bySession.get(s.id)?.turns ?? 0,
          toolUses: bySession.get(s.id)?.toolUses ?? 0,
          time: bySession.get(s.id)?.time ?? s.updatedAt,
          cwd: s.cwd,
          branch: s.branch ?? '',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
        json(res, 200, { sessions, nextCursor: page.nextCursor, workspace: currentWs() ?? null });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
        // session management: rename (title), archive (move to sessions/archive/),
        // delete (move to sessions/trash/ - recoverable, never hard-destroyed)
        const parts = url.pathname.slice('/api/sessions/'.length).split('/');
        const id = decodeURIComponent(parts[0]).replace(/[^a-zA-Z0-9_:.@-]/g, '');
        const op = parts[1] ?? '';
        const body = JSON.parse((await readBody(req)) || '{}') as { title?: string };
        // date-nested layouts mean the file no longer sits at sessions/<id>.jsonl
        const file = await findSessionFile(home, id);
        if (!file) {
          json(res, 404, { error: 'session not found' });
          return;
        }
        const trashDir = join(home, 'sessions', 'trash');
        const archiveDir = join(home, 'sessions', 'archive');
        try {
          if (op === 'delete') {
            await mkdir(trashDir, { recursive: true });
            await rename(file, join(trashDir, `${id}.jsonl`));
            json(res, 200, { ok: true });
            return;
          }
          if (op === 'archive') {
            await mkdir(archiveDir, { recursive: true });
            await rename(file, join(archiveDir, `${id}.jsonl`));
            json(res, 200, { ok: true });
            return;
          }
          if (op === 'rename') {
            const title = String(body.title ?? '').slice(0, 120);
            if (!title) { json(res, 400, { error: 'title required' }); return; }
            // titles ride in workspaces.json so the audit jsonl stays immutable
            const wsFile = join(home, 'workspaces.json');
            let ws: Record<string, unknown> = {};
            try { ws = JSON.parse(await readFile(wsFile, 'utf8')) as Record<string, unknown>; } catch { /* fresh */ }
            const titles = (ws.sessionTitles ?? {}) as Record<string, string>;
            titles[id] = title;
            ws.sessionTitles = titles;
            await writeFile(wsFile, JSON.stringify(ws, null, 2) + '\n', 'utf8');
            json(res, 200, { ok: true, title });
            return;
          }
          json(res, 404, { error: `unknown session op: ${op}` });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
        // one-click export (2026-09-25): GET /api/sessions/<id>/export.md
        // streams the full transcript as a Markdown download - same builder
        // as `hmh export` / TUI /export, so every surface exports identically.
        // The suffix check runs BEFORE the id sanitization: the strip regex
        // deletes '/', which would weld "id/export.md" into one bogus id.
        const seg = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
        const exportMatch = /^(.*)\/export\.md$/.exec(seg) || /^(.*)\.export\.md$/.exec(seg);
        if (exportMatch && exportMatch[1]) {
          const realId = exportMatch[1].replace(/[^a-zA-Z0-9_:.@-]/g, '');
          const realFile = await findSessionFile(home, realId);
          const realTr = realFile ? await loadTranscript(realFile) : null;
          if (!realTr) {
            json(res, 404, { error: 'session not found' });
            return;
          }
          const md = exportSessionMarkdown(realTr);
          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="hmh-${(realTr.id || 'session').replace(/[^a-zA-Z0-9_:.@-]/g, '')}.md"`,
          });
          res.end(md);
          return;
        }
        const id = seg.replace(/[^a-zA-Z0-9_:.@-]/g, '');
        const file = await findSessionFile(home, id);
        const tr = file ? await loadTranscript(file) : null;
        if (!tr) {
          json(res, 404, { error: 'session not found' });
          return;
        }
        const preview = (m: ChatMessage) => ({
          role: m.role,
          text: (m.content ?? '').slice(0, 500),
          tools: m.tool_calls?.map((c) => c.function.name) ?? [],
        });
        json(res, 200, { id: tr.id, model: tr.model, cwd: tr.cwd ?? '', messages: tr.messages.slice(-80).map(preview) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/task') {
        // image attachments ride base64 in the body: allow up to ~3x6MB decoded
        const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}') as {
          text?: unknown; yes?: boolean; mode?: string; fresh?: boolean;
          attachments?: unknown; images?: unknown;
        };
        const text = String(body.text ?? '').trim();
        if (!text) {
          json(res, 400, { error: 'text required' });
          return;
        }
        // ---- @-file references: valid ones become a [referenced files] block ----
        let prefix = '';
        if (Array.isArray(body.attachments)) {
          const rawList = body.attachments.filter((a): a is string => typeof a === 'string');
          const valid: string[] = [];
          for (const a of rawList) {
            const p = resolve(a);
            if (!insideWs(p)) continue; // path traversal refused
            try {
              if (!(await stat(p)).isFile()) continue;
            } catch {
              continue; // missing
            }
            valid.push(p);
          }
          if (rawList.length > 0 && valid.length === 0) {
            json(res, 400, { error: 'no valid attachment path (must be an existing file inside the workspace)' });
            return;
          }
          prefix += buildAttachmentsPrefix(valid.map((p) => toRel(wsRoot(), p)));
        }
        // ---- image attachments: vision chain describes each, then temp files go ----
        let imagePrefix = '';
        if (Array.isArray(body.images)) {
          const parsed: Array<{ name: string; dataUrl: string; ext: 'png' | 'jpg' | 'webp'; buffer: Buffer }> = [];
          for (const im of body.images.slice(0, 3)) {
            const obj = (im ?? {}) as { name?: unknown; dataUrl?: unknown };
            const dataUrl = typeof obj.dataUrl === 'string' ? obj.dataUrl : '';
            const p = parseImageDataUrl(dataUrl);
            if (!p) continue; // malformed / oversized items dropped
            parsed.push({
              name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `image-${parsed.length + 1}`,
              dataUrl,
              ext: p.ext,
              buffer: p.buffer,
            });
          }
          if (Array.isArray(body.images) && body.images.length > 0 && parsed.length === 0) {
            json(res, 400, { error: 'no valid image (data:image/(png|jpeg|jpg|webp);base64, and <= 6 MB)' });
            return;
          }
          if (parsed.length > 0) {
            const tmpDir = join(home, 'tmp');
            await mkdir(tmpDir, { recursive: true });
            const chain = visionProviderChain(cfg);
            const tmpFiles: string[] = [];
            for (let i = 0; i < parsed.length; i++) {
              const tmpPath = join(tmpDir, `att-${Date.now()}-${i}.${parsed[i].ext}`);
              await writeFile(tmpPath, parsed[i].buffer);
              tmpFiles.push(tmpPath);
            }
            try {
              for (let i = 0; i < parsed.length; i++) {
                const { name, dataUrl } = parsed[i];
                const n = i + 1;
                if (chain.length === 0) {
                  imagePrefix += buildImagePrefix(n, name, null);
                  continue;
                }
                // seeImageTool.execute's chain discipline: walk the vision
                // chain, skip refusal answers, fall through on errors
                const errors: string[] = [];
                let desc: string | null = null;
                for (const provider of chain) {
                  try {
                    const answer = await chatVision(provider, 'Describe this image precisely and concisely.', dataUrl);
                    if (isVisionRefusal(answer)) {
                      errors.push(`${provider.model}: cannot see images (replied "${answer.trim().slice(0, 60)}")`);
                      continue;
                    }
                    desc = answer;
                    break;
                  } catch (err) {
                    errors.push(`${provider.model}: ${String(err).slice(0, 120)}`);
                  }
                }
                imagePrefix += buildImagePrefix(n, name, desc ?? `(image ${n} could not be described: ${errors.join('; ')})`);
              }
            } finally {
              // temp files are deleted whether or not the vision calls landed
              for (const f of tmpFiles) {
                try {
                  await rm(f, { force: true });
                } catch {
                  /* best-effort cleanup */
                }
              }
            }
          }
        }
        // composed text (references first, then images, then the user text) is
        // what runs, queues, and echoes in the 'busy' SSE event
        const composed = prefix + imagePrefix + text;
        const mode = body.mode === 'auto' || body.mode === 'yolo' ? body.mode : body.yes === true ? 'auto' : 'ask';
        // sessionId routes the task into ITS session's thread (deepseek-harness
        // semantics): a follow-up in a history view resumes that rollout, a
        // fresh session starts clean. The thread state lives server-side; the
        // browser view is just a projection of it.
        const sidIn = typeof (body as { sessionId?: unknown }).sessionId === 'string' ? String((body as { sessionId?: unknown }).sessionId).slice(0, 80) : undefined;
        const item = { text: composed, mode, yes: body.yes === true, fresh: body.fresh === true, sessionId: sidIn };
        // W15: queueing is PER SESSION. A busy session queues the follow-up;
        // every OTHER session still starts immediately - sessions never wait
        // on each other (dsh parity). A session without an id gets a fresh
        // one and always runs now.
        const sidFor = sidIn ?? `web-${Date.now().toString(36)}`;
        item.sessionId = sidFor;
        const exec = execFor(sidFor);
        if (exec.busy) {
          exec.queue.push(item);
          saveQueues();
          broadcast('queued', { position: exec.queue.length, task: composed, sessionId: sidFor });
          broadcastQueue();
          json(res, 200, { ok: true, queued: true, position: exec.queue.length });
          return;
        }
        json(res, 200, { ok: true });
        // Runs detached; every event fans out to all SSE clients.
        void runOne(item);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/interrupt') {
        // Codex-style stop per SESSION: aborts that session's running child
        // (in-flight tools finish first, kernel semantics); other sessions
        // are untouched. No sessionId given + exactly one running session ->
        // that one (legacy single-task clients).
        const ibody = JSON.parse((await readBody(req)) || '{}') as { sessionId?: unknown };
        const sidIn = typeof ibody.sessionId === 'string' ? ibody.sessionId.slice(0, 80) : '';
        const running = [...executors.entries()].filter(([, e]) => e.busy);
        const target = sidIn && executors.get(sidIn)?.busy ? executors.get(sidIn)! : running.length === 1 ? running[0][1] : null;
        if (!target?.stdin) {
          json(res, 200, { ok: false, busy: anyBusy(), running: running.length });
          return;
        }
        try { target.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); } catch { /* child gone */ }
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/queue') {
        if (req.method === 'GET') {
          const sidQ = url.searchParams.get('sessionId') ?? '';
          if (sidQ) {
            const e = executors.get(sidQ);
            json(res, 200, { sessionId: sidQ, items: e ? e.queue.map((t) => t.text) : [], busy: e?.busy === true });
            return;
          }
          json(res, 200, { items: allQueued().map((t) => t.text), busy: anyBusy() });
          return;
        }
        if (req.method === 'DELETE') {
          // no index: clear all (or ?sessionId=X clears that session's);
          // ?i=N: remove one queued item of the FLAT list (UI's per-row ✕)
          const sidQ = url.searchParams.get('sessionId') ?? '';
          const idxRaw = url.searchParams.get('i');
          if (idxRaw === null) {
            if (sidQ) {
              const e = executors.get(sidQ);
              const n = e ? e.queue.length : 0;
              if (e) e.queue.length = 0;
              saveQueues();
              broadcastQueue();
              json(res, 200, { ok: true, cleared: n });
              return;
            }
            let n = 0;
            for (const e of executors.values()) { n += e.queue.length; e.queue.length = 0; }
            saveQueues();
            broadcastQueue();
            json(res, 200, { ok: true, cleared: n });
            return;
          }
          const flat = allQueued();
          const i = Number(idxRaw);
          if (!Number.isInteger(i) || i < 0 || i >= flat.length) {
            json(res, 404, { error: 'no such queued item' });
            return;
          }
          const victim = flat[i];
          victim.owner.queue.splice(victim.owner.queue.indexOf(victim), 1);
          saveQueues();
          broadcastQueue();
          json(res, 200, { ok: true });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/ssh') {
        // proxy a remote command: the browser never sees keys or the ssh
        // binary - the server resolves the configured host and runs ssh.
        // Read-only probes pass; anything else needs ?approve=1 from the
        // client-side approval flow (same gate discipline as tools).
        const body = JSON.parse((await readBody(req)) || '{}') as { host?: string; command?: string; approve?: boolean };
        const hosts = cfg.sshHosts ?? {};
        const h = hosts[String(body.host ?? '')];
        if (!h) { json(res, 404, { error: 'unknown host', configured: Object.keys(hosts) }); return; }
        const command = String(body.command ?? '').trim();
        if (!command) { json(res, 400, { error: 'command required' }); return; }
        // Fast path = a BARE read-only probe (shared kernel shellgate): one
        // allowlisted verb, plain arguments, zero shell metacharacters. The
        // old per-segment verb allowlist + writes-regex was bypassable -
        // `find -delete`, `echo $(touch /x)`, `echo hi >& /etc/file` and
        // `date -s` all passed without approval (same bypass classes as
        // GHSA-cv3g-hj65-pcfh / cli-mcp-server 0.2.5). Now: not a bare probe
        // → approval, no exceptions.
        if (!isBareProbe(command)) {
          if (body.approve !== true) { json(res, 403, { error: 'approval required', needsApproval: true }); return; }
        }
        try {
          const { execFile } = await import('node:child_process');
          const { promisify: prom } = await import('node:util');
          const r = await prom(execFile)('ssh', [
            '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
            ...(h.keyPath ? ['-i', h.keyPath] : []),
            '-p', String(h.port ?? 22),
            (h.user ? h.user + '@' : '') + h.host,
            command,
          ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
          json(res, 200, { output: (String(r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim().slice(0, 20_000) || '(no output)' });
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
          json(res, 400, { error: [e.stdout, e.stderr, e.killed ? '(timed out)' : e.message].filter(Boolean).join('\n').slice(0, 400) });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/locale') {
        // persist the UI locale preference into config.json (all other
        // fields, including provider keys, preserved untouched) and fan out
        const body = JSON.parse((await readBody(req)) || '{}') as { locale?: string };
        if (body.locale !== 'zh' && body.locale !== 'en') {
          json(res, 400, { error: 'locale must be zh|en' });
          return;
        }
        const file = join(home, 'config.json');
        let raw: Record<string, unknown> = {};
        try {
          raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        } catch {
          /* fresh config */
        }
        raw.locale = body.locale;
        await writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        cfg.locale = body.locale;
        broadcast('state', await stateObject());
        json(res, 200, { ok: true, locale: body.locale });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/model') {
        // switch routing.chat to a named provider; config.json is rewritten
        // in place (all other fields kept) and the in-memory cfg follows so
        // the next task already uses the new route
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
        const name = String(body.name ?? '');
        try {
          const fresh = await setChatRoute(name);
          cfg.provider = fresh.provider;
          cfg.providers = fresh.providers;
          cfg.routing = fresh.routing;
          broadcast('state', await stateObject());
          json(res, 200, { ok: true, model: resolveProvider(cfg, 'chat').model });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        // W15: approvals are per session (several sessions can ask at once).
        // sessionId given -> that session's card; omitted + exactly one
        // pending anywhere -> it (legacy single-card clients).
        const body = JSON.parse((await readBody(req)) || '{}') as { granted?: boolean; sessionId?: unknown };
        const sidIn = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : '';
        const pendings = [...executors.entries()].filter(([, e]) => e.pending);
        const hit = sidIn ? executors.get(sidIn) : pendings.length === 1 ? executors.get(pendings[0][0]) : undefined;
        const p = hit?.pending ?? null;
        if (!p) {
          json(res, 404, { error: 'no approval pending', concurrent: pendings.length });
          return;
        }
        hit!.pending = null;
        clearTimeout(p.timer);
        p.resolve(body.granted === true);
        json(res, 200, { ok: true, granted: body.granted === true });
        return;
      }
      // ---- provider management (settings center) ----
      if (req.method === 'POST' && url.pathname === '/api/providers') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown;
          authHeader?: unknown; supportsVision?: unknown; timeoutMs?: unknown; contextWindow?: unknown;
        };
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!name || !baseUrl || !model) {
          json(res, 400, { error: 'name, baseUrl and model are required' });
          return;
        }
        // apiKey omitted = keep the stored key (the UI never round-trips
        // secrets); apiKey explicitly '' = clear it. Same for optional fields.
        try {
          const fresh = await saveProvider(name, {
            baseUrl,
            model,
            ...(body.apiKey !== undefined ? { apiKey: String(body.apiKey) } : {}),
            ...(typeof body.authHeader === 'string' && body.authHeader ? { authHeader: body.authHeader } : {}),
            ...(typeof body.supportsVision === 'boolean' ? { supportsVision: body.supportsVision } : {}),
            ...(typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0 ? { timeoutMs: body.timeoutMs } : {}),
            ...(typeof body.contextWindow === 'number' && Number.isFinite(body.contextWindow) && body.contextWindow > 0 ? { contextWindow: body.contextWindow } : {}),
          });
          cfg.provider = fresh.provider;
          cfg.providers = fresh.providers;
          cfg.routing = fresh.routing;
          broadcast('state', await stateObject());
          json(res, 200, { ok: true, name });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/delete') {
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          json(res, 400, { error: 'name required' });
          return;
        }
        try {
          const fresh = await deleteProvider(name);
          cfg.provider = fresh.provider;
          cfg.providers = fresh.providers;
          cfg.routing = fresh.routing;
          broadcast('state', await stateObject());
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      // ---- general settings ----
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          locale?: unknown; approval?: unknown; autoEvolveEvery?: unknown; autoPatch?: unknown; theme?: unknown;
        };
        const partial: Record<string, unknown> = {};
        if (body.locale !== undefined) {
          if (body.locale !== 'zh' && body.locale !== 'en') {
            json(res, 400, { error: 'locale must be zh|en' });
            return;
          }
          partial.locale = body.locale;
        }
        if (body.approval !== undefined) {
          if (body.approval !== 'ask' && body.approval !== 'auto') {
            json(res, 400, { error: 'approval must be ask|auto' });
            return;
          }
          partial.approval = body.approval;
        }
        if (body.autoEvolveEvery !== undefined) {
          const n = Number(body.autoEvolveEvery);
          if (!Number.isInteger(n) || n < 0) {
            json(res, 400, { error: 'autoEvolveEvery must be a non-negative integer' });
            return;
          }
          partial.autoEvolveEvery = n;
        }
        if (body.autoPatch !== undefined) {
          if (typeof body.autoPatch !== 'boolean') {
            json(res, 400, { error: 'autoPatch must be boolean' });
            return;
          }
          // lives under evolution.autoPatch in config.json
          partial.evolution = { autoPatch: body.autoPatch };
        }
        if (body.theme !== undefined) {
          if (body.theme !== 'dark' && body.theme !== 'light' && body.theme !== 'system') {
            json(res, 400, { error: 'theme must be dark|light|system' });
            return;
          }
          partial.theme = body.theme;
        }
        try {
          const fresh = await patchConfig(partial);
          // sync the in-memory cfg field-by-field (evolution object is merged,
          // never wholesale-replaced, so other in-memory evolution fields survive)
          if (fresh.locale !== undefined) cfg.locale = fresh.locale;
          if (fresh.approval !== undefined) cfg.approval = fresh.approval;
          if (fresh.autoEvolveEvery !== undefined) cfg.autoEvolveEvery = fresh.autoEvolveEvery;
          if (fresh.evolution?.autoPatch !== undefined) cfg.evolution = { ...(cfg.evolution ?? {}), autoPatch: fresh.evolution.autoPatch };
          if ((fresh as WebCfg).theme !== undefined) (cfg as WebCfg).theme = (fresh as WebCfg).theme;
          broadcast('state', await stateObject());
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      // ---- workspace file search (@-reference source) ----
      if (req.method === 'GET' && url.pathname === '/api/fs/search') {
        const rootParam = (url.searchParams.get('root') ?? '').trim();
        const q = (url.searchParams.get('q') ?? '').trim();
        if (!q) {
          json(res, 400, { error: 'q required' });
          return;
        }
        if (rootParam && !isAbsolute(rootParam)) {
          json(res, 400, { error: 'root must be an absolute path' });
          return;
        }
        const root = rootParam ? resolve(rootParam) : wsRoot();
        if (!isAbsolute(root) || !insideWs(root)) {
          json(res, 400, { error: 'root must be inside the active workspace' });
          return;
        }
        const hits: Array<SearchHit & { score: number }> = [];
        let visited = 0;
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_ENTRIES) return;
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return; // unreadable subtree is skipped, not fatal
          }
          for (const e of entries) {
            if (visited >= MAX_SEARCH_ENTRIES) return; // budget hit: return what we have
            visited++;
            if (e.isSymbolicLink()) continue; // never follow links out of the root
            const abs = join(dir, e.name);
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name)) continue;
              await walk(abs, depth + 1);
              continue;
            }
            if (!e.isFile()) continue;
            const rel = toRel(wsRoot(), abs);
            const score = fuzzyScore(q, rel);
            if (score >= 0) hits.push({ rel, path: abs, kind: 'file', score });
          }
        };
        await walk(root, 0);
        hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
        const out = hits.slice(0, MAX_SEARCH_RESULTS).map(({ score: _score, ...h }) => h);
        json(res, 200, { results: out, truncated: hits.length > MAX_SEARCH_RESULTS, total: hits.length });
        return;
      }
      // ---- workspace file read (8KB binary sniff, 64KB cap) ----
      if (req.method === 'GET' && url.pathname === '/api/fs/read') {
        const p = (url.searchParams.get('path') ?? '').trim();
        if (!p || !insideWs(p)) {
          json(res, 400, { error: 'path must resolve inside the active workspace' });
          return;
        }
        const abs = resolve(p);
        let st;
        try {
          st = await stat(abs);
        } catch {
          json(res, 404, { error: `not found: ${abs}` });
          return;
        }
        if (!st.isFile()) {
          json(res, 400, { error: `not a file: ${abs}` });
          return;
        }
        const cap = 64 * 1024;
        const truncated = st.size > cap;
        const fh = await open(abs, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(st.size, cap));
          await fh.read(bytes, 0, bytes.length, 0);
          let binary = isBinaryHead(bytes.subarray(0, 8192));
          let text: string | undefined;
          if (!binary) {
            // strict utf8: a decode failure means binary regardless of the sniff
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              binary = true;
            }
          }
          json(res, 200, {
            path: abs,
            rel: toRel(wsRoot(), abs),
            size: st.size,
            ...(binary ? { binary } : { text }),
            ...(truncated ? { truncated } : {}),
          });
        } finally {
          await fh.close();
        }
        return;
      }
      // ---- runtime steering: inject text into the running task ----
      if (req.method === 'POST' && url.pathname === '/api/inject') {
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown; sessionId?: unknown };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
          json(res, 400, { error: 'text required' });
          return;
        }
        // W15: injection routes to ONE session's child (given id, or the
        // single running one for legacy clients); other sessions untouched
        const sidIn = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : '';
        const running = [...executors.entries()].filter(([, e]) => e.busy);
        const exec = sidIn ? executors.get(sidIn) : running.length === 1 ? running[0][1] : undefined;
        if (!exec?.stdin) {
          json(res, 409, { error: 'no task running', running: running.length });
          return;
        }
        try { exec.stdin.write(JSON.stringify({ type: 'inject', text }) + '\n'); } catch { /* child gone */ }
        broadcast('injected', { text, sessionId: sidIn || activeSessionId });
        json(res, 200, { ok: true });
        return;
      }
      // ---- per-session persistent goal ----
      if (req.method === 'POST' && url.pathname === '/api/goal') {
        const body = JSON.parse((await readBody(req)) || '{}') as { goal?: unknown; sessionId?: unknown };
        const goal = typeof body.goal === 'string' ? body.goal : '';
        const sidIn = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : '';
        const thread = sidIn ? sessionThreads.get(sidIn) : undefined;
        const key = thread?.rolloutId ?? (sidIn || activeSessionId || 'web');
        await setGoal(home, key, goal);
        broadcast('goal', { goal: goal.trim() || null, sessionId: sidIn || activeSessionId });
        json(res, 200, { ok: true });
        return;
      }
      // ---- slash-command dispatch (web subset) ----
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const body = JSON.parse((await readBody(req)) || '{}') as { line?: unknown };
        const line = typeof body.line === 'string' ? body.line.trim() : '';
        if (!line.startsWith('/')) {
          json(res, 400, { error: 'command must start with /' });
          return;
        }
        const okText = (text: string) => json(res, 200, { text });
        const errText = (error: string, status = 400) => json(res, status, { error });
        if (line === '/help') {
          okText(COMMAND_HELP);
          return;
        }
        if (line === '/tools') {
          okText(reg.list().map((t) => `${t.name} — ${t.description.split('\n')[0]}`).join('\n') || '(no tools)');
          return;
        }
        if (line === '/skills') {
          const [active, drafts] = await Promise.all([listSkills(home), listDrafts(home)]);
          okText([
            ...active.map((s) => `+ ${s.name} — ${s.description}`),
            ...drafts.map((s) => `~ ${s.name} — ${s.description}`),
          ].join('\n') || '(no skills)');
          return;
        }
        if (line === '/model' || line.startsWith('/model ')) {
          const arg = line.slice(7).trim();
          if (!arg) {
            okText(listProviders(cfg).map((p) => `${p.name} — ${p.model}${p.purposes.length ? ' (' + p.purposes.join('/') + ')' : ''}`).join('\n') || '(no providers)');
            return;
          }
          try {
            const fresh = await setChatRoute(arg);
            cfg.provider = fresh.provider;
            cfg.providers = fresh.providers;
            cfg.routing = fresh.routing;
            broadcast('state', await stateObject());
            okText(`chat → ${arg} · ${resolveProvider(cfg, 'chat').model}`);
          } catch (err) {
            errText(String(err).slice(0, 200));
          }
          return;
        }
        if (line === '/lang' || line.startsWith('/lang ')) {
          const arg = line.slice(6).trim();
          const target = arg === 'zh' || arg === 'en' ? arg : cfg.locale === 'zh' ? 'en' : 'zh';
          const fresh = await setLocale(target);
          cfg.locale = fresh.locale;
          broadcast('state', await stateObject());
          okText(target === 'zh' ? '语言已切换为中文 / locale: zh' : 'Locale switched to English / 语言: en');
          return;
        }
        if (line === '/yolo' || line === '/yolo on' || line === '/yolo off') {
          const turnOn = line === '/yolo' ? cfg.approval !== 'auto' : line === '/yolo on';
          try {
            const fresh = await patchConfig({ approval: turnOn ? 'auto' : 'ask' });
            cfg.approval = fresh.approval;
            // LIVE effect (2026-09-25 user request): the running task's next
            // approval ask consults this flag - no more "wait for next session"
            const { liveYolo } = await import('@hmharness/agent');
            liveYolo.on = turnOn;
            broadcast('state', await stateObject());
            okText(turnOn ? '🔥 YOLO on（已即时生效并保持为默认）' : 'approval back to ask（已即时生效并保持为默认）');
          } catch (err) {
            errText(String(err).slice(0, 200));
          }
          return;
        }
        if (line === '/providers' || line === '/providers scan') {
          try {
            const found = await detectLocalProviders(cfg, readFile);
            if (line === '/providers') {
              okText(found.length
                ? found.map((p) => `+ ${p.name} — ${p.model} (${p.envVar})`).join('\n') + '\n/providers scan 合并进配置 / run /providers scan to merge'
                : '(没有检测到新的可用 provider / no new providers detected)');
            } else {
              if (!found.length) {
                okText(`(无新增 / none new; configured: ${Object.keys(cfg.providers ?? {}).join(', ')})`);
              } else {
                const r = await addProviders(found.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })));
                cfg.provider = r.cfg.provider;
                cfg.providers = r.cfg.providers;
                cfg.routing = r.cfg.routing;
                broadcast('state', await stateObject());
                okText(`✓ added: ${r.added.join(', ')}`);
              }
            }
          } catch (err) {
            errText(String(err).slice(0, 200));
          }
          return;
        }
        if (line === '/mcp') {
          const entries = Object.entries(cfg.mcpServers ?? {});
          okText(entries.length
            ? entries.map(([n, c]) => `${n} — ${c.type}${c.trusted ? ' · trusted' : ' · gated'}`).join('\n')
            : '(no MCP servers configured)');
          return;
        }
        if (line === '/ops' || line === '/ops scan') {
          try {
            const mod = await import('@hmharness/domain-ops');
            const tool = line === '/ops' ? mod.harmonyOpsStatus : mod.harmonyOpsRadarScan;
            const r = await tool.execute({}, { cwd: process.cwd(), home });
            okText(r.output);
          } catch (err) {
            errText(String(err).slice(0, 200));
          }
          return;
        }
        if (line === '/status') {
          okText(`model ${resolveProvider(cfg, 'chat').model} · locale ${cfg.locale ?? 'zh'} · ${anyBusy() ? 'busy' : 'idle'} · queue ${allQueued().length} · sessions running ${[...executors.values()].filter((e) => e.busy).length}`);
          return;
        }
        if (line === '/resume' || line.startsWith('/resume ')) {
          okText('在左侧会话列表点击会话即可回看 / resume: click a session in the left session list');
          return;
        }
        if (line === '/web' || line.startsWith('/web ')) {
          okText(`当前即 web UI: http://127.0.0.1:${opts.port} / you are already here`);
          return;
        }
        if (line === '/exit' || line === '/quit') {
          okText('关闭浏览器标签页即可；后台守护可用 hmh web stop / close this tab; hmh web stop kills the daemon');
          return;
        }
        if (line === '/bench' || line.startsWith('/bench ') || line === '/evolve' || line.startsWith('/evolve ')) {
          // heavy single-task-slot commands stay TUI/CLI-only in the web subset
          errText('run in TUI/CLI (hmh bench / hmh evolve)');
          return;
        }
        json(res, 404, { error: 'unknown command' });
        return;
      }
      // ---- A10: explicit message feedback (👍/👎) -> insights dir ----
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: unknown; thumbs?: unknown; text?: unknown };
        const thumbs = body.thumbs === 'up' || body.thumbs === 'down' ? body.thumbs : null;
        if (!thumbs) {
          json(res, 400, { error: 'thumbs must be up|down' });
          return;
        }
        // a SELF-DESCRIBING store next to the evolve feed: the strict Insight
        // outcome union is not widened, so explicit feedback never pollutes
        // the "what worked / what failed" stream (it is a separate signal)
        try {
          const { appendFile, mkdir } = await import('node:fs/promises');
          const dir = join(home, 'insights');
          await mkdir(dir, { recursive: true });
          const rec = {
            time: new Date().toISOString(),
            session: typeof body.sessionId === 'string' ? body.sessionId : '',
            thumbs,
            text: String(body.text ?? '').slice(0, 400),
          };
          await appendFile(join(dir, 'explicit-feedback.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      // ---- A14: open a workspace path in the OS file manager ----
      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = JSON.parse((await readBody(req)) || '{}') as { path?: unknown };
        const p = typeof body.path === 'string' ? body.path.trim() : '';
        if (!p || !insideWs(p)) {
          json(res, 400, { error: 'path must resolve inside the active workspace' });
          return;
        }
        const abs = resolve(p);
        try {
          // explorer's exit code is unreliable (0/1 both mean "opened") —
          // spawn fire-and-forget instead of awaiting a meaningful code
          if (process.platform === 'win32') {
            const { spawn } = await import('node:child_process');
            const st2 = await stat(abs);
            if (st2.isDirectory()) spawn('explorer', [abs], { detached: true, stdio: 'ignore' }).unref();
            else spawn('explorer', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
          } else {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const run = promisify(execFile);
            if (process.platform === 'darwin') await run('open', ['-R', abs]);
            else await run('xdg-open', [abs]);
          }
          json(res, 200, { ok: true, path: abs });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      // ---- RL gate condition 3: human reward labeling (star clicks) ----
      if (req.method === 'GET' && url.pathname === '/api/label/list') {
        try {
          // labelableSessions prepends recently-LABELED sessions (task
          // '(labeled)') for re-inspection; the labeling QUEUE is the rest.
          // The card shows THREE things so a human can actually judge:
          //   task   = the first user message (full, from the session head)
          //   answer = the agent's LAST assistant text (what it replied)
          //   outcome/toolUses = success + tool-call counts (from insights)
          const all = await labelableSessions(home, 40);
          const { readSessionHead, loadTranscript } = await import('@hmharness/kernel');
          const insights = await readInsights(home, 400);
          const byIns = new Map(insights.map((i) => [i.session, i]));
          const picked = all.filter((x) => !x.label).slice(0, 24);
          // degraded sessions first: labelableSessions only sees the newest
          // 200 insight lines (ok batch runs dominate 10:1), so dig deeper -
          // low-star labels on turn-budget runs are the DPO pair material
          const labeledIds = new Set((await readLabels(home)).map((l) => l.session));
          const seenIds = new Set(picked.map((p) => p.session));
          const degradedPool: typeof picked = [];
          for (let idx = insights.length - 1; idx >= 0 && degradedPool.length < 12; idx--) {
            const i = insights[idx];
            if (i.outcome === 'ok' || labeledIds.has(i.session) || seenIds.has(i.session)) continue;
            seenIds.add(i.session);
            degradedPool.push({ session: i.session, task: i.task.slice(0, 90) });
          }
          const degraded = degradedPool.slice(0, 6);
          const good = picked.filter((x) => !degraded.some((d2) => d2.session === x.session));
          const ordered = [...degraded, ...good];
          const labeled = (await readLabels(home)).length;
          // concurrent fetch of head+transcript per candidate: the serial loop
          // read 24+ rollout files back-to-back and made the first label-page
          // load take ~6s (looked broken). Disk IO parallelizes fine locally.
          const sessions = (await Promise.all(ordered.map(async (s) => {
            let task = s.task;
            let answer = '';
            try {
              const file = await findSessionFile(home, s.session);
              if (file) {
                const head = await readSessionHead(file);
                if (head && head.firstUser) task = head.firstUser;
                const tr = await loadTranscript(file);
                if (tr) {
                  for (let i2 = tr.messages.length - 1; i2 >= 0; i2--) {
                    const m = tr.messages[i2];
                    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                      answer = m.content;
                      break;
                    }
                  }
                }
              }
            } catch { /* keep the insight task */ }
            const ins = byIns.get(s.session);
            return {
              session: s.session,
              task: task.slice(0, 300),
              answer: answer.slice(0, 400),
              outcome: ins?.outcome ?? '',
              toolUses: ins?.toolUses ?? 0,
            };
          }))) as Array<{ session: string; task: string; answer: string; outcome: string; toolUses: number }>;
          json(res, 200, { sessions, labeled, goal: 100 });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/label') {
        const body = JSON.parse((await readBody(req)) || '{}') as { session?: unknown; score?: unknown; note?: unknown };
        const session = typeof body.session === 'string' ? body.session : '';
        const score = Number(body.score);
        if (!session || !Number.isInteger(score) || score < 1 || score > 5) {
          json(res, 400, { error: 'session and score (1-5) required' });
          return;
        }
        try {
          const r = await labelSession(home, session, score, typeof body.note === 'string' && body.note ? body.note.slice(0, 200) : undefined);
          const labeled = (await readLabels(home)).length;
          if (!r.ok) {
            json(res, 400, { error: r.reason ?? 'label rejected', labeled, goal: 100 });
            return;
          }
          json(res, 200, { ok: true, labeled, goal: 100 });
        } catch (err) {
          json(res, 400, { error: String(err).slice(0, 200) });
        }
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      // structured error (docx Web 专项): the UI renders code/action in plain
      // language instead of dumping a stack trace as the main text
      json(res, 500, {
        error: String(err).slice(0, 300),
        code: 'internal',
        recoverable: true,
        action: 'zh: 稍后重试；若持续失败请查看 web.log',
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const r of sseClients) r.write(': ping\n\n');
  }, 15_000);

  // keep the resident local companion alive: log and continue instead of
  // dying bare (a dead detached process is invisible until the user notices
  // the browser can't connect)
  process.on('uncaughtException', (err) => {
    console.error(`[hmh web] uncaught: ${String(err).slice(0, 400)}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // lan/wan must bind the wildcard; loopback (and desktop mode) stays on 127.0.0.1
    const bind = exposure === 'loopback' ? host : '0.0.0.0';
    server.listen(opts.port, bind, resolve);
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // 2026-10-09 (HMH Desktop): the library no longer process.exit()s the
      // HOST process - the caller decides how to report and exit. The CLI's
      // foreground path prints the same two friendly lines it always did
      // (main.ts catches EADDRINUSE explicitly).
      const e = new Error(`port ${opts.port} is already in use`) as NodeJS.ErrnoException;
      e.code = 'EADDRINUSE';
      throw e;
    }
    throw err;
  });
  // port 0 (desktop mode / callers wanting an OS-assigned port): report the
  // actually-bound port back. Non-zero ports: identical to opts.port.
  const bound = server.address();
  actualPort = typeof bound === 'object' && bound !== null ? bound.port : opts.port;
  if (desktop) {
    // Desktop bootstrap line (contract: hmh-desktop packages/host-adapter):
    // ONE json line on stdout; every other log goes to stderr so the
    // supervisor's stdout parsing stays pure.
    process.stdout.write(`${JSON.stringify({ hmhDesktopHostReady: true, port: actualPort, version: daemonVersion })}\n`);
    console.error(`[hmh desktop-host] ready on 127.0.0.1:${actualPort} (runtime ${daemonVersion})`);
  } else {
  console.log(`hmh web · http://${host}:${actualPort} · model ${cfg.provider.model} · home ${home}`);
    if (exposure !== 'loopback') {
    const lanIp = preferredLanAddress();
    console.log(`exposure: ${exposure.toUpperCase()} - 手机与电脑同一 WiFi 时扫网页里的 📱 二维码即可连接`);
    if (lanIp) console.log(`wifi:   http://${lanIp}:${opts.port} （配对走二维码，无需输密码）`);
    else console.log('wifi:   未找到可用的局域网 IP（虚拟网卡已排除）');
    console.log(`auth:   未配对设备需要 ?key=<web.token> 链接；已配对手机凭 cookie/局域网位置直连`);
    if (exposure === 'wan' || ((cfg as WebCfg).web?.tunnel ?? false)) {
      // internet mode: bring up the free tunnel so any network (4G/5G/other
      // WiFi) can reach us with zero firewall/port-forward configuration.
      // web.tunnel=true is the PERSISTED intent from the pairing modal —
      // restarts must restore the tunnel or old QRs point at dead links.
      console.log('internet: 正在启动免费隧道（cloudflared，首次会自动下载）…');
      void tunnel.start(opts.port, 'cloudflare', (m) => console.log(m)).then((t) => {
        if (t.url) console.log(`internet: ${t.url} （互联网扫码 + 6 位配对密码）`);
        else console.log(`internet: 隧道启动失败（${t.error ?? 'unknown'}）；网页 📱 弹窗里可重试或换 pinggy 线路`);
      });
      if (exposure === 'wan') console.log('WARNING: WAN exposure means ANYONE who has the address+pairing code can run commands on this machine.');
    }
  } else {
    console.log('(local only; Ctrl-C to stop)');
  }
  } // end !desktop banner branch

  // graceful shutdown, idempotent: SIGINT/SIGTERM (foreground) and the
  // desktop /api/desktop/shutdown route all funnel through this one path.
  let shutdownDone = false;
  const shutdown = (): void => {
    if (shutdownDone) return;
    shutdownDone = true;
    clearInterval(heartbeat);
    for (const c of clients) c.close();
    for (const r of sseClients) r.end();
    void tunnel.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return {
    port: actualPort,
    host,
    // library close(): triggers the same graceful path; resolves once the
    // process is on its way out (or after the same 1.5s backstop).
    close: () =>
      new Promise<void>((resolve) => {
        shutdown();
        setTimeout(resolve, 1_600);
      }),
  };
}
