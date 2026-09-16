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
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, basename, isAbsolute, resolve, dirname } from 'node:path';
import {
  homeDir, isBareProbe, loadConfig, loadTranscript, resolveProvider, listProviders, setChatRoute,
  setLocale, addProviders, detectLocalProviders, chatVision, visionProviderChain, isVisionRefusal,
  saveProvider, deleteProvider, patchConfig, getGoal, setGoal,
  findSessionFile, listSessions, PROVIDER_PRESETS, type ChatMessage, type HmhConfig,
} from '@hmharness/kernel';
import { listDrafts, listSkills, readInsights } from '@hmharness/evolution';
import { buildRegistry, runAgentTask } from '@hmharness/agent';
import { PAGE } from './page.ts';
import {
  insideRoot, toRel, fuzzyScore, parseImageDataUrl, buildAttachmentsPrefix, buildImagePrefix,
  isBinaryHead, SKIP_DIRS, MAX_SEARCH_DEPTH, MAX_SEARCH_ENTRIES, MAX_SEARCH_RESULTS, type SearchHit,
} from './fs-utils.ts';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

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

/** Runtime-steering buffer: /api/inject pushes user text here while a task
 *  runs; the runner's inject poll drains it between tool batches; cleared
 *  when the busy task finishes. */
const injectionQueue: string[] = [];

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

export async function startServer(opts: { port: number; host?: string; version?: string }): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  // the version the CLI spawns us with (the daemon's code snapshot); used by
  // the version-aware staleness check. Absent (foreground debug) -> the web
  // package's own version, which is never equal to the CLI's, so foreground
  // servers always read as "fresh" only when the CLI passes its version.
  const daemonVersion = opts.version ?? DAEMON_VERSION;
  const home = homeDir();
  const cfg = await loadConfig();
  const { reg, clients } = await buildRegistry();

  let busy = false;
  // Task queue: submissions while busy are queued and auto-started when the
  // current task finishes (replaces the old 409 rejection). Codex-style: the
  // send button doubles as the stop button, so the queue itself needs no
  // commands - it is visible in the UI and interruptible per item.
  const taskQueue: Array<{ text: string; mode: string; yes: boolean; fresh: boolean }> = [];
  let currentAbort: AbortController | null = null;
  let pendingApproval: PendingApproval | null = null;
  const sseClients = new Set<ServerResponse>();
  // cross-task conversation memory (Claude-Code-style continuous thread):
  // every task resumes the working transcript, so follow-ups have context.
  // currentSessionId keeps the whole web conversation on ONE rollout file
  // (codex thread semantics); fresh=true starts a new thread.
  let conversation: ChatMessage[] = [];
  let currentSessionId: string | undefined;

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
  const sseSend = (res: ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => {
    for (const r of sseClients) sseSend(r, event, data);
  };
  const broadcastQueue = () => broadcast('queue', { items: taskQueue.map((t) => t.text) });

  // Single execution path for queued and direct tasks alike. The old shape
  // duplicated the whole runner inside the finally-block to drain the queue -
  // a degraded copy (missing onLine/onApproval, mismatched event names) that
  // drifted every time the direct path changed. One runOne + one pump.
  const runOne = async (item: { text: string; mode: string; yes: boolean; fresh: boolean }, fromQueue = false): Promise<void> => {
    busy = true;
    currentAbort = new AbortController();
    broadcast('busy', { busy: true, task: item.text, mode: item.mode, fromQueue });
    const unattended = item.yes || cfg.approval === 'auto';
    try {
      const resume = item.fresh ? [] : conversation;
      const result = await runAgentTask({
        task: item.text,
        registry: reg,
        cfg,
        yes: item.yes,
        resumeMessages: resume,
        sessionId: item.fresh ? undefined : currentSessionId,
        signal: currentAbort.signal,
        // runtime steering: the runner polls this between tool batches and
        // lands injected text as user messages in the live transcript
        inject: { poll: () => injectionQueue.splice(0).map((text) => ({ text })) },
        // per-session persistent goal (web settings "goal" card); fresh
        // threads deliberately start without one
        goal: item.fresh ? undefined : await getGoal(home, currentSessionId ?? 'web'),
        // auto/yolo tasks must not wire the remote approval prompt at all -
        // the remote gate used to override the yes flag unconditionally,
        // which is why "auto" still popped approvals (the audited bug)
        approvalAsk: unattended ? undefined : (name, args) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              if (pendingApproval?.resolve === resolve) pendingApproval = null;
              broadcast('approvalDone', { name, granted: false, timeout: true });
              resolve(false);
            }, APPROVAL_TIMEOUT_MS);
            pendingApproval = { name, args, resolve, timer };
            broadcast('approvalReq', { name, args });
          }),
        events: {
          onLine: (l) => broadcast('line', { text: l }),
          onDelta: (kind, chunk) => broadcast('delta', { kind, chunk }),
          onToolCall: (name, args) => broadcast('tool', { name, args }),
          onToolResult: (name, output, isError) =>
            broadcast('toolResult', { name, isError, preview: output.slice(0, 300), full: output.slice(0, 8000) }),
          onApproval: (name, args, granted) => broadcast('approvalDone', { name, args, granted }),
          onInjected: (text) => broadcast('injected', { text }),
          onFinal: (r) => {
            // extend the cross-task thread: [..prior, user, ...new turns]
            conversation = [...resume, { role: 'user', content: item.text }, ...(r as { messages?: ChatMessage[] }).messages?.slice(resume.length + 2) ?? []];
            currentSessionId = r.sessionId;
            broadcast('final', { ...r, turnsInThread: Math.floor(conversation.length / 2) });
          },
        },
      });
      // the result itself already fanned out via onFinal; nothing to return
      void result;
    } catch (err) {
      broadcast('error', { message: String(err).slice(0, 400) });
    } finally {
      currentAbort = null;
      pendingApproval = null;
      busy = false;
      injectionQueue.length = 0; // stale steering text must not leak into the next task
      broadcast('busy', { busy: false });
      broadcast('state', await stateObject());
    }
  };
  const pump = async (): Promise<void> => {
    while (!busy && taskQueue.length > 0) {
      const next = taskQueue.shift();
      if (!next) break;
      broadcastQueue();
      await runOne(next, true);
    }
  };

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
      busy,
      approvalPending: pendingApproval !== null,
      queue: taskQueue.map((t) => t.text),
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
      goal: await getGoal(home, currentSessionId ?? 'web'),
    };
  };

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: this server is loopback-only, so any request whose
    // Host (or Origin, when present) is not our own loopback origin is a
    // rebinding probe -> refuse before touching a route. The approval
    // endpoint is effectively remote-code-execution; it must never answer a
    // foreign origin.
    const port = String(opts.port);
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = (req.headers.origin ?? '').toLowerCase();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!allowedHosts.has(host)) {
      json(res, 403, { error: 'forbidden host' });
      return;
    }
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      json(res, 403, { error: 'forbidden origin' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
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
        sseSend(res, 'hello', await stateObject());
        req.on('close', () => sseClients.delete(res));
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
        if (busy) {
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
        // breadcrumb segments, e.g. C: > Users > hongfu
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
        const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length)).replace(/[^a-zA-Z0-9_:.@-]/g, '');
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
        json(res, 200, { id: tr.id, model: tr.model, messages: tr.messages.slice(-80).map(preview) });
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
        const item = { text: composed, mode, yes: body.yes === true, fresh: body.fresh === true };
        // Queue instead of reject: tasks submitted while busy are accepted
        // and auto-started when the current one finishes (user request:
        // "input always available, new tasks queue during execution")
        if (busy) {
          taskQueue.push(item);
          broadcast('queued', { position: taskQueue.length, task: composed });
          broadcastQueue();
          json(res, 200, { ok: true, queued: true, position: taskQueue.length });
          return;
        }
        json(res, 200, { ok: true });
        // Runs detached; every event fans out to all SSE clients.
        void (async () => {
          await runOne(item);
          await pump();
        })();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/interrupt') {
        // Codex-style stop: the send button doubles as a stop button while a
        // task runs. Interrupts the CURRENT task only; queued items still run
        // (clear them via DELETE /api/queue or per-item removal first).
        if (!busy || !currentAbort) {
          json(res, 200, { ok: false, busy });
          return;
        }
        currentAbort.abort();
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/queue') {
        if (req.method === 'GET') {
          json(res, 200, { items: taskQueue.map((t) => t.text), busy });
          return;
        }
        if (req.method === 'DELETE') {
          // no index: clear all; ?i=N: remove one queued item (UI's per-row ✕)
          const idxRaw = url.searchParams.get('i');
          if (idxRaw === null) {
            const n = taskQueue.length;
            taskQueue.length = 0;
            broadcastQueue();
            json(res, 200, { ok: true, cleared: n });
            return;
          }
          const i = Number(idxRaw);
          if (!Number.isInteger(i) || i < 0 || i >= taskQueue.length) {
            json(res, 404, { error: 'no such queued item' });
            return;
          }
          taskQueue.splice(i, 1);
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
        const body = JSON.parse((await readBody(req)) || '{}') as { granted?: boolean };
        if (!pendingApproval) {
          json(res, 404, { error: 'no approval pending' });
          return;
        }
        const p = pendingApproval;
        pendingApproval = null;
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
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
          json(res, 400, { error: 'text required' });
          return;
        }
        if (!busy) {
          json(res, 409, { error: 'no task running' });
          return;
        }
        injectionQueue.push(text);
        broadcast('injected', { text });
        json(res, 200, { ok: true });
        return;
      }
      // ---- per-session persistent goal ----
      if (req.method === 'POST' && url.pathname === '/api/goal') {
        const body = JSON.parse((await readBody(req)) || '{}') as { goal?: unknown };
        const goal = typeof body.goal === 'string' ? body.goal : '';
        const key = currentSessionId ?? 'web';
        await setGoal(home, key, goal);
        broadcast('goal', { goal: goal.trim() || null });
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
            broadcast('state', await stateObject());
            okText(turnOn ? '🔥 YOLO on' : 'approval back to ask');
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
          okText(`model ${resolveProvider(cfg, 'chat').model} · locale ${cfg.locale ?? 'zh'} · ${busy ? 'busy' : 'idle'} · queue ${taskQueue.length}`);
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
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err).slice(0, 300) });
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
    server.listen(opts.port, host, resolve);
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${opts.port} is already in use - hmh web may already be running.`);
      console.error(`open http://127.0.0.1:${opts.port} in a browser, or start with --port=<another>.`);
      process.exit(1);
    }
    throw err;
  });
  console.log(`hmh web · http://${host}:${opts.port} · model ${cfg.provider.model} · home ${home}`);
  console.log('(local only; Ctrl-C to stop)');

  const shutdown = () => {
    clearInterval(heartbeat);
    for (const c of clients) c.close();
    for (const r of sseClients) r.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
