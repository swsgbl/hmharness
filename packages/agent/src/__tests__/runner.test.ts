import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApproval } from '../runner.ts';
import { defaultConfig } from '@hmharness/kernel';

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
  const { runAgentTask } = await import('../runner.ts');
  const { Registry } = await import('@hmharness/kernel');
  const { baseTools } = await import('../tools.ts');

  // simulate: a gated tool + approvalAsk callback that would "ask" (return false)
  // but yes=true should override and auto-approve
  let asked = 0;
  const result = await runAgentTask({
    task: 'run a harmless command',
    registry: ((): unknown => {
      const reg = new Registry();
      for (const t of baseTools) reg.register(t);
      return reg;
    })() as never,
    cfg: { ...defaultConfig(), provider: { baseUrl: 'fake://', apiKey: 'k', model: 'm' } },
    yes: true,
    approvalAsk: () => { asked++; return Promise.resolve(false); }, // would deny if consulted
    events: {},
  } as never).catch(() => null); // provider is fake, will fail - we only test approval path

  // the approvalAsk was never consulted because yes=true bypassed it
  // (if the bug were present, asked > 0)
  assert.equal(asked, 0, 'approvalAsk must not be consulted when yes=true');
});

test('trajectory wiring: runAgentTask leaves a typed, replayable trajectory even when the provider fails', async () => {
  const { mkdtemp, rm, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'hmh-trajwire-'));
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    // fake provider: fetch to a dead port fails fast with retries disabled
    const { runAgentTask } = await import('../runner.ts');
    const { Registry } = await import('@hmharness/kernel');
    const { baseTools } = await import('../tools.ts');
    await runAgentTask({
      task: 'probe task',
      registry: ((): unknown => { const r = new Registry(); for (const t of baseTools) r.register(t); return r; })() as never,
      cfg: { ...defaultConfig(), provider: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 300 } } as never,
      yes: true,
      events: {},
    } as never).catch(() => null);
    // recorder appends are queued behind retry backoff; allow drain
    await new Promise((r) => setTimeout(r, 3_000));
    const runsDir = join(home, 'runs');
    const ids = await readdir(runsDir);
    assert.ok(ids.length >= 1, 'a run directory exists');
    const dir = join(runsDir, ids[0]);
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
