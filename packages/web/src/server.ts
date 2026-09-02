/**
 * @hmh/web - server
 * Local web frontend for hmharness: node:http only, zero runtime deps.
 * One task runs at a time; its events stream to every connected browser
 * via SSE; the approval gate is bridged to the page (request -> human
 * clicks -> decision resolves the kernel's ask()). Binds 127.0.0.1 only -
 * this is a local companion, never exposed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, basename, isAbsolute, resolve, dirname } from 'node:path';
import { homeDir, loadConfig, loadTranscript, resolveProvider, listProviders, setChatRoute, PROVIDER_PRESETS, type ChatMessage } from '@hmh/kernel';
import { listDrafts, listSkills, readInsights } from '@hmh/evolution';
import { buildRegistry, runAgentTask } from '@hmh/agent';
import { PAGE } from './page.ts';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

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

export async function startServer(opts: { port: number; host?: string }): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const home = homeDir();
  const cfg = await loadConfig();
  const { reg, clients } = await buildRegistry();

  let busy = false;
  let pendingApproval: PendingApproval | null = null;
  const sseClients = new Set<ServerResponse>();

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
      workspace: currentWs() ?? null,
      providers: listProviders(cfg).map((p) => ({ name: p.name, model: p.model, purposes: p.purposes })),
      providerPresets: PROVIDER_PRESETS
        .filter((p) => !cfg.providers?.[p.name])
        .map((p) => ({ name: p.name, model: p.model, envVar: p.envVar, local: p.envVar === '' })),
      skills: {
        active: active.map((s) => ({ name: s.name, description: s.description })),
        drafts: drafts.map((s) => ({ name: s.name, description: s.description })),
      },
      insights: insights.map((i) => ({ time: i.time, task: i.task, outcome: i.outcome, tools: i.toolsUsed })),
      evolution,
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
        json(res, 200, { path: target, segments, parent, dirs });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        let files: string[] = [];
        try {
          files = (await readdir(join(home, 'sessions'))).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, 50);
        } catch {
          /* none */
        }
        // first line of each jsonl is session/start with the workspace cwd
        const cwdOf = async (file: string): Promise<string> => {
          try {
            const fd = await open(file, 'r');
            const buf = Buffer.alloc(600);
            await fd.read(buf, 0, 600, 0);
            await fd.close();
            return String(JSON.parse(buf.toString('utf8').split('\n')[0] ?? '{}').cwd ?? '');
          } catch {
            return '';
          }
        };
        // board cards come from the insight archive (task/outcome/turns/tools)
        const bySession = new Map((await readInsights(home, 200)).map((i) => [i.session, i]));
        const sessions = await Promise.all(
          files.map(async (f) => {
            const id = f.replace(/\.jsonl$/, '');
            const i = bySession.get(id);
            return {
              id,
              task: i?.task ?? '',
              outcome: i?.outcome ?? '',
              turns: i?.turns ?? 0,
              toolUses: i?.toolUses ?? 0,
              time: i?.time ?? '',
              cwd: await cwdOf(join(home, 'sessions', f)),
            };
          }),
        );
        json(res, 200, { sessions, workspace: currentWs() ?? null });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length)).replace(/[^a-zA-Z0-9_:.@-]/g, '');
        const file = join(home, 'sessions', `${id}.jsonl`);
        const tr = await loadTranscript(file);
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
        if (busy) {
          json(res, 409, { error: 'a task is already running' });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; yes?: boolean };
        const text = String(body.text ?? '').trim();
        if (!text) {
          json(res, 400, { error: 'text required' });
          return;
        }
        busy = true;
        broadcast('busy', { busy: true, task: text });
        json(res, 200, { ok: true });
        // auto/yolo tasks must not wire the remote approval prompt at all -
        // the remote gate used to override the yes flag unconditionally,
        // which is why "auto" still popped approvals (the audited bug)
        const unattended = body.yes === true || cfg.approval === 'auto';
        // Runs detached; every event fans out to all SSE clients.
        void (async () => {
          try {
            await runAgentTask({
              task: text,
              registry: reg,
              cfg,
              yes: body.yes === true,
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
                onFinal: (r) => broadcast('final', r),
              },
            });
          } catch (err) {
            broadcast('error', { message: String(err).slice(0, 400) });
          } finally {
            busy = false;
            pendingApproval = null;
            broadcast('busy', { busy: false });
            broadcast('state', await stateObject());
          }
        })();
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
