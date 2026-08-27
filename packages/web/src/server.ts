/**
 * @hmh/web - server
 * Local web frontend for hmharness: node:http only, zero runtime deps.
 * One task runs at a time; its events stream to every connected browser
 * via SSE; the approval gate is bridged to the page (request -> human
 * clicks -> decision resolves the kernel's ask()). Binds 127.0.0.1 only -
 * this is a local companion, never exposed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homeDir, loadConfig, loadTranscript, type ChatMessage } from '@hmh/kernel';
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
      model: cfg.provider.model,
      home,
      locale: cfg.locale ?? 'zh',
      busy,
      approvalPending: pendingApproval !== null,
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
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        let files: string[] = [];
        try {
          files = (await readdir(join(home, 'sessions'))).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, 50);
        } catch {
          /* none */
        }
        // join the task title for each session from recent insights
        const titles = new Map<string, string>();
        for (const i of await readInsights(home, 200)) titles.set(i.session, i.task);
        json(res, 200, {
          sessions: files.map((f) => {
            const id = f.replace(/\.jsonl$/, '');
            return { id, task: titles.get(id) ?? '' };
          }),
        });
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
        // Runs detached; every event fans out to all SSE clients.
        void (async () => {
          try {
            await runAgentTask({
              task: text,
              registry: reg,
              cfg,
              yes: body.yes === true,
              approvalAsk: (name, args) =>
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

  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
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
