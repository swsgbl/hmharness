import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpServer, type AcpIo, type AcpRunTask, type AcpRunTaskArgs } from '../acp-serve.ts';

/** injected rollout plumbing — no real Session files in protocol tests */
let rolloutSeq = 0;
const fakeCreateRollout = async () => `rollout-${++rolloutSeq}`;
const fakeLoadRollout = async (sid: string) => (sid === 'rollout-1' ? [{ role: 'user' as const, content: 'old turn' }] : undefined);

interface Frame {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

function makeIo(permissionOutcome = { outcome: { outcome: 'selected', optionId: 'allow' } }): { io: AcpIo; frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    io: {
      send: (f) => frames.push(f as Frame),
      request: async () => permissionOutcome,
    },
  };
}

/** deterministic HMH_HOME for loadConfig inside session/prompt */
async function freshHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'hmh-acp-test-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = h;
  (process as unknown as { __acpPrevHome?: string }).__acpPrevHome = prev;
  return h;
}
async function dropHome(): Promise<void> {
  const p = (process as unknown as { __acpPrevHome?: string }).__acpPrevHome;
  if (p !== undefined) process.env.HMH_HOME = p;
}

/** stub runner: streams deltas + one tool call, honours the abort signal,
 *  exercises the permission round-trip, returns a resumable transcript */
function stubRun(seen: AcpRunTaskArgs[], waitMs = 0): AcpRunTask {
  return async (a) => {
    seen.push(a);
    a.events.onDelta?.('text', 'hello ');
    a.events.onDelta?.('reasoning', 'thinking...');
    a.events.onToolCall?.('read_file', { file: 'a.ts' });
    a.events.onToolResult?.('read_file', 'file contents here', false);
    const allowed = a.approvalAsk ? await a.approvalAsk('run_command', { command: 'echo hi' }) : undefined;
    if (waitMs > 0) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, waitMs);
        a.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
      });
    }
    return {
      text: 'hello done' + (allowed === false ? ' (denied)' : ''),
      turns: 1,
      toolUses: 1,
      sessionId: 'hmh-rollout-1',
      messages: [{ role: 'assistant' as const, content: 'hello done' }],
    };
  };
}

test('acp: initialize handshake echoes the client version and declares capabilities', async () => {
  const home = await freshHome();
  try {
    const { io, frames } = makeIo();
    const srv = createAcpServer({ io, createRollout: fakeCreateRollout, loadRollout: fakeLoadRollout });
    await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '0.4.5', clientCapabilities: {} } });
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.id, 1);
    assert.equal(frames[0]!.result.protocolVersion, '0.4.5');
    assert.equal(frames[0]!.result.agentCapabilities.loadSession, true);
    // unknown SESSION -> invalid params; unknown METHOD -> not found
    await srv.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] } });
    assert.equal(frames[1]!.error!.code, -32602);
    await srv.handle({ jsonrpc: '2.0', id: 3, method: 'wat/ever' });
    assert.equal(frames[2]!.error!.code, -32601);
    // notifications (no id) never emit responses
    await srv.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'nope' } });
    assert.equal(frames.length, 3);
  } finally { await dropHome(); await rm(home, { recursive: true, force: true }); }
});

test('acp: session/load restores a prior rollout (host reconnects instead of respawning)', async () => {
  const home = await freshHome();
  try {
    const { io, frames } = makeIo();
    const seen: AcpRunTaskArgs[] = [];
    const srv = createAcpServer({ io, runTask: stubRun(seen), createRollout: fakeCreateRollout, loadRollout: fakeLoadRollout });
    await srv.handle({ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 'rollout-1', cwd: process.cwd() } });
    assert.equal(frames[0]!.result.sessionId, 'rollout-1');
    // a prompt on the loaded session resumes the restored transcript
    await srv.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'rollout-1', prompt: [{ type: 'text', text: 'continue' }] } });
    assert.equal(seen[0]!.sessionId, 'rollout-1');
    assert.equal((seen[0]!.resumeMessages as Array<{ content: string }>)[0]!.content, 'old turn');
    // unknown rollout still loads (runner falls back to a fresh session)
    await srv.handle({ jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: 'rollout-gone' } });
    assert.equal(frames.find((f) => f.id === 3)!.result.sessionId, 'rollout-gone');
  } finally { await dropHome(); await rm(home, { recursive: true, force: true }); }
});

test('acp: one prompt streams the full update sequence and resumes the next turn', async () => {
  const home = await freshHome();
  try {
    const { io, frames } = makeIo();
    const seen: AcpRunTaskArgs[] = [];
    const srv = createAcpServer({ io, runTask: stubRun(seen), createRollout: fakeCreateRollout, loadRollout: fakeLoadRollout });
    await srv.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sid = frames[0]!.result.sessionId as string;
    await srv.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'do it' }] } });
    const upd = frames.filter((f) => f.method === 'session/update').map((f) => f.params.update);
    assert.deepEqual(upd.map((u) => u.sessionUpdate), ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);
    assert.equal(upd[0].content.text, 'hello ');
    assert.equal(upd[1].content.text, 'thinking...');
    assert.equal(upd[2].kind, 'read');
    assert.equal(upd[2].title, 'read_file a.ts');
    assert.equal(upd[2].status, 'pending');
    assert.equal(upd[3].status, 'completed');
    assert.equal(upd[3].content[0].content.text, 'file contents here');
    assert.equal(frames.find((f) => f.id === 2)!.result.stopReason, 'end_turn');
    // second turn on the same session resumes the rollout + transcript
    await srv.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] } });
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.sessionId, 'hmh-rollout-1');
    assert.equal((seen[1]!.resumeMessages as Array<{ content: string }>)[0]!.content, 'hello done');
    assert.equal(frames.find((f) => f.id === 3)!.result.stopReason, 'end_turn');
  } finally { await dropHome(); await rm(home, { recursive: true, force: true }); }
});

test('acp: cancel aborts the running turn -> stopReason cancelled; session frees for the next prompt', async () => {
  const home = await freshHome();
  try {
    const { io, frames } = makeIo();
    const seen: AcpRunTaskArgs[] = [];
    const srv = createAcpServer({ io, runTask: stubRun(seen, 5_000), createRollout: fakeCreateRollout, loadRollout: fakeLoadRollout });
    await srv.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
    const sid = frames[0]!.result.sessionId as string;
    const slow = srv.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'long task' }] } });
    await new Promise((r) => setTimeout(r, 30));
    await srv.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    await slow;
    // aborted turn ends with an honest error chunk + cancelled stop reason
    assert.equal(frames.find((f) => f.id === 2)!.result.stopReason, 'cancelled');
    const lastUpd = frames.filter((f) => f.method === 'session/update').map((f) => f.params.update).at(-1)!;
    assert.equal(lastUpd.sessionUpdate, 'agent_message_chunk');
    assert.match(lastUpd.content.text, /aborted/);
    // session is free again: a follow-up prompt runs to completion
    await srv.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'next' }] } });
    assert.equal(frames.find((f) => f.id === 3)!.result.stopReason, 'end_turn');
  } finally { await dropHome(); await rm(home, { recursive: true, force: true }); }
});

test('acp: permission rejection denies the gated tool, allow passes it', async () => {
  const home = await freshHome();
  try {
    const verdictRunner: AcpRunTask = async (a) => {
      const allowed = a.approvalAsk ? await a.approvalAsk('run_command', { command: 'x' }) : null;
      a.events.onDelta?.('text', allowed === false ? 'DENIED' : 'ALLOWED');
      return { text: '', turns: 1, toolUses: 0, sessionId: 's1', messages: [] };
    };
    for (const [outcome, expect] of [
      [{ outcome: { outcome: 'selected', optionId: 'reject' } }, 'DENIED'],
      [{ outcome: { outcome: 'selected', optionId: 'allow' } }, 'ALLOWED'],
    ] as const) {
      const { io, frames } = makeIo(outcome as never);
      const srv = createAcpServer({ io, runTask: verdictRunner, createRollout: fakeCreateRollout, loadRollout: fakeLoadRollout });
      await srv.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
      const sid = frames[0]!.result.sessionId as string;
      await srv.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'x' }] } });
      const chunks = frames.filter((f) => f.method === 'session/update').map((f) => f.params.update.content.text);
      assert.equal(chunks.at(-1), expect);
    }
  } finally { await dropHome(); await rm(home, { recursive: true, force: true }); }
});
