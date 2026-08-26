/**
 * @hmh/kernel - session
 * Append-only JSONL session log under HMH_HOME/sessions/. Every loop event
 * is durably recorded - the audit trail the 2026 consensus calls
 * non-negotiable, and the raw material the evolution subsystem learns from.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type SessionEvent =
  | { t: 'session/start'; id: string; time: string; cwd: string; model: string }
  | { t: 'user'; time: string; text: string }
  | { t: 'assistant'; time: string; text: string | null; tool_calls?: unknown[] }
  | { t: 'tool'; time: string; name: string; output: string; isError: boolean }
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
  final(text: string, turns: number, toolUses: number): Promise<void> {
    return this.append({ t: 'final', time: new Date().toISOString(), text, turns, toolUses });
  }
}
