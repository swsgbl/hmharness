/**
 * @hmharness/sandbox - Capability Broker v1 (upgrade pack 01 P0-1 / MasterPrompt §3)
 *
 * The unified grant layer the pack demands: every capability access goes
 * through ONE broker with deny-by-default semantics. A capability token
 * carries the pack's eight fields (subject, class, scope, resource,
 * operation, constraints, expiry, provenance); tokens ALWAYS expire; the
 * audit trail records every decision.
 *
 * The execution ladder composes what already exists:
 *   low risk + read-only + no network            -> worker  (rlm-sandbox)
 *   medium / low+write                           -> process
 *   high / any network                           -> container (Docker provider)
 *   critical / high+long-running                 -> microvm
 * via recommendedIsolation() plus the broker's own escalation rules -
 * most importantly the RLM rule: the worker tier carries NO host
 * capability by construction (network/secret/process/device classes are
 * denied at worker tier regardless of tokens - the pack's "RLM 不得继承
 * host capability" made mechanical).
 *
 * Layering: this module has zero cognitive imports; ledger mirroring is
 * an injectable onDeny hook the composition layer wires.
 */
import { recommendedIsolation, type IsolationLevel } from './microvm.ts';

export type CapabilityClass = 'filesystem' | 'network' | 'process' | 'secret' | 'device';

export type CapabilityOperation = 'read' | 'write' | 'execute' | 'connect' | 'spawn' | 'grant';

/** The full ladder the pack demands (worker = the rlm-sandbox low tier). */
export type ExecutionTier = 'worker' | IsolationLevel;

export interface CapabilityToken {
  readonly id: string;
  /** who holds it: tool / agent / session id */
  readonly subject: string;
  readonly class: CapabilityClass;
  /** e.g. 'workspace-root' | 'host' | 'loopback' | 'none' */
  readonly scope: string;
  readonly resource: string;
  readonly operation: CapabilityOperation;
  readonly constraints?: Record<string, string | number | boolean | string[]>;
  /** epoch ms - every token expires, always */
  readonly expiry: number;
  /** who granted and why - the audit answer to 'qui bono' */
  readonly provenance: string;
}

export interface CapabilityRequest {
  subject: string;
  class: CapabilityClass;
  resource?: string;
  operation?: CapabilityOperation;
}

export interface BrokerDecision {
  allowed: boolean;
  reason: string;
  token?: CapabilityToken;
  tier: ExecutionTier;
}

export interface GrantInput {
  subject: string;
  class: CapabilityClass;
  scope: string;
  resource: string;
  operation: CapabilityOperation;
  /** Sandbox 2.0: constraints may carry an egress allowlist (string[]) */
  constraints?: Record<string, string | number | boolean | string[]>;
  /** how long the token lives, ms (default 1h; cap 24h) */
  ttlMs?: number;
  provenance: string;
}

export interface AuditEntry {
  at: number;
  subject: string;
  class: CapabilityClass;
  allowed: boolean;
  reason: string;
}

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** classes the worker tier can never hold - the RLM rule, mechanical */
const WORKER_FORBIDDEN: readonly CapabilityClass[] = ['network', 'secret', 'process', 'device'];
/** a scope that names an actual path (drive letter, UNC or posix-root) */
const PATH_SCOPE = /^([A-Za-z]:[\\/]|\\\\|\/)/;

export class CapabilityBroker {
  private readonly tokens = new Map<string, CapabilityToken>();
  private readonly audits: AuditEntry[] = [];
  private readonly auditLimit = 500;
  private seq = 0;
  /** injectable clock for deterministic tests */
  now: () => number = () => Date.now();
  /** composition-layer hook (agent wires it to the Cognitive Ledger's capability.denied) */
  onDeny?: (subject: string, cls: CapabilityClass, reason: string) => void;

  grant(input: GrantInput): CapabilityToken {
    if (!input.provenance) throw new Error('capability grant requires provenance - unattributable grants are non-auditable');
    const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const token: CapabilityToken = Object.freeze({
      id: `cap-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`,
      subject: input.subject,
      class: input.class,
      scope: input.scope,
      resource: input.resource,
      operation: input.operation,
      ...(input.constraints !== undefined ? { constraints: { ...input.constraints } } : {}),
      expiry: this.now() + ttl,
      provenance: input.provenance,
    });
    this.tokens.set(token.id, token);
    return token;
  }

  /** Deny-by-default: no LIVE matching token = deny, with the reason stated. */
  check(req: CapabilityRequest, risk: { riskLevel: 'low' | 'medium' | 'high' | 'critical'; taskDurationMs?: number; hasNetworkAccess?: boolean; /** the caller's execution context: rlm-worker = sandboxed eval, inherits NOTHING from the host */ executionContext?: 'rlm-worker' | 'host' }): BrokerDecision {
    const tier = this.tierFor(req, risk);
    const op: CapabilityOperation = req.operation ?? 'read';
    const workerContext = tier === 'worker' || risk.executionContext === 'rlm-worker';
    if (workerContext && WORKER_FORBIDDEN.includes(req.class)) {
      return this.decide(req, false, `worker tier can never hold ${req.class} - the RLM no-host-capability rule`, tier);
    }
    // prune expired tokens on every check (expiry is enforced lazily but strictly)
    const nowMs = this.now();
    for (const [id, t] of this.tokens) if (t.expiry <= nowMs) this.tokens.delete(id);
    const match = [...this.tokens.values()].find(
      (t) => t.subject === req.subject
        && t.class === req.class
        && (req.resource === undefined || t.resource === req.resource || t.resource === '*')
        && t.operation === op,
    );
    if (!match) {
      return this.decide(req, false, `no live ${req.class}/${op} grant for subject '${req.subject}' (deny-by-default)`, tier);
    }
    // Sandbox 2.0 constraint enforcement (per-class, on the LIVE token):
    //  - network connect: constraints.allowedHosts (when present) is the
    //    egress allowlist - a host outside it denies with the host named
    //  - filesystem: the token's scope roots the allowed subtree; a resource
    //    outside the root denies (mount policy - 'host' scope is explicit
    //    and auditable, never a silent fallback)
    if (req.class === 'network' && op === 'connect') {
      const allowed = match.constraints?.['allowedHosts'];
      if (Array.isArray(allowed)) {
        const host = String(req.resource ?? '');
        // '*.example.org' admits any subdomain; a bare host admits only itself
        const ok = allowed.some((a) => {
          const entry = String(a);
          if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
          return host === entry;
        });
        if (!ok) {
          return this.decide(req, false, `egress denied: '${host || '(no host)'}' not in grant ${match.id}'s allowlist [${allowed.join(', ')}]`, tier);
        }
      }
    }
    if (req.class === 'filesystem' && req.resource && PATH_SCOPE.test(match.scope)) {
      // mount policy applies to PATH-shaped scopes (a label scope like
      // 'workspace-root' is a semantic tag, not a root - it cannot confine)
      const root = match.scope.replace(/\/+$/, '');
      const res = String(req.resource).replace(/\\/g, '/').replace(/\/+$/, '');
      const rooted = res === root || res.startsWith(root + '/');
      if (!rooted) {
        return this.decide(req, false, `mount policy: '${req.resource}' is outside grant ${match.id}'s scope root '${match.scope}'`, tier);
      }
    }
    return this.decide(req, true, `grant ${match.id} (scope ${match.scope}, provenance: ${match.provenance})`, tier, match);
  }

  /** The pack's ladder, composing recommendedIsolation plus broker rules. */
  tierFor(req: CapabilityRequest, risk: { riskLevel: 'low' | 'medium' | 'high' | 'critical'; taskDurationMs?: number; hasNetworkAccess?: boolean }): ExecutionTier {
    const net = risk.hasNetworkAccess ?? req.class === 'network';
    const recommended = recommendedIsolation({
      riskLevel: risk.riskLevel,
      taskDuration: risk.taskDurationMs ?? 0,
      hasNetworkAccess: net,
    });
    if (recommended !== 'process') return recommended;
    // process tier refines to worker when everything is low and read-only
    const lowAndReadOnly = risk.riskLevel === 'low' && !net && (req.operation ?? 'read') === 'read' && req.class === 'filesystem';
    return lowAndReadOnly ? 'worker' : 'process';
  }

  revoke(byIdOrSubject: string): number {
    let n = 0;
    for (const [id, t] of this.tokens) {
      if (id === byIdOrSubject || t.subject === byIdOrSubject) { this.tokens.delete(id); n++; }
    }
    return n;
  }

  status(): { active: number; audits: number } {
    return { active: this.tokens.size, audits: this.audits.length };
  }

  auditTrail(): readonly AuditEntry[] {
    return this.audits.slice();
  }

  private decide(req: CapabilityRequest, allowed: boolean, reason: string, tier: ExecutionTier, token?: CapabilityToken): BrokerDecision {
    const entry: AuditEntry = { at: this.now(), subject: req.subject, class: req.class, allowed, reason };
    this.audits.push(entry);
    if (this.audits.length > this.auditLimit) this.audits.splice(0, this.audits.length - this.auditLimit);
    if (!allowed) {
      try { this.onDeny?.(req.subject, req.class, reason); } catch { /* a deny hook must never break the denial itself */ }
    }
    return { allowed, reason, tier, ...(token !== undefined ? { token } : {}) };
  }
}

/* ---------------- SecretBroker (Sandbox 2.0: secrets never ride payloads) ----------------
 *
 * The audit rule: secret 不传给 LSP/RLM/subagent. The broker holds the
 * values; callers (and logs, and the LLM context) only ever see opaque
 * REFERENCES. resolve() checks the CapabilityBroker for a live 'secret'
 * grant on the subject FIRST - no grant, no value, deny-by-default like
 * everything else; redact() turns any string's secret values into
 * ${ref} tokens so audit trails and transcripts stay clean even when a
 * value leaks into an output by accident.
 */
export class SecretBroker {
  private readonly secrets = new Map<string, string>();
  constructor(private readonly broker: CapabilityBroker) {}

  /** store a secret; returns the opaque reference to use everywhere else */
  set(name: string, value: string): string {
    const ref = `secret:${name}`;
    this.secrets.set(name, value);
    return ref;
  }

  /** resolve a reference to its value - only under a live secret grant */
  resolve(subject: string, ref: string): { ok: true; value: string } | { ok: false; reason: string } {
    const m = /^secret:(.+)$/.exec(ref);
    if (!m) return { ok: false, reason: `not a secret reference: '${ref.slice(0, 24)}'` };
    const name = m[1];
    const decision = this.broker.check({ subject, class: 'secret', resource: name, operation: 'read' }, { riskLevel: 'high' });
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    const value = this.secrets.get(name);
    if (value === undefined) return { ok: false, reason: `no such secret '${name}'` };
    return { ok: true, value };
  }

  /** replace known secret values in any text with their references */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.secrets) {
      if (value.length > 0) out = out.split(value).join(`secret:${name}`);
    }
    return out;
  }

  list(): string[] {
    return [...this.secrets.keys()];
  }
}
