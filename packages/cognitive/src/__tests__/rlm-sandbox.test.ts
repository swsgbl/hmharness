import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RLMRuntime } from '../rlm.ts';
import { runSandboxedEval } from '../rlm-sandbox.ts';

test('rlm-sandbox: infinite loop is terminated at the timeout, host survives', async () => {
  const t0 = Date.now();
  const r = await runSandboxedEval('while (true) { /* burn */ }', {}, {}, { timeoutMs: 800 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_SANDBOX_TIMEOUT');
  assert.equal(r.terminated, true);
  assert.ok(Date.now() - t0 < 5_000, 'termination must be prompt (worker.terminate, not a soft wait)');
  // the runtime (and thus the whole host process) is still usable afterwards
  const after = await runSandboxedEval('return 1 + 1;', {}, {}, { timeoutMs: 5_000 });
  assert.equal(after.ok, true);
  assert.equal(after.value, 2);
});

test('rlm-sandbox: throwing eval is contained and reported as E_EVAL', async () => {
  const r = await runSandboxedEval('null.x', {}, {}, { timeoutMs: 5_000 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'E_EVAL');
  assert.match(r.error?.message ?? '', /Cannot read|null/);
});

test('rlm-sandbox: host environment secrets are NOT inherited (env: {})', async () => {
  process.env.HMH_SANDBOX_PROBE = 'super-secret-value';
  try {
    // process is shadowed to undefined inside the eval scope first
    const shadowed = await runSandboxedEval('try { return process === undefined ? "shadowed" : "leaked"; } catch { return "shadowed-throw"; }', {}, {}, { timeoutMs: 5_000 });
    assert.equal(shadowed.value, 'shadowed');
    // even a determined probe must find an EMPTY env (worker env scrub), not host secrets
    const envProbe = await runSandboxedEval(
      `try {
        const proc = globalThis.process;
        if (!proc) return 'no-global-process';
        return proc.env && proc.env.HMH_SANDBOX_PROBE === undefined ? 'env-empty' : 'SECRET-LEAKED';
      } catch (e) { return 'probe-error:' + String(e).slice(0, 40); }`,
      {}, {}, { timeoutMs: 5_000 },
    );
    assert.ok(envProbe.value === 'env-empty' || envProbe.value === 'no-global-process', `probe said: ${String(envProbe.value)}`);
  } finally {
    delete process.env.HMH_SANDBOX_PROBE;
  }
});

test('rlm-sandbox: RLMRuntime.eval round-trips through the worker transparently', async () => {
  const rlm = new RLMRuntime();
  rlm.set('goal', 'write tests');
  rlm.set('files', ['a.ts', 'b.ts']);
  const r = await rlm.eval('return { goal: ctx.vars.goal, n: ctx.vars.files.length };');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { goal: 'write tests', n: 2 });
  // governance state stays frozen inside the worker
  const blocked = await rlm.eval('try { ctx.meta = { hacked: true }; return "mutated"; } catch { return "blocked"; }');
  assert.equal(blocked.value, 'blocked');
  // a crashing eval leaves the runtime usable
  const crash = await rlm.eval('null.x');
  assert.equal(crash.ok, false);
  assert.equal(crash.error?.code, 'E_EVAL');
  const fine = await rlm.eval('return "still alive";');
  assert.equal(fine.ok, true);
  assert.equal(fine.value, 'still alive');
});

test('rlm-sandbox: async eval code is awaited inside the worker', async () => {
  const r = await runSandboxedEval('const v = await Promise.resolve(42); return v * 2;', {}, {}, { timeoutMs: 5_000 });
  assert.equal(r.ok, true);
  assert.equal(r.value, 84);
});
