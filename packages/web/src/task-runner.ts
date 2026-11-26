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
  /** Native image data URLs for multimodal chat models (2026-10-22): the
   * server only sets this when the CHAT provider sees images; text-only
   * chats get their images described into the task text instead. */
  images?: string[];
  /** The caller said "ask" on purpose (the web UI's mode select): the run asks before
   *  every gated tool even when the saved config is on `auto`. Until 0.23.55 the saved
   *  config won, so the select read "审批询问" while every tool call went through. */
  ask?: boolean;
}

function emit(obj: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch { /* daemon gone (EPIPE): keep running, the rollout is the record */ }
}

let steering: ReturnType<typeof createInterface> | null = null;

/** End the process without cutting a handle mid-close. The stdin readline is what keeps
 *  the event loop alive, so the old exit was `rl.close(); process.exit(0)` - and that
 *  `process.exit()` crashed EVERY child on Windows at the end of EVERY task (libuv
 *  assertion in async.c, exit code 0xC0000409; invisible while the final event had gone
 *  out first). Now: close the readline, drop the interest in stdin, let stdout flush and
 *  let Node end the process by itself. Anything still alive a moment later is cut off. */
async function shutdown(code: number): Promise<never> {
  try { steering?.close(); } catch { /* already closed */ }
  process.stdin.pause();
  (process.stdin as { unref?: () => void }).unref?.();
  await new Promise<void>((done) => process.stdout.write('', () => done()));
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
  return new Promise<never>(() => { /* the loop empties and the process ends */ });
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

  steering = createInterface({ input: process.stdin });
  steering.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { type?: string; text?: string; granted?: boolean; id?: number };
      if (msg.type === 'inject' && typeof msg.text === 'string') injectQueue.push({ text: msg.text });
      else if (msg.type === 'abort') abort.abort();
      else if (msg.type === 'approval' && typeof msg.id === 'number') approvals.get(msg.id)?.(msg.granted === true);
    } catch { /* malformed line: ignore */ }
  });
  steering.on('close', () => { /* daemon gone: no more steering, run continues */ });

  const cfg = await kernel.loadConfig();
  // An explicit "ask" from the caller is the user's per-task intent and outranks the
  // saved default. A caller that never said "ask" (older clients, plain API use) keeps
  // the old rule: config auto means nobody is there to answer a dialog.
  const unattended = payload.yes || (cfg.approval === 'auto' && payload.ask !== true);
  const { reg } = await buildRegistry({ announce: false });

  const result = await runAgentTask({
    task: payload.task,
    images: payload.images,
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
      // an abort while THIS promise pends must resolve it (denied): the
      // daemon-side interrupt/deny does it, but a lost stdin or a crashed
      // daemon would otherwise park the child here forever, holding the
      // session busy (double-resolve is a no-op on a settled promise)
      const onAbort = () => {
        if (approvals.get(id) === resolve) approvals.delete(id);
        resolve(false);
      };
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener('abort', onAbort, { once: true });
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
  return shutdown(0);
}

main().catch((err) => {
  // sessionId rides along when the runner attached it (task-level failures):
  // the daemon can keep the session bound for export/next-task instead of
  // orphaning the rollout on disk
  emit({ kind: 'error', error: String(err).slice(0, 400), sessionId: (err as { sessionId?: string }).sessionId });
  void shutdown(1);
});
