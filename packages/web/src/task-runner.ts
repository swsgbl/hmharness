/**
 * @hmharness/web - task-runner (per-session child executor, W15)
 *
 * dsh-parity session independence: each running task executes in its OWN
 * child process - real cwd isolation (no global chdir dance), crash
 * containment (a runaway task can never take the daemon down), and daemon
 * death does not kill the run (the child finishes and the rollout lands).
 *
 * Protocol (zero-dep, ndjson both ways):
 *   spawn: node task-runner.js <payloadFile>
 *   payloadFile (deleted after read): { task, mode, yes, fresh, sessionId,
 *     cwd, home, resumeMessages?, goal? }
 *   child -> daemon (stdout, one JSON per line):
 *     {kind:'line'|'delta'|'tool'|'toolResult'|'approvalReq'|'approvalDone'|'injected'|'final'|'error', ...}
 *   daemon -> child (stdin, one JSON per line):
 *     {type:'inject', text} | {type:'abort'} | {type:'approval', granted}
 *
 * stdout is best-effort after the daemon dies (EPIPE tolerated): the
 * rollout remains the durable record either way.
 */
import { readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';

interface Payload {
  task: string;
  mode: string;
  yes: boolean;
  fresh: boolean;
  sessionId: string;
  cwd: string;
  home: string;
  resumeMessages?: Array<{ role: string; content: unknown }>;
  goal?: string | null;
}

function emit(obj: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch { /* daemon gone (EPIPE): keep running, the rollout is the record */ }
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];
  if (!payloadFile) { emit({ kind: 'error', error: 'payload file required' }); process.exit(2); }
  let payload: Payload;
  try {
    payload = JSON.parse(await readFile(payloadFile, 'utf8')) as Payload;
    await rm(payloadFile, { force: true }); // secrets in task text never linger
  } catch (err) {
    emit({ kind: 'error', error: 'bad payload: ' + String(err).slice(0, 120) });
    process.exit(2);
    return;
  }

  const { buildRegistry, runAgentTask } = await import('@hmharness/agent');
  const kernel = await import('@hmharness/kernel');

  // steering channel: stdin lines are drained into the runner's inject poll
  const injectQueue: Array<{ text: string }> = [];
  const approvals = new Map<number, (granted: boolean) => void>();
  let approvalSeq = 0;
  const abort = new AbortController();

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { type?: string; text?: string; granted?: boolean; id?: number };
      if (msg.type === 'inject' && typeof msg.text === 'string') injectQueue.push({ text: msg.text });
      else if (msg.type === 'abort') abort.abort();
      else if (msg.type === 'approval' && typeof msg.id === 'number') approvals.get(msg.id)?.(msg.granted === true);
    } catch { /* malformed line: ignore */ }
  });
  rl.on('close', () => { /* daemon gone: no more steering, run continues */ });

  const cfg = await kernel.loadConfig();
  const unattended = payload.yes || cfg.approval === 'auto';
  const { reg } = await buildRegistry({ announce: false });

  const result = await runAgentTask({
    task: payload.task,
    registry: reg,
    cfg,
    yes: payload.yes,
    resumeMessages: payload.resumeMessages as never,
    sessionId: payload.fresh ? undefined : payload.sessionId,
    signal: abort.signal,
    inject: { poll: () => { const n = injectQueue.shift(); return n ? [n] : []; } },
    goal: payload.goal,
    ctx: { cwd: payload.cwd, home: payload.home },
    approvalAsk: unattended ? undefined : (name, args) => new Promise<boolean>((resolve) => {
      const id = ++approvalSeq;
      approvals.set(id, resolve);
      emit({ kind: 'approvalReq', id, name, args });
    }),
    events: {
      onLine: (text) => emit({ kind: 'line', text }),
      onDelta: (k, chunk) => emit({ kind: 'delta', k, chunk }),
      onToolCall: (name, args) => emit({ kind: 'tool', name, args }),
      onToolResult: (name, output, isError) => emit({ kind: 'toolResult', name, output: output.slice(0, 8000), isError }),
      onApproval: (name, args, granted) => emit({ kind: 'approvalDone', name, args, granted }),
      onInjected: (text) => emit({ kind: 'injected', text }),
    },
  });

  emit({
    kind: 'final',
    text: result.text,
    sessionId: result.sessionId,
    turns: result.turns,
    toolUses: result.toolUses,
    usage: result.usage,
    // user/assistant turns only, assistant tool_calls stripped - the next
    // run prepends its own system prompt and must not inherit dangling
    // tool-call pairs (same trimming the old in-process path did)
    messages: (result.messages ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => (m.role === 'assistant' && m.tool_calls ? { role: 'assistant', content: m.content } : m)),
  });
  // the stdin readline keeps the event loop alive forever - without this
  // the child lingers after its final event and the session stays "busy"
  rl.close();
  process.stdout.write('', () => process.exit(0));
  process.exit(0);
}

main().catch((err) => {
  emit({ kind: 'error', error: String(err).slice(0, 400) });
  process.exit(1);
});
