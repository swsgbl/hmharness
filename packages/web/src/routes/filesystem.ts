/**
 * @hmharness/web - filesystem routes (extracted from server.ts, 2026-10-16;
 * web split slice 3 per the v33 audit's 4.1 architecture guidance).
 *
 * Nine endpoints across four segments (workspaces CRUD, the directory
 * browser, file search, capped file read, open-in-explorer). Bodies moved
 * VERBATIM with exactly two documented deviations: the two closure
 * REASSIGNMENTS (`wsItems = wsItems.filter(...)`, `wsCurrent = target.id`)
 * become setter calls — a shared reference cannot carry a reassignment, and
 * the setters write straight back into the live server state.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, stat, open } from 'node:fs/promises';
import { join, basename, dirname, isAbsolute, resolve } from 'node:path';
import {
  fuzzyScore, toRel, SKIP_DIRS, MAX_SEARCH_DEPTH, MAX_SEARCH_ENTRIES, MAX_SEARCH_RESULTS, isBinaryHead,
  type SearchHit,
} from '../fs-utils.ts';
import type { WsItem } from '../server.ts';

export type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface FilesystemRouteDeps {
  wsItems: WsItem[];
  wsCurrent: string;
  setWsItems: (items: WsItem[]) => void;
  setWsCurrent: (id: string) => void;
  saveWorkspaces: () => Promise<void>;
  anyBusy: () => boolean;
  broadcast: (kind: string, data?: unknown) => void;
  stateObject: () => Promise<unknown>;
  wsRoot: () => string;
  insideWs: (p: string) => boolean;
  home: string;
  json: JsonFn;
  readBody: (req: IncomingMessage) => Promise<string | null>;
}

/** Returns true when the request was handled (server.ts stops matching). */
export async function handleFilesystemRoute(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  deps: FilesystemRouteDeps,
): Promise<boolean> {
  const {
    wsItems, wsCurrent, setWsItems, setWsCurrent, saveWorkspaces, anyBusy,
    broadcast, stateObject, wsRoot, insideWs, json, readBody,
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/workspaces') {
    json(res, 200, { current: wsCurrent, items: wsItems });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workspaces') {
    const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; path?: string };
    const path = isAbsolute(String(body.path ?? '')) ? resolve(String(body.path)) : '';
    const name = String(body.name ?? '').trim() || (path ? basename(path) : '');
    if (!path || !name) {
      json(res, 400, { error: 'absolute path and name required' });
      return true;
    }
    let isDir = false;
    try {
      isDir = (await stat(path)).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) {
      json(res, 400, { error: `not a directory: ${path}` });
      return true;
    }
    if (wsItems.some((w) => w.path.toLowerCase() === path.toLowerCase())) {
      json(res, 409, { error: 'workspace already registered' });
      return true;
    }
    const item: WsItem = { id: `ws-${Math.random().toString(36).slice(2, 8)}`, name, path };
    wsItems.push(item);
    await saveWorkspaces();
    json(res, 200, { ok: true, current: wsCurrent, items: wsItems });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workspaces/use') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string };
    const target = wsItems.find((w) => w.id === body.id);
    if (!target) {
      json(res, 404, { error: 'workspace not found' });
      return true;
    }
    if (anyBusy()) {
      json(res, 409, { error: 'a task is already running' });
      return true;
    }
    try {
      process.chdir(target.path);
    } catch (err) {
      json(res, 400, { error: `cannot enter ${target.path}: ${String(err).slice(0, 120)}` });
      return true;
    }
    setWsCurrent(target.id); // was: wsCurrent = target.id (closure reassignment)
    await saveWorkspaces();
    broadcast('state', await stateObject());
    json(res, 200, { ok: true, current: target.id, items: wsItems });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workspaces/delete') {
    const body = JSON.parse((await readBody(req)) || '{}') as { id?: string };
    if (wsItems.length <= 1) {
      json(res, 400, { error: 'at least one workspace must remain' });
      return true;
    }
    if (body.id === wsCurrent) {
      json(res, 400, { error: 'cannot delete the active workspace' });
      return true;
    }
    setWsItems(wsItems.filter((w) => w.id !== body.id)); // was: wsItems = wsItems.filter(...)
    await saveWorkspaces();
    json(res, 200, { ok: true, current: wsCurrent, items: wsItems });
    return true;
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
      return true;
    }
    const target = isAbsolute(q) ? resolve(q) : '';
    if (!target) {
      json(res, 400, { error: 'absolute path required' });
      return true;
    }
    try {
      if (!(await stat(target)).isDirectory()) {
        json(res, 400, { error: `not a directory: ${target}` });
        return true;
      }
    } catch {
      json(res, 404, { error: `not found: ${target}` });
      return true;
    }
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      json(res, 200, { path: target, segments: [{ name: basename(target) || target, path: target }], parent: dirname(target) === target ? '' : dirname(target), dirs: [] });
      return true;
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
    return true;
  }
  // ---- workspace file search (@-reference source) ----
  if (req.method === 'GET' && url.pathname === '/api/fs/search') {
    const rootParam = (url.searchParams.get('root') ?? '').trim();
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) {
      json(res, 400, { error: 'q required' });
      return true;
    }
    if (rootParam && !isAbsolute(rootParam)) {
      json(res, 400, { error: 'root must be an absolute path' });
      return true;
    }
    const root = rootParam ? resolve(rootParam) : wsRoot();
    if (!isAbsolute(root) || !insideWs(root)) {
      json(res, 400, { error: 'root must be inside the active workspace' });
      return true;
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
    return true;
  }
  // ---- workspace file read (8KB binary sniff, 64KB cap) ----
  if (req.method === 'GET' && url.pathname === '/api/fs/read') {
    const p = (url.searchParams.get('path') ?? '').trim();
    if (!p || !insideWs(p)) {
      json(res, 400, { error: 'path must resolve inside the active workspace' });
      return true;
    }
    const abs = resolve(p);
    let st;
    try {
      st = await stat(abs);
    } catch {
      json(res, 404, { error: `not found: ${abs}` });
      return true;
    }
    if (!st.isFile()) {
      json(res, 400, { error: `not a file: ${abs}` });
      return true;
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
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    const body = JSON.parse((await readBody(req)) || '{}') as { path?: unknown };
    const p = typeof body.path === 'string' ? body.path.trim() : '';
    if (!p || !insideWs(p)) {
      json(res, 400, { error: 'path must resolve inside the active workspace' });
      return true;
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
    return true;
  }
  return false;
}
