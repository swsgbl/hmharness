/**
 * @hmh/kernel - session
 * Append-only JSONL session log under HMH_HOME/sessions/. Every loop event
 * is durably recorded - the audit trail the 2026 consensus calls
 * non-negotiable, and the raw material the evolution subsystem learns from.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from './types.ts';

export type SessionEvent =
  | { t: 'session/start'; id: string; time: string; cwd: string; model: string }
  | { t: 'user'; time: string; text: string }
  | { t: 'assistant'; time: string; text: string | null; tool_calls?: unknown[] }
  | { t: 'tool'; time: string; name: string; output: string; isError: boolean }
  | { t: 'approval'; time: string; tool: string; granted: boolean }
  | { t: 'final'; time: string; text: string; turns: number; toolUses: number };

export class Session {
  readonly id: string;
  readonly file: string;

  constructor(home: string, cwd: string, model: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.id = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    this.file = join(home, 'sessions', `${this.id}.jsonl`);
    void this.append({ t: 'session/start', id: this.id, time: new Date().toISOString(), cwd, model });
  }

  async append(event: SessionEvent): Promise<void> {
    const dir = join(this.file, '..');
    await mkdir(dir, { recursive: true });
    await appendFile(this.file, JSON.stringify(event) + '\n', 'utf8');
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

export interface SessionTranscript {
  id: string;
  model: string;
  cwd: string;
  messages: ChatMessage[];
}

/** Find the newest session file under home/sessions matching an id prefix. */
export async function latestSession(home: string, prefix = ''): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(join(home, 'sessions'))).filter((f) => f.endsWith('.jsonl') && f.startsWith(prefix));
  } catch {
    return null;
  }
  files.sort();
  return files.length > 0 ? join(home, 'sessions', files[files.length - 1]) : null;
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
  const out: SessionTranscript = { id: '', model: '', cwd: '', messages: [] };
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
