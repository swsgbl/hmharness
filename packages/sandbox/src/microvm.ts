/**
 * @hmharness/sandbox - microVM Backend (P3-06; honesty rework for Issue #21, P0)
 *
 * Extends the SandboxProvider abstraction with Firecracker/Cloud Hypervisor
 * style isolation for high-risk, long-running tasks. This is the strongest
 * isolation tier: full VM-level separation.
 *
 * ISSUE #21 HONESTY RULES (fail closed, never fake a VM):
 *   - isAvailable() is TRUE only when a real hypervisor (Firecracker or
 *     Cloud Hypervisor) is detected AND has passed a boot self-test.
 *     Docker-only machines return FALSE. The old behavior — "Docker can
 *     simulate microVM" — was a lie: `docker run` shares the host kernel.
 *   - exec/copyIn/copyOut/snapshot/restore refuse (structured
 *     IsolationGateError) when the real tier is absent. The old behavior
 *     ran plain `docker run` under a "strongest tier" name, and its
 *     copyIn/copyOut wrote the HOST filesystem directly with no boundary
 *     at all; snapshot() returned a hash string that restored nothing.
 *   - Migration for callers of the old silent downgrade: if container
 *     semantics are what you want, use DockerSandboxProvider (it reports
 *     backend='docker' honestly); if you need critical-tier isolation,
 *     keep requiring 'microvm' and let the gate fail closed until a real
 *     hypervisor + self-test exist.
 */

import { assertIsolationGate, type TrustLevel } from './trust.ts';
import type { SandboxProvider, SandboxResult, ProviderSandboxSpec, SandboxBackend } from './provider.ts';

export type IsolationLevel = 'process' | 'container' | 'microvm';

export interface MicroVMConfig {
  /** VM image to boot */
  image: string;
  /** CPU cores */
  vcpus: number;
  /** memory in MB */
  memoryMb: number;
  /** disk size in MB */
  diskMb: number;
  /** network: none = fully isolated */
  networkEnabled: boolean;
  /** boot timeout in ms */
  bootTimeoutMs: number;
}

export const DEFAULT_MICROVM_CONFIG: MicroVMConfig = {
  image: 'microvm-base',
  vcpus: 2,
  memoryMb: 1024,
  diskMb: 2048,
  networkEnabled: false,
  bootTimeoutMs: 5000,
};

/** Map the ladder's IsolationLevel to the honest TrustLevel vocabulary.
 *  'microvm' maps to real-microvm BY DEFINITION — a Docker stand-in is
 *  'container', and nothing in this module ever conflates them. Pure. */
export function isolationToTrust(level: IsolationLevel): TrustLevel {
  if (level === 'microvm') return 'real-microvm';
  if (level === 'container') return 'container';
  return 'process';
}

/**
 * Determine the appropriate isolation level for a task.
 * Pure - testable. NOTE: this is a RECOMMENDATION, not an availability
 * claim — pair it with assertIsolationGate()/assertExecutionGate() before
 * executing anything at the recommended tier.
 */
export function recommendedIsolation(params: {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  taskDuration: number;
  hasNetworkAccess: boolean;
}): IsolationLevel {
  if (params.riskLevel === 'critical') return 'microvm';
  if (params.riskLevel === 'high' && params.taskDuration > 60000) return 'microvm';
  if (params.riskLevel === 'high' || params.hasNetworkAccess) return 'container';
  return 'process';
}

/**
 * Estimate the cost of running at a given isolation level.
 * Pure - testable.
 */
export function isolationCost(level: IsolationLevel): { startupMs: number; memoryMb: number; description: string } {
  switch (level) {
    case 'process': return { startupMs: 0, memoryMb: 0, description: 'host process (no isolation overhead)' };
    case 'container': return { startupMs: 500, memoryMb: 50, description: 'Docker container (lightweight isolation, shared host kernel)' };
    case 'microvm': return { startupMs: 2000, memoryMb: 200, description: 'real Firecracker/Cloud Hypervisor microVM (full VM isolation; requires a hypervisor boot self-test — never faked with Docker)' };
  }
}

/** What a real-hypervisor probe found. `selfTest` is honest about the state
 *  of VM lifecycle support on this machine, not about binaries merely existing. */
export interface MicroVMProbe {
  /** which hypervisor binary was found, if any */
  hypervisor: 'firecracker' | 'cloud-hypervisor' | null;
  /** raw version output (evidence for logs/UI) */
  hypervisorVersion: string | null;
  /** 'passed' only after a real boot self-test; 'not-implemented' = binary
   *  found but VM lifecycle (boot/rootfs/api-socket) is NOT implemented;
   *  'no-hypervisor' = neither binary exists */
  selfTest: 'passed' | 'not-implemented' | 'no-hypervisor';
  /** Docker status is reported for EVIDENCE only — it never makes microvm
   *  available. TRUE means the daemon actually answered `docker info`; a CLI
   *  without a daemon is false (the CLI proves nothing — `docker run` would
   *  fail). Derived from the SAME snapshot as detectHighestIsolation(). */
  dockerAvailable: boolean;
  /** true only when hypervisor !== null && selfTest === 'passed' */
  microvmReady: boolean;
  note: string;
}

/* ---------------- Single evidence source (PR#24 3rd CI failure, B-fix3) ----------------
 *
 * probe() and detectHighestIsolation() used to run IDENTICAL probe commands
 * (firecracker --version / cloud-hypervisor --version / docker info, 3000/
 * 3000/5000ms, all failures flattened to null) as two INDEPENDENT passes.
 * On the CI runner the docker daemon warms up mid-test: the first pass
 * timed out or was refused (probe().dockerAvailable=false -> expected
 * 'process') while the second, seconds later, reached the freshly-started
 * daemon (detect -> 'container'). Two individually honest probes, one mixed
 * message. The fix is structural, not another timeout tweak: collect the
 * evidence ONCE per process, share that snapshot with every consumer, and
 * derive ALL isolation verdicts from it. A snapshot cannot disagree with
 * itself. Availability still means "the daemon truly answered" — a CLI
 * alone never raises the level.
 */

/** One machine-wide evidence snapshot. Plain data — derivations are pure. */
export interface MachineIsolationEvidence {
  /** `firecracker --version` output; null = absent/failed */
  firecrackerVersion: string | null;
  /** `cloud-hypervisor --version` output; null = absent/failed */
  cloudHypervisorVersion: string | null;
  /** `docker info` SUCCEEDED (daemon reachable & responsive). The ONLY
   *  docker signal allowed to raise the isolation level. */
  dockerDaemonVersion: string | null;
  /** `docker --version` output (CLI exists). Evidence for logs only — a
   *  CLI without a daemon runs nothing, so it can never mean 'container'. */
  dockerCliVersion: string | null;
}

async function shellOutProbe(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const r = await run(bin, args, { timeout: timeoutMs });
    return String((r as { stdout?: unknown }).stdout ?? r ?? '').trim();
  } catch {
    return null;
  }
}

/** pluggable raw prober (production = shell out; tests inject fakes) */
export type RawProbe = (bin: string, args: string[], timeoutMs: number) => Promise<string | null>;
let rawProbe: RawProbe = shellOutProbe;

/** Test seam: inject a fake prober and RESET the shared evidence snapshot,
 *  or pass null to restore production probing. Nothing outside tests
 *  should ever call this. */
export function setRawProbeForTests(fn: RawProbe | null): void {
  rawProbe = fn ?? shellOutProbe;
  sharedEvidence = null;
}

/** Collect the machine's isolation evidence. Runs ONCE per process. */
async function collectIsolationEvidence(): Promise<MachineIsolationEvidence> {
  const fc = await rawProbe('firecracker', ['--version'], 3000);
  const ch = await rawProbe('cloud-hypervisor', ['--version'], 3000);
  const daemon = await rawProbe('docker', ['info', '--format', '{{.ServerVersion}}'], 5000);
  const cli = await rawProbe('docker', ['--version'], 3000);
  return { firecrackerVersion: fc, cloudHypervisorVersion: ch, dockerDaemonVersion: daemon, dockerCliVersion: cli };
}

let sharedEvidence: Promise<MachineIsolationEvidence> | null = null;

/** THE single evidence source: first caller collects, everyone reuses the
 *  same in-flight snapshot. Derive — never re-probe. */
function machineEvidence(): Promise<MachineIsolationEvidence> {
  sharedEvidence ??= collectIsolationEvidence();
  return sharedEvidence;
}

/** Derive the machine's honest highest isolation from one evidence
 *  snapshot. Pure — testable without touching the machine. */
export function isolationFromEvidence(ev: MachineIsolationEvidence): {
  level: IsolationLevel;
  trust: TrustLevel;
  hypervisor: 'firecracker' | 'cloud-hypervisor' | null;
  evidence: string;
} {
  const hypervisor = ev.firecrackerVersion ? 'firecracker' : ev.cloudHypervisorVersion ? 'cloud-hypervisor' : null;
  const hypEvidence = hypervisor ? 'hypervisor binary present but boot self-test not implemented' : 'no hypervisor binary';
  // NEVER level='microvm' today: the boot self-test does not exist (see
  // MicroVMSandboxProvider.probe()), and a --version string is not a booted
  // VM. When the self-test lands, promote the hypervisor branch to a real
  // check and return microvm ONLY on selfTest === 'passed'.
  if (ev.dockerDaemonVersion) {
    return { level: 'container', trust: 'container', hypervisor, evidence: `docker server ${ev.dockerDaemonVersion} reachable; ${hypEvidence}` };
  }
  const dockerEvidence = ev.dockerCliVersion
    ? `docker CLI present (${ev.dockerCliVersion}) but daemon unreachable — a CLI without a daemon runs nothing; ${hypEvidence}`
    : `no docker; ${hypEvidence}`;
  return { level: 'process', trust: 'process', hypervisor, evidence: dockerEvidence };
}

/**
 * Determine the machine's strongest ACTUALLY available isolation. Derived
 * from the same shared evidence snapshot as MicroVMSandboxProvider.probe()
 * — the two API faces cannot disagree. Reports microvm ONLY when a
 * hypervisor binary exists AND its boot self-test passed; a reachable
 * Docker daemon reports container; anything less reports process. Never a
 * lie.
 */
export async function detectHighestIsolation(): Promise<{ level: IsolationLevel; trust: TrustLevel; hypervisor: string | null; evidence: string }> {
  return isolationFromEvidence(await machineEvidence());
}

/**
 * MicroVM sandbox provider (extends SandboxProvider interface).
 *
 * HONESTY CONTRACT (Issue #21): this provider EXECUTES NOTHING today. VM
 * lifecycle management (boot a microVM, provision rootfs, speak the
 * Firecracker/Cloud Hypervisor API socket) is not implemented, so:
 *   isAvailable()  -> false on every current machine (no self-test exists)
 *   every exec/copy/snapshot call -> IsolationGateError (fail closed)
 * Before the honesty rework it happily answered available=true on any
 * Docker machine and ran `docker run` — that path is deleted, not stubbed.
 */
export class MicroVMSandboxProvider implements SandboxProvider {
  /** design-target backend. It is a DECLARATION, not an execution claim:
   *  no SandboxResult ever leaves this class until a real VM path exists. */
  readonly backend: SandboxBackend = 'firecracker';
  private readonly config: MicroVMConfig;

  constructor(config: Partial<MicroVMConfig> = {}) {
    this.config = { ...DEFAULT_MICROVM_CONFIG, ...config };
  }

  /** Evidence-grade probe for logs/UI/API — same fields everywhere. Reads
   *  the SAME shared evidence snapshot detectHighestIsolation() uses, so the
   *  two faces cannot tell different stories about one machine. */
  async probe(): Promise<MicroVMProbe> {
    const ev = await machineEvidence();
    const hypervisor: MicroVMProbe['hypervisor'] = ev.firecrackerVersion ? 'firecracker' : ev.cloudHypervisorVersion ? 'cloud-hypervisor' : null;
    const version = ev.firecrackerVersion ?? ev.cloudHypervisorVersion;
    // Boot self-test: NOT IMPLEMENTED. A --version string is not a booted VM.
    // When someone implements it, return 'passed' here and isAvailable()/
    // detectHighestIsolation() become true to microvm on that machine.
    const selfTest = (hypervisor ? 'not-implemented' : 'no-hypervisor') as MicroVMProbe['selfTest'];
    return {
      hypervisor,
      hypervisorVersion: version,
      selfTest,
      dockerAvailable: ev.dockerDaemonVersion !== null,
      microvmReady: hypervisor !== null && selfTest === 'passed',
      note: hypervisor
        ? `${hypervisor} binary present, but the VM boot self-test is not implemented — microVM is NOT reported available (would-be config: ${this.config.vcpus} vcpu/${this.config.memoryMb}MB)`
        : ev.dockerDaemonVersion
          ? 'no Firecracker/Cloud Hypervisor found; Docker daemon is reachable but a container is NOT a microVM — reporting unavailable (Issue #21: no silent downgrade)'
          : ev.dockerCliVersion
            ? 'no hypervisor; docker CLI present but daemon unreachable — neither microVM nor container is available'
            : 'no hypervisor and no Docker — microVM unavailable',
    };
  }

  async isAvailable(): Promise<boolean> {
    const p = await this.probe();
    return p.microvmReady;
  }

  async exec(_command: string, _args: string[], _spec: ProviderSandboxSpec): Promise<SandboxResult> {
    return this.refuse('exec');
  }

  async copyIn(_localPath: string, sandboxPath: string, _spec: ProviderSandboxSpec): Promise<void> {
    // the old implementation copyFile'd straight onto the HOST at
    // sandboxPath under a "strongest tier" name — an unbounded host write.
    // Refusing is the only honest behavior until a real VM file channel exists.
    return this.refuse(`copyIn(${sandboxPath})`);
  }

  async copyOut(sandboxPath: string, _localPath: string, _spec: ProviderSandboxSpec): Promise<void> {
    return this.refuse(`copyOut(${sandboxPath})`);
  }

  async snapshot(_spec: ProviderSandboxSpec): Promise<string> {
    return this.refuse('snapshot');
  }

  async restore(_snapshotId: string, _spec: ProviderSandboxSpec): Promise<void> {
    return this.refuse('restore');
  }

  /** fail closed: never executes, never fakes, names both tiers in the error */
  private async refuse(operation: string): Promise<never> {
    const highest = await detectHighestIsolation();
    if (highest.trust !== 'real-microvm') {
      assertIsolationGate('real-microvm', highest.trust, `${operation} on MicroVMSandboxProvider; ${highest.evidence}`);
    }
    // reachable only once a boot self-test exists; until VM lifecycle
    // management is implemented, even that path must refuse rather than
    // pretend to execute. NEEDS-DATA on real-hypervisor hosts.
    throw new Error(
      `E_MICROVM_EXEC_UNIMPLEMENTED: hypervisor detected (${highest.hypervisor}) but VM lifecycle management (boot/rootfs/api-socket) is not implemented — refusing to fake execution for ${operation}`,
    );
  }
}
