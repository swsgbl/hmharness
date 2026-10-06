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
  readonly constraints?: Record<string, string | number | boolean>;
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
  constraints?: Record<string, string | number | boolean>;
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
