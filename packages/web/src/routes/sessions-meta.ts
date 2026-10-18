/**
 * @hmharness/web - session metadata routes (extracted from server.ts,
 * 2026-10-18; web split slice 5b per the v33 audit's 4.1 guidance).
 *
 * Six endpoints: the session listing (kernel get_threads transplant),
 * per-session management ops (rename/archive/soft-delete), one-click
 * markdown export + transcript preview, explicit 👍/👎 feedback, and the
 * human reward-labeling queue + submit. Bodies moved VERBATIM; deps are
 * the home dir, the currentWs closure, and the two responders.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listSessions, findSessionFile, loadTranscript, exportSessionMarkdown, readSessionHead,
  type ChatMessage,
} from '@hmharness/kernel';
import { labelableSessions, labelSession, readLabels, readInsights } from '@hmharness/evolution';

export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface SessionsMetaRouteDeps {
  home: string;
  currentWs: () => unknown;
  json: JsonFn;
  readBody: (req: IncomingMessage, limit?: number) => Promise<string | null>;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleSessionsMetaRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: SessionsMetaRouteDeps,
): Promise<boolean> {
  const { home, currentWs, json, readBody } = deps;

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
    return true;
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
      return true;
    }
    const trashDir = join(home, 'sessions', 'trash');
    const archiveDir = join(home, 'sessions', 'archive');
    try {
      if (op === 'delete') {
        await mkdir(trashDir, { recursive: true });
        await rename(file, join(trashDir, `${id}.jsonl`));
        json(res, 200, { ok: true });
        return true;
      }
      if (op === 'archive') {
        await mkdir(archiveDir, { recursive: true });
        await rename(file, join(archiveDir, `${id}.jsonl`));
        json(res, 200, { ok: true });
        return true;
      }
      if (op === 'rename') {
        const title = String(body.title ?? '').slice(0, 120);
        if (!title) { json(res, 400, { error: 'title required' }); return true; }
        // titles ride in workspaces.json so the audit jsonl stays immutable
        const wsFile = join(home, 'workspaces.json');
        let ws: Record<string, unknown> = {};
        try { ws = JSON.parse(await readFile(wsFile, 'utf8')) as Record<string, unknown>; } catch { /* fresh */ }
        const titles = (ws.sessionTitles ?? {}) as Record<string, string>;
        titles[id] = title;
        ws.sessionTitles = titles;
        await writeFile(wsFile, JSON.stringify(ws, null, 2) + '\n', 'utf8');
        json(res, 200, { ok: true, title });
        return true;
      }
      json(res, 404, { error: `unknown session op: ${op}` });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
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
        return true;
      }
      const md = exportSessionMarkdown(realTr);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="hmh-${(realTr.id || 'session').replace(/[^a-zA-Z0-9_:.@-]/g, '')}.md"`,
      });
      res.end(md);
      return true;
    }
    const id = seg.replace(/[^a-zA-Z0-9_:.@-]/g, '');
    const file = await findSessionFile(home, id);
    const tr = file ? await loadTranscript(file) : null;
    if (!tr) {
      json(res, 404, { error: 'session not found' });
      return true;
    }
    const preview = (m: ChatMessage) => ({
      role: m.role,
      text: (m.content ?? '').slice(0, 500),
      tools: m.tool_calls?.map((c) => c.function.name) ?? [],
    });
    json(res, 200, { id: tr.id, model: tr.model, cwd: tr.cwd ?? '', messages: tr.messages.slice(-80).map(preview) });
    return true;
  }
  // ---- A10: explicit message feedback (👍/👎) -> insights dir ----
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: unknown; thumbs?: unknown; text?: unknown };
    const thumbs = body.thumbs === 'up' || body.thumbs === 'down' ? body.thumbs : null;
    if (!thumbs) {
      json(res, 400, { error: 'thumbs must be up|down' });
      return true;
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
    return true;
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
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/label') {
    const body = JSON.parse((await readBody(req)) || '{}') as { session?: unknown; score?: unknown; note?: unknown };
    const session = typeof body.session === 'string' ? body.session : '';
    const score = Number(body.score);
    if (!session || !Number.isInteger(score) || score < 1 || score > 5) {
      json(res, 400, { error: 'session and score (1-5) required' });
      return true;
    }
    try {
      const r = await labelSession(home, session, score, typeof body.note === 'string' && body.note ? body.note.slice(0, 200) : undefined);
      const labeled = (await readLabels(home)).length;
      if (!r.ok) {
        json(res, 400, { error: r.reason ?? 'label rejected', labeled, goal: 100 });
        return true;
      }
      json(res, 200, { ok: true, labeled, goal: 100 });
    } catch (err) {
      json(res, 400, { error: String(err).slice(0, 200) });
    }
    return true;
  }
  return false;
}
