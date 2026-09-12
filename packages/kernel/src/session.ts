/**
 * @hmharness/kernel - session (rollout persistence, transplanted from openai/codex)
 * Append-only JSONL rollouts under HMH_HOME/sessions/. New sessions land in
 * date-nested dirs (sessions/YYYY/MM/DD/<id>.jsonl - codex-rs/rollout
 * precompute_new_rollout_path); legacy flat files stay listable and resumable.
 * The first line is the session_meta equivalent (t: 'session/start' with id,
 * cwd, model, git context, forkedFrom). Resuming OPENS THE SAME FILE and
 * appends - the conversation keeps one rollout per thread (codex
 * RolloutRecorderParams::Resume), instead of forking into a new file per task.
 * Every loop event is durably recorded - the audit trail the 2026 consensus
 * calls non-negotiable, and the raw material the evolution subsystem learns from.
 */
import { appendFile, mkdir, open as fopen, readdir, readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from './types.ts';

export type SessionEvent =
  | { t: 'session/start'; id: string; time: string; cwd: string; model: string; git?: { branch?: string; commit?: string }; forkedFrom?: string }
  | { t: 'user'; time: string; text: string }
  | { t: 'assistant'; time: string; text: string | null; tool_calls?: unknown[] }
  | { t: 'tool'; time: string; name: string; output: string; isError: boolean }
  | { t: 'approval'; time: string; tool: string; granted: boolean }
  | { t: 'final'; time: string; text: string; turns: number; toolUses: number };

/** codex-rs/rollout list.rs MAX_SCAN_FILES: hard cap bounding worst-case scan work. */
export const MAX_SCAN_FILES = 10_000;
/** codex-rs/tui resume_picker PAGE_SIZE: sessions per listSessions page. */
export const SESSIONS_PAGE_SIZE = 25;
/** codex-rs/tui LOAD_NEAR_THRESHOLD: prefetch next page this close to the end. */
export const LOAD_NEAR_THRESHOLD = 5;

/** Best-effort git context via pure fs (kernel stays zero-dependency):
 *  walk up to find .git (dir or worktree pointer file), parse HEAD for the
 *  branch (or detached sha). Codex records this in session_meta.git. */
function readGitInfo(cwd: string): { branch?: string; commit?: string } | undefined {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const dot = join(dir, '.git');
    let headFile = join(dot, 'HEAD');
    try {
      let isDir = true;
      try { isDir = statSync(dot).isDirectory(); } catch { return undefined; }
      if (!isDir) {
        // worktree/submodule: .git is a "gitdir: <path>" pointer file
        const raw = readFileSync(dot, 'utf8').trim();
        if (!raw.startsWith('gitdir:')) return undefined;
        headFile = join(raw.slice(7).trim(), 'HEAD');
      }
      const head = readFileSync(headFile, 'utf8').trim();
      if (head.startsWith('ref: refs/heads/')) return { branch: head.slice('ref: refs/heads/'.length) };
      if (/^[0-9a-f]{40}$/i.test(head)) return { commit: head.slice(0, 10) };
      return undefined;
    } catch { /* not a repo here - keep walking up */ }
    const parent = join(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export class Session {
  readonly id: string;
  readonly file: string;
  /** Append chain: events serialize in call order, even fire-and-forget ones. */
  private tail: Promise<void> = Promise.resolve();

  private constructor(id: string, file: string, firstEvent?: SessionEvent) {
    this.id = id;
    this.file = file;
    if (firstEvent) this.append(firstEvent).catch(() => undefined);
  }

  /** New rollout in the date-nested layout, session_meta first line included. */
  static create(home: string, cwd: string, model: string, opts: { forkedFrom?: string } = {}): Session {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    const file = join(home, 'sessions', String(now.getFullYear()), pad2(now.getMonth() + 1), pad2(now.getDate()), `${id}.jsonl`);
    const git = readGitInfo(cwd);
    return new Session(id, file, {
      t: 'session/start', id, time: now.toISOString(), cwd, model,
      ...(git ? { git } : {}), ...(opts.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}),
    });
  }

  /** Codex Resume semantics: append to the SAME rollout - no new session_meta
   *  line, the thread id and audit trail stay continuous. Accepts an id
   *  (prefix) or an absolute file path. Returns null when unresolvable. */
  static async resume(home: string, idOrFile: string): Promise<Session | null> {
    const file = /[\\/.]/.test(idOrFile) && idOrFile.endsWith('.jsonl')
      ? idOrFile
      : await findSessionFile(home, idOrFile);
    if (!file) return null;
    const head = await readSessionHead(file);
    if (!head?.id) return null;
    // codex ensure_rollout_is_newline_terminated: a torn last line must not
    // glue onto the next event - pad the separator before any append lands
    try {
      const fh = await fopen(file, 'r');
      const { size } = await fh.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) await appendFile(file, '\n', 'utf8');
      }
      await fh.close();
    } catch { /* unreadable - the append itself will surface the error */ }
    return new Session(head.id, file);
  }

  async append(event: SessionEvent): Promise<void> {
    const write = this.tail.then(async () => {
      const dir = join(this.file, '..');
      await mkdir(dir, { recursive: true });
      await appendFile(this.file, JSON.stringify(event) + '\n', 'utf8');
    });
    // keep the chain going even if this write fails
    this.tail = write.catch(() => undefined);
    await write;
  }

  user(text: string): Promise<void> {
    return this.append({ t: 'user', time: new Date().toISOString(), text });
  }
  assistant(text: string | null, toolCalls?: unknown[]): Promise<void> {
    return this.append({ t: 'assistant', time: new Date().toISOString(), text, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
  }
  tool(name: string, output: string, isError: boolean): Promise<void> {
    return this.append({ t: 'tool', time: new Date().toISOString(), name, output, isError });
  }
  approval(tool: string, granted: boolean): Promise<void> {
    return this.append({ t: 'approval', time: new Date().toISOString(), tool, granted });
  }
  final(text: string, turns: number, toolUses: number): Promise<void> {
    return this.append({ t: 'final', time: new Date().toISOString(), text, turns, toolUses });
  }
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

export interface SessionTranscript {
  id: string;
  model: string;
  cwd: string;
  file: string;
  messages: ChatMessage[];
}

/** Head summary of a rollout without a full parse: ONE 64KB read extracts the
 *  session_meta line plus the first user event (the list title). Codex reads
 *  HEAD_RECORD_LIMIT(10)+USER_EVENT_SCAN_LIMIT(200) lines for the same fields;
 *  a single bounded head buffer gets both cheaper. */
export interface SessionHead {
  id: string;
  time: string;
  cwd: string;
  model: string;
  git?: { branch?: string; commit?: string };
  forkedFrom?: string;
  firstUser: string;
}

export async function readSessionHead(file: string): Promise<SessionHead | null> {
  try {
    const fh = await fopen(file, 'r');
    try {
      const buf = Buffer.alloc(65_536);
      const { bytesRead } = await fh.read(buf, 0, 65_536, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      let head: SessionHead | null = null;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let ev: { t?: string; id?: string; time?: string; cwd?: string; model?: string; git?: { branch?: string; commit?: string }; forkedFrom?: string; text?: string };
        try { ev = JSON.parse(line); } catch { continue; } // torn tail line - no preview
        if (ev.t === 'session/start' && ev.id) {
          head = { id: ev.id, time: ev.time ?? '', cwd: ev.cwd ?? '', model: ev.model ?? '', git: ev.git, forkedFrom: ev.forkedFrom, firstUser: '' };
        } else if (ev.t === 'user' && typeof ev.text === 'string') {
          if (head) { head.firstUser = ev.text; return head; }
        }
      }
      return head;
    } finally { await fh.close(); }
  } catch { return null; }
}

/** One session per list row (codex ThreadItem, trimmed to what hmharness surfaces). */
export interface SessionSummary {
  id: string;
  file: string;
  /** first user message - the row title (codex preview) */
  title: string;
  cwd: string;
  model: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListSessionsOptions {
  limit?: number;
  /** opaque anchor token from a previous page (codex Cursor: skip until older) */
  cursor?: string;
  /** null/undefined = all sessions; a path = only that workspace */
  cwd?: string | null;
  sort?: 'updated' | 'created';
}

export interface SessionsPage {
  items: SessionSummary[];
  nextCursor: string | null;
  numScanned: number;
  reachedScanCap: boolean;
}

/** Encode/decode the pagination anchor: base64url({t, i}). Stable under files
 *  appearing mid-pagination: everything strictly newer than the anchor is
 *  skipped (codex AnchorState). */
export function encodeSessionCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: ts, i: id }), 'utf8').toString('base64url');
}
export function decodeSessionCursor(token: string): { t: string; i: string } | null {
  try {
    const v = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { t?: string; i?: string };
    return typeof v.t === 'string' && typeof v.i === 'string' ? { t: v.t, i: v.i } : null;
  } catch { return null; }
}

/** id stamps are `YYYY-MM-DDThh-mm-ss-<rand>`: normalize to a sortable ISO time. */
function stampToDate(id: string): number {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : 0;
}

interface Candidate { id: string; file: string; createdMs: number; updatedMs: number }

/** Walk sessions/YYYY/MM/DD/*.jsonl plus legacy flat sessions/*.jsonl,
 *  skipping trash/archive and non-date dirs. Returns newest-first candidates
 *  for the requested sort key (codex walk_rollout_files + visitor). */
async function collectCandidates(home: string, sort: 'updated' | 'created'): Promise<{ list: Candidate[]; scanned: number; capped: boolean }> {
  const root = join(home, 'sessions');
  const out: Candidate[] = [];
  let scanned = 0;
  let capped = false;
  const push = async (file: string) => {
    if (++scanned > MAX_SCAN_FILES) { capped = true; return; }
    const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
    const createdMs = stampToDate(id);
    let updatedMs = createdMs;
    try { updatedMs = (await stat(file)).mtimeMs; } catch { return; }
    out.push({ id, file, createdMs, updatedMs });
  };
  let rootEntries: string[] = [];
  try { rootEntries = await readdir(root); } catch { return { list: [], scanned, capped }; }
  const years = rootEntries.filter((e) => /^\d{4}$/.test(e)).sort().reverse();
  for (const y of years) {
    const months = (await safeReaddir(join(root, y))).filter((e) => /^\d{2}$/.test(e)).sort().reverse();
    for (const mo of months) {
      const days = (await safeReaddir(join(root, y, mo))).filter((e) => /^\d{2}$/.test(e)).sort().reverse();
      for (const d of days) {
        for (const f of (await safeReaddir(join(root, y, mo, d))).filter((x) => x.endsWith('.jsonl') && !x.startsWith('.'))) {
          await push(join(root, y, mo, d, f));
          if (capped) return { list: out, scanned: out.length, capped };
        }
      }
    }
  }
  // legacy flat layout keeps working (codex lists legacy rollouts the same way)
  for (const f of rootEntries) {
    if (f.endsWith('.jsonl') && !f.startsWith('.')) {
      await push(join(root, f));
      if (capped) return { list: out, scanned: out.length, capped };
    }
  }
  const key = sort === 'created' ? (c: Candidate) => c.createdMs : (c: Candidate) => c.updatedMs;
  out.sort((a, b) => key(b) - key(a) || (a.id < b.id ? 1 : -1));
  return { list: out, scanned: out.length, capped };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch { return []; }
}

/** Session listing with cursor pagination (codex get_threads transplant):
 *  anchor-skip, per-file head reads only for surviving candidates, cwd filter
 *  applied post-head like codex's local cwd match, page-limit collection. */
export async function listSessions(home: string, opts: ListSessionsOptions = {}): Promise<SessionsPage> {
  const limit = Math.max(1, opts.limit ?? SESSIONS_PAGE_SIZE);
  const sort = opts.sort ?? 'updated';
  const { list, capped } = await collectCandidates(home, sort);
  const anchor = opts.cursor ? decodeSessionCursor(opts.cursor) : null;
  const items: SessionSummary[] = [];
  let lastEmitted: { ts: string; id: string } | null = null;
  let exhausted = true;
  for (let idx = 0; idx < list.length; idx++) {
    const c = list[idx];
    const ts = sort === 'created' ? c.createdMs : c.updatedMs;
    if (anchor) {
      const at = Date.parse(anchor.t);
      if (ts > at || (ts === at && c.id >= anchor.i)) continue;
    }
    const head = await readSessionHead(c.file);
    if (!head) continue;
    if (opts.cwd && normalizePath(head.cwd) !== normalizePath(opts.cwd)) continue;
    items.push({
      id: c.id, file: c.file, title: head.firstUser, cwd: head.cwd, model: head.model,
      branch: head.git?.branch,
      createdAt: new Date(c.createdMs || Date.parse(head.time) || c.updatedMs).toISOString(),
      updatedAt: new Date(c.updatedMs).toISOString(),
    });
    lastEmitted = { ts: new Date(ts || c.updatedMs).toISOString(), id: c.id };
    if (items.length >= limit) {
      // more matching rows may follow - only claim exhaustion when the scan ended
      exhausted = idx >= list.length - 1;
      break;
    }
  }
  const nextCursor = items.length >= limit && !exhausted && lastEmitted ? encodeSessionCursor(lastEmitted.ts, lastEmitted.id) : null;
  return { items, nextCursor, numScanned: list.length, reachedScanCap: capped };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Resolve an id (or unambiguous prefix) to its rollout file across layouts. */
export async function findSessionFile(home: string, prefix: string): Promise<string | null> {
  if (!prefix) return null;
  const { list } = await collectCandidates(home, 'created');
  const hit = list.find((c) => c.id === prefix) ?? list.find((c) => c.id.startsWith(prefix));
  return hit?.file ?? null;
}

/** Find the newest session file under home/sessions matching an id prefix. */
export async function latestSession(home: string, prefix = ''): Promise<string | null> {
  return findSessionFile(home, prefix);
}

/**
 * Rebuild a chat transcript from a session log. Tool events don't record
 * tool_call_id, but the loop executes calls sequentially, so ids pair with
 * the tool events that follow their assistant message in order.
 */
export async function loadTranscript(file: string): Promise<SessionTranscript | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const out: SessionTranscript = { id: '', model: '', cwd: '', file, messages: [] };
  let pendingCallIds: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: SessionEvent;
    try {
      ev = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }
    if (ev.t === 'session/start') {
      out.id = ev.id;
      out.model = ev.model;
      out.cwd = ev.cwd;
    } else if (ev.t === 'user') {
      out.messages.push({ role: 'user', content: ev.text });
    } else if (ev.t === 'assistant') {
      const calls = (ev.tool_calls ?? []) as Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      out.messages.push({
        role: 'assistant',
        content: ev.text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      pendingCallIds = calls.map((c) => c.id);
    } else if (ev.t === 'tool') {
      out.messages.push({
        role: 'tool',
        tool_call_id: pendingCallIds.shift() ?? '',
        name: ev.name,
        content: ev.output,
      });
    }
    // approval / final events carry no chat turn
  }
  return out.id ? out : null;
}
