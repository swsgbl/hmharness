/**
 * @hmharness/sandbox - Trust Tiers & Capability Contracts (Issue #21, P0)
 *
 * The audit finding: isolation CLAIMS and isolation REALITY had diverged.
 * MicroVMSandboxProvider answered isAvailable()=true whenever Docker was
 * present and then ran plain `docker run` — a container advertised as a VM;
 * its copyIn/copyOut wrote the HOST filesystem directly under a
 * "strongest isolation tier" name. This module is the honest vocabulary that
 * fixes the divergence: every execution tier gets a TrustLevel and a
 * CapabilityContract that states what the boundary REALLY is, which escape
 * vectors stay open (declared, never hidden), and a fail-closed gate that
 * refuses to run a critical workload below the tier it requires.
 *
 * Two orderings live here and must not be confused:
 *   - TRUST_RANK orders ISOLATION STRENGTH (worker walls > process, etc.)
 *   - the gate orders MACHINE CAPABILITY: a worker tier needs nothing the
 *     running Node runtime does not already provide, so it never gates.
 */

/** The honest ladder. 'real-microvm' says REAL: a booted Firecracker/Cloud
 *  Hypervisor VM, never a Docker stand-in (that is 'container'). */
export type TrustLevel = 'process' | 'worker' | 'container' | 'real-microvm';

/** Isolation strength, strictly ordered. Pure - testable. */
export const TRUST_RANK: Readonly<Record<TrustLevel, number>> = {
  process: 1,
  worker: 2,
  container: 3,
  'real-microvm': 4,
};

/** What a tier really provides, in broker vocabulary (class names mirror
 *  CapabilityBroker's CapabilityClass; kept as plain strings so this module
 *  stays dependency-free — broker.ts re-asserts the overlap in its tests). */
export interface CapabilityContract {
  readonly level: TrustLevel;
  /** one honest sentence on what physically separates the workload from the host */
  readonly boundary: string;
  /** capability classes this tier may be granted ('none' = nothing survives) */
  readonly capabilityClasses: readonly ('filesystem' | 'network' | 'process' | 'secret' | 'device' | 'none')[];
  /** escape vectors that remain OPEN at this tier — declared, never hidden */
  readonly escapeVectors: readonly string[];
  /** do host environment secrets inherit into this tier? */
  readonly secretsInherit: boolean;
  /** the mechanism that actually enforces the boundary at runtime */
  readonly enforcement: string;
}

/**
 * The contracts. Each boundary string is a source-level FACT about the
 * current implementation (pinned by tests), not an aspiration.
 */
export const TRUST_TIERS: Readonly<Record<TrustLevel, CapabilityContract>> = {
  process: {
    level: 'process',
    boundary: 'no physical separation — the workload runs inside the hosting process with full host authority',
    capabilityClasses: ['filesystem', 'network', 'process', 'secret', 'device'],
    // LocalSandboxProvider.exec spreads the ENTIRE host env into the child
    // (provider.ts) — that is this tier's documented, pinned semantics.
    escapeVectors: ['full-host-authority', 'inherits-complete-host-environment'],
    secretsInherit: true,
    enforcement: 'CapabilityBroker decisions only (advisory at this tier — nothing stops a run past a wrong decision); LocalSandboxProvider documents exactly this semantics',
  },
  worker: {
    level: 'worker',
    boundary: 'worker_threads containment: crash isolation, hard timeout termination, heap caps, secret-free env (env: {}), escape globals stripped before eval',
    capabilityClasses: ['filesystem'],
    // Matches @hmharness/cognitive SANDBOX_BYPASS_VECTORS (dynamic-import is
    // the one open vector — any road to import(), direct or via a fresh
    // Function, reaches Node internals; Node offers no per-worker perms).
    escapeVectors: ['dynamic-import'],
    secretsInherit: false,
    enforcement: "cognitive rlm-sandbox per-eval Worker + broker's WORKER_FORBIDDEN rule (network/secret/process/device can never be granted at this tier)",
  },
  container: {
    level: 'container',
    boundary: 'Docker container: kernel namespaces + cgroups, but a SHARED host kernel',
    capabilityClasses: ['filesystem', 'network', 'process'],
    // DockerSandboxProvider mounts the workspace at its own host path
    // (--volume workdir:workdir) — writes inside punch straight through to
    // the host directory. Declared, not hidden.
    escapeVectors: ['shared-kernel-exploits', 'docker-socket-if-mounted', 'same-path-volume-mount-writes-through-to-host'],
    secretsInherit: false,
    enforcement: 'DockerSandboxProvider (docker run, resource limits, --network none unless granted) — secrets only via explicit spec.env, host env never spreads',
  },
  'real-microvm': {
    level: 'real-microvm',
    boundary: 'hardware-virtualized microVM (Firecracker / Cloud Hypervisor): separate guest kernel, no shared host kernel',
    capabilityClasses: ['filesystem', 'network', 'process', 'secret', 'device'],
    escapeVectors: ['hypervisor-escape-class-bugs'],
    secretsInherit: false,
    enforcement: 'a real hypervisor that PASSED a boot self-test — never faked with Docker (fail-closed gate below refuses the downgrade)',
  },
};

/** Structured fail-closed error: names the isolation the workload requires
 *  and the most the machine can actually provide. Serializable via toJSON
 *  so logs, API responses and (future) UI report the same fields. */
export class IsolationGateError extends Error {
  readonly code = 'E_ISOLATION_INSUFFICIENT' as const;
  readonly required: TrustLevel;
  readonly available: TrustLevel;
  readonly remediation: string;

  constructor(opts: { required: TrustLevel; available: TrustLevel; context?: string }) {
    const ctx = opts.context ? ` (${opts.context})` : '';
    super(
      `isolation gate: this workload requires '${opts.required}' isolation${ctx}, ` +
        `but the highest actually available here is '${opts.available}' — refusing to run at a weaker tier (fail closed). ` +
        `Remediation: ${IsolationGateError.remediationFor(opts.required, opts.available)}`,
    );
    this.name = 'IsolationGateError';
    this.required = opts.required;
    this.available = opts.available;
    this.remediation = IsolationGateError.remediationFor(opts.required, opts.available);
  }

  private static remediationFor(required: TrustLevel, available: TrustLevel): string {
    if (required === 'real-microvm') {
      return available === 'container'
        ? 'install Firecracker or Cloud Hypervisor and implement the boot self-test, or re-rate the task below critical — Docker is a container, not a VM, and must not run critical workloads as a stand-in'
        : 'install Docker (container tier) and/or a real hypervisor, or re-rate the task below critical';
    }
    if (required === 'container') return 'install/start Docker, or re-rate the task to a tier the machine can honor';
    return 'run on a machine that can provide the required tier, or re-rate the task';
  }

  toJSON(): { name: string; code: string; message: string; required: TrustLevel; available: TrustLevel; remediation: string } {
    return { name: this.name, code: this.code, message: this.message, required: this.required, available: this.available, remediation: this.remediation };
  }
}

/** Fail-closed gate. Pure - testable. A required tier ABOVE what is
 *  available throws IsolationGateError (never silently downgrades); a tier
 *  at or below the available strength passes. The worker tier never gates:
 *  its walls are provided by the running Node runtime itself, so any machine
 *  that can execute this check can host the worker tier. */
export function assertIsolationGate(required: TrustLevel, available: TrustLevel, context?: string): void {
  if (required === 'worker') return;
  if (TRUST_RANK[required] > TRUST_RANK[available]) {
    throw new IsolationGateError({ required, available, context });
  }
}
