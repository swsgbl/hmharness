import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { access, mkdtemp } from 'node:fs/promises';
import { recommendedIsolation, isolationCost, MicroVMSandboxProvider, detectHighestIsolation, isolationToTrust } from '../microvm.ts';
import { IsolationGateError } from '../trust.ts';
import { CapabilityBroker, assertExecutionGate } from '../broker.ts';

test('recommendedIsolation: critical risk -> microvm', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'critical', taskDuration: 1000, hasNetworkAccess: false }), 'microvm');
});

test('recommendedIsolation: high risk + long duration -> microvm', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'high', taskDuration: 120000, hasNetworkAccess: false }), 'microvm');
});

test('recommendedIsolation: high risk + short duration -> container', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'high', taskDuration: 30000, hasNetworkAccess: false }), 'container');
});

test('recommendedIsolation: network access -> container', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'medium', taskDuration: 1000, hasNetworkAccess: true }), 'container');
});

test('recommendedIsolation: low risk -> process', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'low', taskDuration: 1000, hasNetworkAccess: false }), 'process');
});

test('isolationCost: microvm is most expensive', () => {
  const proc = isolationCost('process');
  const cont = isolationCost('container');
  const vm = isolationCost('microvm');
  assert.ok(vm.startupMs > cont.startupMs && cont.startupMs > proc.startupMs);
  assert.ok(vm.memoryMb > cont.memoryMb && cont.memoryMb > proc.memoryMb);
});

test('isolationCost: descriptions stay honest', () => {
  for (const level of ['process', 'container', 'microvm'] as const) {
    const c = isolationCost(level);
    assert.ok(c.description.length > 10);
  }
  // Issue #21: the microvm row must name the real hypervisor requirement,
  // not present Docker as a stand-in
  const vm = isolationCost('microvm');
  assert.ok(vm.description.includes('Firecracker'));
  assert.ok(vm.description.includes('never faked with Docker'));
  assert.ok(isolationCost('container').description.includes('shared host kernel'));
});

test('MicroVMSandboxProvider: declares the firecracker design backend, not docker', () => {
  const p = new MicroVMSandboxProvider();
  assert.equal(p.backend, 'firecracker');
  assert.notEqual(p.backend, 'docker', 'a container backend must never wear the microVM name');
});

test('MicroVMSandboxProvider: Docker-only machine NEVER reports microVM available (Issue #21 regression)', async () => {
  // Before the honesty rework this machine (Docker 29.x reachable) answered
  // isAvailable()=true and exec() ran plain `docker run` as "the strongest
  // tier" — the exact lie Issue #21 pins. Now: no boot self-test exists on
  // ANY machine, so available must be false even with Docker fully up.
  const p = new MicroVMSandboxProvider();
  const probe = await p.probe();
  assert.notEqual(probe.selfTest, 'passed', 'the VM boot self-test is not implemented anywhere yet');
  assert.equal(probe.microvmReady, false);
  assert.equal(await p.isAvailable(), false, 'Docker presence must not make a container pass as a microVM');
  assert.equal(probe.dockerAvailable, true, 'this dev machine really has Docker — that is what makes this regression test meaningful');
  assert.match(probe.note, /NOT a microVM|not.*microVM|never/i);
});

test('MicroVMSandboxProvider: probe evidence agrees with detectHighestIsolation (no mixed messages)', async () => {
  const p = new MicroVMSandboxProvider();
  const probe = await p.probe();
  const highest = await detectHighestIsolation();
  // API face consistency: both reporters must tell the same story
  const expectedLevel = probe.dockerAvailable ? 'container' : 'process';
  assert.equal(highest.level, expectedLevel);
  assert.equal(highest.trust, isolationToTrust(expectedLevel));
  assert.notEqual(highest.level, 'microvm', 'no boot self-test exists -> detection never claims microvm');
});

test('MicroVMSandboxProvider: exec fails closed with the structured gate error (no silent docker run)', async () => {
  const p = new MicroVMSandboxProvider();
  await assert.rejects(
    () => p.exec('ls', ['-la'], { workdir: '/workspace', limits: {} }),
    (err: unknown) => {
      assert.ok(err instanceof IsolationGateError, `expected IsolationGateError, got ${String(err).slice(0, 120)}`);
      const e = err as IsolationGateError;
      assert.equal(e.code, 'E_ISOLATION_INSUFFICIENT');
      assert.equal(e.required, 'real-microvm');
      assert.equal(e.available, 'container', 'this machine truly tops out at Docker');
      assert.match(e.message, /exec/);
      return true;
    },
  );
});

test('MicroVMSandboxProvider: copyIn refuses and never touches the host filesystem', async () => {
  const p = new MicroVMSandboxProvider();
  const dir = await mkdtemp(join(tmpdir(), 'hmh-mvm-refuse-'));
  const target = join(dir, 'must-not-exist.txt');
  // Before the rework this wrote the HOST path directly under a
  // "strongest tier" name — an unbounded host write, not sandboxed at all.
  await assert.rejects(() => p.copyIn('/nonexistent/src', target, { workdir: '/workspace', limits: {} }), IsolationGateError);
  await assert.rejects(access(target), (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT', 'the host file must NOT have been written');
});

test('MicroVMSandboxProvider: copyOut / snapshot / restore all refuse honestly', async () => {
  const p = new MicroVMSandboxProvider();
  const spec = { workdir: '/workspace', limits: {} };
  await assert.rejects(() => p.copyOut('/sandbox/f', '/host/f', spec), IsolationGateError);
  await assert.rejects(() => p.snapshot(spec), IsolationGateError, 'old code returned a hash string that restored nothing — a fake API');
  await assert.rejects(() => p.restore('vm-snap-deadbeef', spec), IsolationGateError, 'old code silently did nothing');
});

test('execution gate: a critical-tier broker decision fails closed on this container-only machine', () => {
  const b = new CapabilityBroker();
  const req = { subject: 's', class: 'filesystem' as const };
  assert.equal(b.tierFor(req, { riskLevel: 'critical' }), 'microvm', 'the ladder still RECOMMENDS microvm for critical');
  const criticalDecision = { allowed: true, reason: 'test grant', tier: 'microvm' as const };
  assert.throws(
    () => assertExecutionGate(criticalDecision, 'container'),
    (err: unknown) => {
      const e = err as IsolationGateError;
      assert.equal(e.code, 'E_ISOLATION_INSUFFICIENT');
      assert.equal(e.required, 'real-microvm');
      assert.equal(e.available, 'container');
      assert.ok(e.message.includes("tier 'microvm'"), 'the error names the broker decision context');
      return true;
    },
  );
  // the same decision passes once a real microVM machine exists
  assertExecutionGate(criticalDecision, 'microvm');
});

test('execution gate: worker/process/container decisions gate exactly at their machine requirement', () => {
  // worker walls come from the running Node runtime — never gates
  assertExecutionGate({ allowed: true, reason: 't', tier: 'worker' }, 'process');
  assertExecutionGate({ allowed: true, reason: 't', tier: 'process' }, 'process');
  assertExecutionGate({ allowed: true, reason: 't', tier: 'container' }, 'container');
  assert.throws(() => assertExecutionGate({ allowed: true, reason: 't', tier: 'container' }, 'process'), IsolationGateError, 'container work on a process-only machine must fail closed');
});
