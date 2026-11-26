/**
 * A refusal is not a failure (2026-11-26).
 *
 * The action gate is built from success/failure statistics of past tool calls.
 * A call the gate refused never ran - but it used to be written down as a
 * FAILED call of that tool, and learned from. So every refusal of a blocked
 * action added one more failure to the very table that blocked it: on the
 * machine this was found on, `web_search` sat at 0 of 23 with no way back,
 * and the gate's own refusals were among the 23.
 *
 * The kernel now marks a tool result that never ran ('gate' / 'declined'), and
 * the cognitive recorder drops such a step instead of closing it as a failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop, Registry, defaultConfig, type ChatMessage, type Tool } from '@hmharness/kernel';
import { loadTrajectories } from '@hmharness/cognitive';
import { runAgentTask } from '../runner.ts';
import { CognitiveRunRecorder } from '../cognitive-recorder.ts';
import { baseTools } from '../tools.ts';

const echo: Tool = {
  name: 'echo', description: 'echo the text back', readOnly: true,
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) { return { output: 'pong:' + String(args.text ?? '') }; },
};

// ---- the kernel marks what never ran ----

test('kernel: a refused call and a declined call are reported as not run; a real error is not', async () => {
  const boom: Tool = { ...echo, name: 'boom', async execute() { return { output: 'it broke', isError: true }; } };
  const gated: Tool = { ...echo, name: 'gated', needsApproval: () => true };
  const results: Array<[string, boolean, string | undefined]> = [];
  const script = [{ tool: 'boom' }, { tool: 'gated' }, { tool: 'echo' }, { text: 'done' }];
  let i = 0;
  const chat = async () => {
    const step = script[Math.min(i++, script.length - 1)]!;
    const calls = step.tool ? [{ id: 'c' + i, type: 'function' as const, function: { name: step.tool, arguments: '{"text":"x"}' } }] : undefined;
    return { message: { role: 'assistant' as const, content: step.text ?? null, ...(calls ? { tool_calls: calls } : {}) } };
  };
  const r = await runLoop({
    provider: { baseUrl: 'x', apiKey: 'k', model: 'm' } as never,
    registry: new Registry().register(boom).register(gated).register(echo) as never,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: chat as never,
    events: { onToolResult: (name, _out, isError, notRun) => results.push([name, isError, notRun]) },
    // the gate refuses 'echo' outright: everything named echo is refused
    toolGate: { check: async (name) => (name === 'echo' ? { allowed: false, reason: 'predicted to fail' } : { allowed: true }) },
    approval: { ask: async () => false }, // the user declines
  });
  assert.equal(r.reason, 'final');
  assert.deepEqual(results, [
    ['boom', true, undefined],    // ran and failed: the tool's own failure
    ['gated', true, 'declined'],  // never ran: the user said no
    ['echo', true, 'gate'],       // never ran: the gate refused it
  ]);
});

// ---- the recorder drops it ----

test('recorder: a call that never ran leaves no step', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-skip-'));
  try {
    const rec = new CognitiveRunRecorder(home, 'task', 'sess-1', process.cwd());
    rec.call('echo', {});
    rec.skip('echo');           // refused before it ran
    rec.call('echo', {});
    rec.result('echo', 'pong', false);
    await rec.finish(true, { turns: 1, toolUses: 1, task: 'task' });
    const steps = (await loadTrajectories(home, 1000)).flatMap((t) => t.steps).filter((s) => s.action.type === 'echo');
    assert.deepEqual(steps.map((s) => s.outcome), ['success'], 'only the call that really ran is on record');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---- end to end: the gate blocks an action, and its refusals do not feed the table ----

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-gate-rec-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(home); } finally {
    if (prev === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test('end to end: past failures block `echo`, it runs once for real, and the later refusal is NOT recorded as a failure', async () => {
  await withTempHome(async (home) => {
    // ten recent trajectories in which echo always failed: enough to block it
    const dir = join(home, 'cognitive', 'trajectories');
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    for (let n = 0; n < 10; n++) {
      await writeFile(join(dir, `seed-${n}.jsonl`), JSON.stringify({
        id: `seed-${n}`, sessionId: `seed-s-${n}`, startedAt: now, endedAt: now,
        environment: { id: 'terminal', version: '1.0.0' }, goal: { id: `g-${n}`, description: 'seed' },
        steps: Array.from({ length: 10 }, (_s, i) => ({ step: i + 1, action: { id: `a${i}`, type: 'echo', args: {}, reason: 'seed' }, outcome: 'failure', evidence: [], durationMs: 1 })),
        metrics: { actions: 10, successes: 0, failures: 10, recoveries: 0, durationMs: 1 },
      }) + '\n', 'utf8');
    }

    // a model that calls echo twice in a row, then answers
    const seen: ChatMessage[][] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => { void handle(req, res); });
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      let body = '';
      for await (const part of req) body += part;
      if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
      const parsed = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[]; stream?: boolean };
      const messages = parsed.messages ?? [];
      const toolResultsSoFar = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).filter((m) => m.role === 'tool').length;
      const withTools = (parsed.tools ?? []).length > 0;
      if (withTools) seen.push(messages);
      const call = withTools && toolResultsSoFar < 2
        ? [{ id: 'call_' + seen.length, type: 'function' as const, function: { name: 'echo', arguments: '{"text":"hi"}' } }]
        : undefined;
      // the runner streams; answer in whichever form the request asked for
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
        if (call) res.write(chunk({ tool_calls: call.map((c) => ({ index: 0, ...c })) }));
        if (!call) res.write(chunk({ content: 'done' }));
        res.write(chunk({}, call ? 'tool_calls' : 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: call ? null : 'done', ...(call ? { tool_calls: call } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const reg = new Registry();
      for (const t of baseTools) reg.register(t);
      reg.register(echo);
      const r = await runAgentTask({
        task: 'echo twice',
        registry: reg as never,
        cfg: { ...defaultConfig(), provider: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }, gate: { enabled: true, tau: 0.4 } } as never,
        yes: true, events: {},
      });
      assert.equal(r.reason, 'final', 'the task finished; text=' + JSON.stringify(r.text));
      // the first call ran for real (the gate's one real run)…
      assert.ok(seen.length >= 2, 'two model requests (got ' + seen.length + ')');
      const afterFirst = seen[1]!.filter((m) => m.role === 'tool');
      assert.equal(afterFirst.length, 1);
      assert.match(String(afterFirst[0]!.content), /^pong:/, 'the first echo call ran');
      // …and the second call was refused by the gate
      const runDir = join(home, 'runs');
      const events = (await Promise.all((await readdir(runDir)).map(async (id) => readFile(join(runDir, id, 'trajectory.jsonl'), 'utf8'))))
        .join('\n').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
      assert.equal(events.filter((e) => e.type === 'tool.completed' && e.payload.notRun === 'gate').length, 1, 'the second call did not run: the gate refused it');
      // what the cognitive store learned about `echo` in THIS run: the one real success, no failure
      const mine = (await loadTrajectories(home, 1000)).find((t) => t.sessionId === r.sessionId);
      assert.ok(mine, 'this run left a trajectory');
      const echoSteps = mine.steps.filter((s) => s.action.type === 'echo');
      assert.deepEqual(echoSteps.map((s) => s.outcome), ['success'], 'the refusal is not on record as a failed echo');
    } finally {
      await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    }
  });
});
