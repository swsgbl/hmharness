import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApproval, runAgentTask } from '../runner.ts';
import { baseTools } from '../tools.ts';
import { Registry, defaultConfig, type ChatMessage, type Tool } from '@hmharness/kernel';

/** A model on the loopback that answers at once. It replaces a provider that
 *  cannot be reached at all: the kernel retries that with backoff for 159 s
 *  (measured 2026-11-27 - 6 attempts, and on Windows each connect takes ~4 s
 *  despite a 300 ms timeout), and three tests here used to spend that long
 *  EACH - which is what set the wall-clock time of the whole suite.
 *    fail:  every request gets HTTP 401 - not retried, the task fails at once
 *    call:  the first request that carries tools gets one call to it, then 'done' */
async function standInModel(opts: { fail?: boolean; call?: Tool } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => { void handle(req, res); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const part of req) body += part;
    if (!(req.url ?? '').includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    if (opts.fail) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } })); return; }
    const parsed = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[]; stream?: boolean };
    const messages = parsed.messages ?? [];
    const withTools = (parsed.tools ?? []).length > 0;
    const answered = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).some((m) => m.role === 'tool');
    const call = opts.call && withTools && !answered ? [{ id: 'call_1', type: 'function' as const, function: { name: opts.call.name, arguments: '{}' } }] : undefined;
    const text = call ? null : 'done';
    // the runner streams; answer in whichever form the request asked for
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
      if (call) res.write(chunk({ tool_calls: call.map((c) => ({ index: 0, ...c })) }));
      if (text) res.write(chunk({ content: text }));
      res.write(chunk({}, call ? 'tool_calls' : 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...(call ? { tool_calls: call } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const providerFor = (url: string): { baseUrl: string; apiKey: string; model: string } => ({ baseUrl: url, apiKey: 'k', model: 'm' });
const registryWith = (extra?: Tool): Registry => { const r = new Registry(); for (const t of baseTools) r.register(t); if (extra) r.register(extra); return r; };

test('approval gate: yes / config-auto pass without a TTY; ask denies headless', async () => {
  // --yes / --yolo: every gate passes, nothing may block the loop
  const yolo = makeApproval(defaultConfig(), true);
  assert.equal(await yolo.ask('run_command', { command: 'x' }), true);
  assert.equal(await yolo.ask('write_file', { path: 'a' }), true);

  // config-level approval:'auto' behaves the same even with yes=false
  const auto = makeApproval({ ...defaultConfig(), approval: 'auto' }, false);
  assert.equal(await auto.ask('run_command', { command: 'x' }), true);

  // default 'ask' in a non-TTY (how the web server / pipes run): deny-first
  const ask = makeApproval(defaultConfig(), false);
  if (!process.stdin.isTTY) {
    assert.equal(await ask.ask('run_command', { command: 'x' }), false);
  }
});

test('YOLO fix: when yes=true, caller-provided approvalAsk must NOT override auto-approve', async () => {
  // this is the exact bug: the TUI always passes approvalAsk for its nice
  // dialog, but that used to take precedence over the yes flag - so /yolo
  // was cosmetic and the dialog kept popping (user-reported "still asks")
  //
  // The model has to CALL a gated tool for the gate to matter. This test used
  // to run against a provider that fails on the very first request: nothing
  // ever reached the gate, `asked` was 0 whatever the code did - it passed
  // with the bug put back (checked 2026-11-27), after 159 s of retries.
  let ran = 0;
  const gated: Tool = {
    name: 'gated', description: 'a tool that always needs approval',
    parameters: { type: 'object', properties: {} }, needsApproval: () => true,
    async execute() { ran++; return { output: 'ran' }; },
  };
  const model = await standInModel({ call: gated });
  let asked = 0;
  const run = (yes: boolean): Promise<unknown> => runAgentTask({
    task: 'call the gated tool', registry: registryWith(gated), cfg: { ...defaultConfig(), provider: providerFor(model.url) },
    yes,
    approvalAsk: () => { asked++; return Promise.resolve(false); }, // would deny if consulted
    events: {},
  } as never);
  try {
    // positive control first: without /yolo the caller's gate IS consulted
    const denied = await run(false);
    assert.equal(asked, 1, 'without /yolo the caller-supplied gate is consulted exactly once');
    assert.equal(ran, 0, 'and its denial holds: the gated tool did not run');
    assert.equal((denied as { reason?: string }).reason, 'final', 'the task still finishes');

    // now with /yolo: the approvalAsk is never consulted, the tool runs
    await run(true);
    assert.equal(asked, 1, 'approvalAsk must not be consulted when yes=true');
    assert.equal(ran, 1, 'the gated tool ran without asking');
  } finally { await model.close(); }
});

test('trajectory wiring: runAgentTask leaves a typed, replayable trajectory even when the provider fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-trajwire-'));
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  // the provider rejects the task at once (HTTP 401 is never retried)
  const model = await standInModel({ fail: true });
  try {
    await runAgentTask({
      task: 'probe task',
      registry: registryWith(),
      cfg: { ...defaultConfig(), provider: providerFor(model.url) },
      yes: true,
      events: {},
    } as never).catch(() => null);
    // read at once - the run record is on disk by the time the task returns
    // (it used to need a 3 s drain here: the appends queued behind 159 s of
    // retry backoff)
    const runsDir = join(home, 'runs');
    const ids = await readdir(runsDir);
    assert.ok(ids.length >= 1, 'a run directory exists');
    const dir = join(runsDir, ids[0]!);
    const raw = await readFile(join(dir, 'trajectory.jsonl'), 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as { type: string; actor: string; id?: string; ts?: string });
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'run.created');
    assert.ok(types.includes('context.assembled'), 'context event recorded');
    assert.equal(types[types.length - 1], 'run.failed', 'provider failure recorded as run.failed');
    assert.ok(events.every((e) => e.id && e.ts), 'events carry id+ts');
    const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as { task: string; outcome: { success: boolean } };
    assert.equal(summary.task, 'probe task');
    assert.equal(summary.outcome.success, false);
  } finally {
    process.env.HMH_HOME = prevHome;
    await model.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a thrown task error carries sessionId: the rollout stays bound for /export and resume (2026-10-08)', async () => {
  // regression: a provider HTTP 400 killed the task AFTER the session file
  // was created and the user event written — but the throw hid the id, the
  // TUI never bound currentSessionId on the error path, and /export said
  // "还没有可导出的会话内容" while the rollout sat complete on disk.
  const home = await mkdtemp(join(tmpdir(), 'hmh-siderr-'));
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  // any provider error the kernel does not retry does; 401 is the fastest one
  const model = await standInModel({ fail: true });
  try {
    const err = await runAgentTask({
      task: 'probe task',
      registry: registryWith(),
      cfg: { ...defaultConfig(), provider: providerFor(model.url) },
      yes: true,
      events: {},
    } as never).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error, 'the failing provider surfaces as an error');
    const sid = (err as Error & { sessionId?: string }).sessionId;
    assert.ok(typeof sid === 'string' && sid.length > 0, 'the error carries the sessionId the runner created');
    // the rollout lands in a date-nested dir (sessions/YYYY/MM/DD/<id>.jsonl)
    // - find it without hard-coding today's date
    const findRollout = async (d: string): Promise<string | null> => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const f = join(d, e.name);
        if (e.isDirectory()) { const hit = await findRollout(f); if (hit) return hit; }
        else if (e.name === sid + '.jsonl') return f;
      }
      return null;
    };
    const file = await findRollout(join(home, 'sessions'));
    assert.ok(file, 'that exact rollout file exists on disk (sid=' + sid + ')');
  } finally {
    process.env.HMH_HOME = prevHome;
    await model.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('approved-rules: structured matching blocks path traversal (review security fix)', async () => {
  const mod = await import('../runner.ts');
  const matchesRule = (mod as unknown as { matchesRule: (r: Array<{tool:string;argPrefix:string;time:string}>, t: string, a: Record<string, unknown>) => boolean }).matchesRule;
  assert.equal(typeof matchesRule, 'function', 'matchesRule exported');
  const rules = [{ tool: 'run_command', argPrefix: '{"command":"node scripts/"}', time: 'now' }];
  assert.equal(matchesRule(rules, 'run_command', { command: 'node scripts/publish.cjs' }), true, 'path-safe extension passes');
  assert.equal(matchesRule(rules, 'run_command', { command: 'node scripts/../../evil.js' }), false, 'path traversal blocked');
  assert.equal(matchesRule(rules, 'run_command', { command: 'node scripts/sub/../../evil.js' }), false, 'NESTED traversal blocked (first differing segment is not ..)');
  assert.equal(matchesRule(rules, 'run_command', { command: 'node scripts/a/b/../../../evil.js' }), false, 'deep traversal blocked');
  assert.equal(matchesRule(rules, 'run_command', { command: 'node scripts/a\\b\\..\\..\\evil.js' }), false, 'windows-separator traversal blocked');
  assert.equal(matchesRule(rules, 'write_file', { command: 'node scripts/x' }), false, 'different tool blocked');
});
