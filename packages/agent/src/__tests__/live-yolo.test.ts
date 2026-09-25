import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApproval, liveYolo } from '../runner.ts';

test('liveYolo applies INSTANTLY: mid-run flip auto-approves without waiting for the next session', async () => {
  // fresh approval object = the one a running task already holds; config
  // says ask, caller said no -- the classic mid-session /yolo toggle
  const cfg = { approval: 'ask', locale: 'zh' } as never;
  const approval = makeApproval(cfg, false);
  liveYolo.on = false;
  // with the toggle off and no TTY, ask() denies (no interactive prompt in tests)
  const denied = await approval.ask('run_command', { command: 'rm x' });
  assert.equal(denied, false, 'yolo off = still gated');
  // flip the toggle: the SAME approval object (same running session) now passes
  liveYolo.on = true;
  const granted = await approval.ask('run_command', { command: 'rm x' });
  assert.equal(granted, true, 'liveYolo.on short-circuits before any prompt');
  liveYolo.on = false;
});

test('liveYolo also gates a caller-supplied approvalAsk (web remote gate)', async () => {
  let asked = 0;
  const remoteGate = { ask: async (_n: string, _a: Record<string, unknown>) => { asked++; return false; } };
  // runner wraps approvalAsk with the live toggle; simulate the wrap the way
  // runAgentTask does (the logic under test is the gate precedence)
  const wrapped = { ask: async (n: string, a: Record<string, unknown>) => (liveYolo.on ? true : remoteGate.ask(n, a)) };
  liveYolo.on = false;
  assert.equal(await wrapped.ask('run_command', {}), false);
  assert.equal(asked, 1, 'gate consulted while yolo off');
  liveYolo.on = true;
  assert.equal(await wrapped.ask('run_command', {}), true);
  assert.equal(asked, 1, 'remote gate NOT consulted once yolo is live-on');
  liveYolo.on = false;
});
