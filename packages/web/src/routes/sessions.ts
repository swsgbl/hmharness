/**
 * @hmharness/web - session run-control routes (extracted from server.ts,
 * 2026-10-18; web split slice 5a per the v33 audit's 4.1 guidance).
 *
 * Six endpoints: the read-only workspace diff, per-session interrupt, the
 * per-session queue (get/clear/remove), per-session approvals, runtime
 * injection, and the per-session persistent goal. Bodies moved VERBATIM;
 * the executor map, thread map, and the queue/broadcast closures are
 * injected as live references — mutations hit the running server state.
 *
 * The executor shape is a STRUCTURAL view (SessionExecLike): the server's
 * richer SessionExec (proc/authError/...) is assignable to it; the routes
 * only touch busy/queue/stdin/pending.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import { setGoal } from '@hmharness/kernel';

export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface SessionExecLike {
  busy: boolean;
  queue: Array<{ text: string }>;
  stdin: Writable | null;
  pending: { timer: ReturnType<typeof setTimeout>; resolve: (granted: boolean) => void } | null;
}

export interface SessionsRouteDeps {
  executors: Map<string, SessionExecLike>;
  sessionThreads: Map<string, { cwd?: string; rolloutId?: string }>;
  activeSessionId: string;
  anyBusy: () => boolean;
  allQueued: () => Array<{ text: string; owner: { queue: unknown[] } }>;
  saveQueues: () => void;
  broadcastQueue: () => void;
  broadcast: (kind: string, data?: unknown) => void;
  collectGitChanges: (cwd: string) => Promise<{ git: boolean; changed: unknown[]; stat: string }>;
  wsRoot: () => string;
  home: string;
  json: JsonFn;
  readBody: (req: IncomingMessage, limit?: number) => Promise<string | null>;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleSessionsRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: SessionsRouteDeps,
): Promise<boolean> {
  const {
    executors, sessionThreads, activeSessionId, anyBusy, allQueued,
    saveQueues, broadcastQueue, broadcast, collectGitChanges, wsRoot, home, json, readBody,
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/diff') {
    // 工作区变更(只读,HMH Desktop Diff 面板/M4):会话 cwd 的 git
    // status --porcelain + diff --stat。非 git 目录返回 git:false,
    // 不报错(UI 显示"非 git 工作区")。绝不写任何状态。
    const sidDiff = url.searchParams.get('sessionId') ?? '';
    const thDiff = sessionThreads.get(sidDiff);
    const cwdDiff = thDiff?.cwd ?? wsRoot();
    const d = await collectGitChanges(cwdDiff);
    json(res, 200, { git: d.git, cwd: cwdDiff, changed: d.changed, stat: d.stat });
    return true;
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
      return true;
    }
    try { target.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); } catch { /* child gone */ }
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/queue') {
    if (req.method === 'GET') {
      const sidQ = url.searchParams.get('sessionId') ?? '';
      if (sidQ) {
        const e = executors.get(sidQ);
        json(res, 200, { sessionId: sidQ, items: e ? e.queue.map((t) => t.text) : [], busy: e?.busy === true });
        return true;
      }
      json(res, 200, { items: allQueued().map((t) => t.text), busy: anyBusy() });
      return true;
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
          return true;
        }
        let n = 0;
        for (const e of executors.values()) { n += e.queue.length; e.queue.length = 0; }
        saveQueues();
        broadcastQueue();
        json(res, 200, { ok: true, cleared: n });
        return true;
      }
      const flat = allQueued();
      const i = Number(idxRaw);
      if (!Number.isInteger(i) || i < 0 || i >= flat.length) {
        json(res, 404, { error: 'no such queued item' });
        return true;
      }
      const victim = flat[i];
      victim.owner.queue.splice(victim.owner.queue.indexOf(victim), 1);
      saveQueues();
      broadcastQueue();
      json(res, 200, { ok: true });
      return true;
    }
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
      return true;
    }
    hit!.pending = null;
    clearTimeout(p.timer);
    p.resolve(body.granted === true);
    json(res, 200, { ok: true, granted: body.granted === true });
    return true;
  }
  // ---- runtime steering: inject text into the running task ----
  if (req.method === 'POST' && url.pathname === '/api/inject') {
    const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown; sessionId?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      json(res, 400, { error: 'text required' });
      return true;
    }
    // W15: injection routes to ONE session's child (given id, or the
    // single running one for legacy clients); other sessions untouched
    const sidIn = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : '';
    const running = [...executors.entries()].filter(([, e]) => e.busy);
    const exec = sidIn ? executors.get(sidIn) : running.length === 1 ? running[0][1] : undefined;
    if (!exec?.stdin) {
      json(res, 409, { error: 'no task running', running: running.length });
      return true;
    }
    try { exec.stdin.write(JSON.stringify({ type: 'inject', text }) + '\n'); } catch { /* child gone */ }
    broadcast('injected', { text, sessionId: sidIn || activeSessionId });
    json(res, 200, { ok: true });
    return true;
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
    return true;
  }
  return false;
}
