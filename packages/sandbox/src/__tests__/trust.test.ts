import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRUST_TIERS, TRUST_RANK, assertIsolationGate, IsolationGateError, type TrustLevel } from '../trust.ts';

/**
 * Trust tier contracts (Issue #21). These tests pin the HONEST vocabulary:
 * every tier states what it really is, which escapes stay open, and the
 * fail-closed gate refuses to run above the machine's true capability.
 */

test('trust tiers: all four levels defined with strictly increasing rank', () => {
  const levels: TrustLevel[] = ['process', 'worker', 'container', 'real-microvm'];
  assert.deepEqual(Object.keys(TRUST_TIERS).sort(), [...levels].sort());
  for (let i = 1; i < levels.length; i++) {
    assert.ok(TRUST_RANK[levels[i]] > TRUST_RANK[levels[i - 1]], `${levels[i]} must outrank ${levels[i - 1]}`);
  }
});

test('trust tiers: every contract states a real boundary and its open escape vectors', () => {
  for (const level of Object.keys(TRUST_TIERS) as TrustLevel[]) {
    const c = TRUST_TIERS[level];
    assert.equal(c.level, level);
    assert.ok(c.boundary.length > 20, `${level} boundary must be a real sentence`);
    assert.ok(Array.isArray(c.escapeVectors), `${level} escapeVectors must be an array`);
    assert.ok(c.enforcement.length > 10, `${level} enforcement must name the mechanism`);
  }
});

test('trust tiers: worker contract pins the declared dynamic-import bypass and the no-host-capability rule', () => {
  // cognitive's red-team test machine-checks SANDBOX_BYPASS_VECTORS from its
  // side (dynamic-import is the one open vector); this pins the same fact
  // from the sandbox vocabulary side. Both directions must stay true.
  const worker = TRUST_TIERS.worker;
  assert.ok(worker.escapeVectors.some((v) => v.replace(/[\s_-]/g, '').toLowerCase().includes('dynamicimport')));
  assert.equal(worker.secretsInherit, false, 'worker env is {} — host secrets never inherit');
  assert.deepEqual(worker.capabilityClasses, ['filesystem'], 'broker WORKER_FORBIDDEN denies network/secret/process/device at worker tier');
});

test('trust tiers: process contract documents the LocalSandboxProvider reality (full host authority, env inheritance)', () => {
  // provider.ts LocalSandboxProvider.exec spreads the whole host env — that
  // is a FACT, so the process contract must say so instead of hiding it.
  const p = TRUST_TIERS.process;
  assert.equal(p.secretsInherit, true);
  assert.ok(p.escapeVectors.includes('full-host-authority'));
  assert.ok(p.escapeVectors.includes('inherits-complete-host-environment'));
});

test('trust tiers: container contract declares shared-kernel and volume passthrough escapes', () => {
  // DockerSandboxProvider mounts the workspace at its own host path
  // (--volume workdir:workdir): writes inside punch through to the host.
  const c = TRUST_TIERS.container;
  assert.ok(c.escapeVectors.some((v) => v.includes('shared-kernel')));
  assert.ok(c.escapeVectors.some((v) => v.includes('volume-mount')), 'same-path volume mount writes through to host — must stay declared');
  assert.equal(c.secretsInherit, false, 'docker run never receives the host environment');
});

test('trust tiers: real-microvm enforcement demands a self-test and only ever negates Docker', () => {
  const vm = TRUST_TIERS['real-microvm'];
  assert.equal(vm.secretsInherit, false);
  assert.ok(/never faked with Docker/i.test(vm.enforcement), 'the VM tier must explicitly refuse the Docker stand-in');
  // strip that negation and no positive Docker mention may remain
  const stripped = vm.enforcement.replace(/never faked with Docker/gi, '');
  assert.ok(!stripped.toLowerCase().includes('docker'), 'a VM tier must never be positively enforced "with Docker"');
  assert.ok(vm.enforcement.toLowerCase().includes('self-test'));
});

test('assertIsolationGate: weaker machine throws the structured error — never a silent downgrade', () => {
  assert.throws(
    () => assertIsolationGate('real-microvm', 'container', 'test: critical workload'),
    (err: unknown) => {
      assert.ok(err instanceof IsolationGateError);
      const e = err as IsolationGateError;
      assert.equal(e.code, 'E_ISOLATION_INSUFFICIENT');
      assert.equal(e.required, 'real-microvm', 'error names the REQUIRED isolation level');
      assert.equal(e.available, 'container', 'error names the HIGHEST ACTUALLY AVAILABLE level');
      assert.ok(e.message.includes('real-microvm'));
      assert.ok(e.message.includes('container'));
      assert.ok(e.remediation.length > 10);
      // log/API face: toJSON keeps every field a UI or log line would need
      const j = JSON.parse(JSON.stringify(e));
      assert.equal(j.code, 'E_ISOLATION_INSUFFICIENT');
      assert.equal(j.required, 'real-microvm');
      assert.equal(j.available, 'container');
      assert.ok(j.message.includes('fail closed'));
      return true;
    },
  );
});

test('assertIsolationGate: equal or stronger machine passes; worker never gates', () => {
  assertIsolationGate('container', 'container');
  assertIsolationGate('container', 'real-microvm');
  assertIsolationGate('process', 'process');
  assertIsolationGate('worker', 'process', 'worker walls come from the running Node runtime');
  assertIsolationGate('real-microvm', 'real-microvm');
});

test('assertIsolationGate: container required on a process-only machine fails closed', () => {
  assert.throws(() => assertIsolationGate('container', 'process'), IsolationGateError);
});
