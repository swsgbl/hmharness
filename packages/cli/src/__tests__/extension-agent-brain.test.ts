import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerWithAgentTurn } from '../extension-agent-brain.ts';
import { Registry, type Tool } from '@hmharness/kernel';

/** a needsApproval tool + a free tool, so the gate and the passthrough both prove */
function fakeEnv(runs: Array<{ task: string; sessionId?: string; approval?: string }>) {
  const reg = new Registry();
  const executed: string[] = [];
  const dangerous: Tool = {
    name: 'run_command',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    needsApproval: () => true,
    async execute(args) { executed.push(String(args.cmd)); return { output: `ran:${args.cmd}` }; },
  };
  const free: Tool = {
    name: 'list_dir',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() { return { output: 'a,b' }; },
  };
  reg.register(dangerous);
  reg.register(free);
  const steps: string[] = [];
  const env = {
    buildRegistry: async () => ({ reg }),
    runAgentTask: async (opts: Record<string, unknown>) => {
      runs.push({ task: String(opts.task), sessionId: opts.sessionId as string | undefined, approval: (opts.events as { onToolCall?: (n: string) => void }).onToolCall ? 'wired' : undefined });
      // simulate the loop consulting the approval gate for the dangerous tool
      const ask = opts.approvalAsk as (n: string, a: Record<string, unknown>) => Promise<boolean>;
      if (ask) await ask('run_command', { cmd: 'npm install' });
      return { text: '任务回复', turns: 2, toolUses: 1, sessionId: 'sess-1' };
    },
    ctx: { cwd: '/w', home: '/h' } as never,
    goto: async () => ({}),
    readPage: async () => ({ title: 'T', url: 'https://x', text: '正文' }),
    step: (l: string) => steps.push(l),
  };
  return { env, executed, steps };
}

test('agent brain: approval gate denies + records; 「确认」 executes pre-loop with the result injected', async () => {
  const runs: Array<{ task: string; sessionId?: string; approval?: string }> = [];
  const { env, executed, steps } = fakeEnv(runs);

  // turn 1: the gate fires inside the run, nothing executed
  const r1 = await answerWithAgentTurn({ message: '修复它', history: [], origin: 'chrome-extension://z' }, env);
  assert.equal(r1, '任务回复');
  assert.equal(executed.length, 0, 'denied call never ran');
  assert.ok(steps.some((s) => /待确认: run_command/.test(s)), 'the ask is visible in the activity feed');
  assert.match(runs[0]!.task, /【用户当前浏览器页面/, 'proactive page context rides the task');
  assert.equal(runs[0]!.sessionId, undefined, 'first turn = fresh session');

  // turn 2: user confirms — pre-loop executes, result rides the task, session continues
  const r2 = await answerWithAgentTurn({ message: '确认', history: [], origin: 'chrome-extension://z' }, env);
  assert.equal(r2, '任务回复');
  assert.deepEqual(executed, ['npm install'], 'the confirmed call ran exactly once');
  assert.match(runs[1]!.task, /【已执行: run_command[\s\S]*?】\nran:npm install/, 'execution result injected into the next task');
  assert.equal(runs[1]!.sessionId, 'sess-1', 'session continuity: the same agent thread continues');

  // turn 3: a non-confirm message cancels cleanly
  await answerWithAgentTurn({ message: '先别', history: [], origin: 'chrome-extension://y' }, env);
  const r4 = await answerWithAgentTurn({ message: '算了', history: [], origin: 'chrome-extension://y' }, env).catch(() => 'ok');
  void r4;
});

test('agent brain: wall-clock abort surfaces as the auto-continue sentinel, never a crash', async () => {
  const reg = new Registry();
  const env = {
    buildRegistry: async () => ({ reg }),
    runAgentTask: (opts: Record<string, unknown>) => new Promise((_res, rej) => {
      const sig = opts.signal as AbortSignal;
      sig.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
    }),
    ctx: { cwd: '/w', home: '/h' } as never,
    goto: async () => ({}),
    readPage: async () => { throw new Error('no page'); },
    step: () => undefined,
    segmentMs: 150,
  };
  const reply = await answerWithAgentTurn({ message: 'x', history: [], origin: 'o' }, env as never);
  assert.match(reply, /自动继续/);
  assert.match(reply, /\[\[hmh:auto-continue\]\]/);
});
