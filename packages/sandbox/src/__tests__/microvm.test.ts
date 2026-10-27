import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { access, mkdtemp } from 'node:fs/promises';
import { recommendedIsolation, isolationCost, MicroVMSandboxProvider, detectHighestIsolation, isolationFromEvidence, setRawProbeForTests, isolationToTrust, type IsolationLevel } from '../microvm.ts';
import { IsolationGateError, TRUST_RANK } from '../trust.ts';
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

test('MicroVMSandboxProvider: Docker-only machine NEVER reports microVM available (Issue #21 regression)', async (t) => {
  // Before the honesty rework this machine (Docker 29.x reachable) answered
  // isAvailable()=true and exec() ran plain `docker run` as "the strongest
  // tier" — the exact lie Issue #21 pins. Now: no boot self-test exists on
  // ANY machine, so available must be false even with Docker fully up.
  const p = new MicroVMSandboxProvider();
  const probe = await p.probe();
  // The assertions below assume a Docker-present machine (dev box); CI
  // runners have no Docker daemon, so guard on the probe instead of failing
  // (same pattern as real-browser tests skipping on missing browsers).
  if (!probe.dockerAvailable) return t.skip('Docker not available on this machine - the regression guard needs a Docker-present machine');
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
  // Relational expectation, never a machine constant: derive what detection
  // SHOULD answer from the probe evidence via the production mapping
  // (trust.ts / microvm.ts) — booted hypervisor -> microvm, Docker
  // capability -> container, nothing -> process. PR#24 CI: the dev box
  // answers 'container', a daemon-less runner answers 'process', and BOTH
  // are correct — the invariant under test is that the two API faces tell
  // the same story, not which story the machine happens to tell.
  const expectedLevel: IsolationLevel = probe.microvmReady ? 'microvm' : probe.dockerAvailable ? 'container' : 'process';
  assert.equal(highest.level, expectedLevel);
  assert.equal(highest.trust, isolationToTrust(expectedLevel));
  // the detection result must obey the level->trust mapping itself
  assert.equal(highest.trust, isolationToTrust(highest.level));
  // the reported trust must be a legal TrustLevel (set defined once in trust.ts)
  assert.ok(highest.trust in TRUST_RANK, `illegal TrustLevel from detection: ${String(highest.trust)}`);
  // hypervisor verdicts must agree between the two probes
  assert.equal(highest.hypervisor, probe.hypervisor);
  // no boot self-test exists today, so detection must not claim microvm —
  // stated relationally so it stays true when the self-test lands: the
  // microvm claim flips exactly with probe.microvmReady
  assert.equal(probe.microvmReady, highest.level === 'microvm');
});

test('MicroVMSandboxProvider: exec fails closed with the structured gate error (no silent docker run)', async (t) => {
  const p = new MicroVMSandboxProvider();
  // Guard + relational expectation: "available" is whatever detection
  // actually answers on THIS machine. PR#24 CI: a runner whose docker
  // daemon never answers reports 'process', the dev box 'container' — both
  // honest, the old 'container' literal was a dev-box fact masquerading as
  // an invariant.
  const highest = await detectHighestIsolation();
  if (highest.trust === 'real-microvm') return t.skip('real microVM host: exec takes the lifecycle-unimplemented path instead of the gate (NEEDS-DATA)');
  await assert.rejects(
    () => p.exec('ls', ['-la'], { workdir: '/workspace', limits: {} }),
    (err: unknown) => {
      assert.ok(err instanceof IsolationGateError, `expected IsolationGateError, got ${String(err).slice(0, 120)}`);
      const e = err as IsolationGateError;
      assert.equal(e.code, 'E_ISOLATION_INSUFFICIENT');
      assert.equal(e.required, 'real-microvm');
      assert.equal(e.available, highest.trust, 'the error names the level detection actually answered here — derived, never a dev-box constant');
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

/* ---------------- Single evidence source: injected-probe tests (B-fix3) ----------------
 * These never touch the real machine, so they hold on every CI runner.
 */

test('single evidence source: docker CLI present but daemon unreachable is process on BOTH faces', async (t) => {
  // PR#24 3rd CI failure: a runner image can ship the docker CLI without a
  // responsive daemon. A CLI proves nothing — `docker run` would fail — so
  // reporting 'container' there would be a lie. Lock it with a fake probe.
  setRawProbeForTests(async (bin, args) => {
    if (bin === 'docker' && args[0] === '--version') return 'Docker version 27.3.1, build ab1234';
    // docker info fails (absent/timeout/refused — runProbe flattens all to null)
    return null;
  });
  t.after(() => setRawProbeForTests(null));
  const highest = await detectHighestIsolation();
  assert.equal(highest.level, 'process', 'a CLI without a daemon must never be container');
  assert.equal(highest.trust, 'process');
  assert.match(highest.evidence, /daemon unreachable/);
  const probe = await new MicroVMSandboxProvider().probe();
  assert.equal(probe.dockerAvailable, false);
  // the pure derivation agrees: same evidence, same verdict
  assert.equal(isolationFromEvidence({ firecrackerVersion: null, cloudHypervisorVersion: null, dockerDaemonVersion: null, dockerCliVersion: 'Docker version 27.3.1' }).level, 'process');
});

test('single evidence source: reachable daemon derives container on BOTH faces (injected — no Docker needed on this machine)', async (t) => {
  // environment-independent twin of the dev-box fact "real Docker machine ->
  // container": injected so it also runs (and holds) on daemon-less runners.
  setRawProbeForTests(async (bin, args) => {
    if (bin === 'docker' && args[0] === 'info') return '29.0.1';
    if (bin === 'docker' && args[0] === '--version') return 'Docker version 27.3.1';
    return null;
  });
  t.after(() => setRawProbeForTests(null));
  const highest = await detectHighestIsolation();
  assert.equal(highest.level, 'container');
  assert.equal(highest.trust, 'container');
  assert.equal((await new MicroVMSandboxProvider().probe()).dockerAvailable, true);
});

test('single evidence source: a daemon that warms up mid-run cannot make the faces disagree (PR#24 CI failure replay)', async (t) => {
  // The exact CI shape: evidence collection asks docker info BEFORE the
  // daemon is up (fails), then docker --version AFTER it warmed up. With two
  // independent probe passes the second pass would re-probe and answer
  // 'container' while the first had said 'process'. One shared snapshot
  // makes that impossible: both faces report the same first-read verdict.
  let daemonUp = false;
  setRawProbeForTests(async (bin, args) => {
    if (bin === 'docker' && args[0] === 'info') return daemonUp ? '29.0.1' : null;
    if (bin === 'docker' && args[0] === '--version') {
      daemonUp = true; // daemon finishes warming up here, between the two probe commands
      return 'Docker version 27.3.1';
    }
    return null;
  });
  t.after(() => setRawProbeForTests(null));
  const probe = await new MicroVMSandboxProvider().probe(); // triggers collection: info missed the daemon
  assert.equal(probe.dockerAvailable, false);
  const highest = await detectHighestIsolation(); // same snapshot, no re-probe
  assert.equal(highest.level, 'process', 'detection must reuse the probe snapshot, not re-probe into a warmer world');
  assert.equal(highest.evidence.includes('docker server'), false);
});
