/**
 * @hmharness/kernel - Capability Plane v1 (P0-02, 2026-09-24 audit)
 *
 * The unified capability model: every side effect the agent can cause -
 * native tools, MCP tools, skills, device actions - maps to the same
 * CapabilityManifest and passes through the same PolicyEngine. No tool
 * gets special treatment; the security perimeter is one plane.
 *
 * This is the ADR-0012 foundation the audit called for: "Native Tool,
 * MCP Tool, Skill, Device Action 全都映射成同一个 Capability 模型,
 * 并由同一个 PolicyEngine 鉴权".
 */

/** Risk classification drives the approval tier, not the tool name. */
export type CapabilityRisk = 'read-only' | 'workspace-write' | 'network' | 'system' | 'destructive' | 'device';

/** Where the capability came from - supply-chain provenance matters. */
export type CapabilitySource = 'builtin' | 'mcp' | 'skill' | 'device' | 'plugin';

export interface CapabilityManifest {
  /** unique id: namespace:name (e.g. "fs:read_file", "mcp:context7:search") */
  id: string;
  /** what this capability does, for audit and policy matching */
  description: string;
  /** risk tier - the ONLY thing that determines approval requirements */
  risk: CapabilityRisk;
  /** origin provenance */
  source: CapabilitySource;
  /** the actual executor function (internal use) */
  handler?: string;
  /** parameter schema (JSON Schema subset) */
  params?: Record<string, unknown>;
  /** side effects this capability can cause (for audit trail) */
  sideEffects?: string[];
  /** version of this capability definition */
  version: string;
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  /** if allow=true but requires user confirmation */
  needsApproval: boolean;
  /** policy that made the decision (for audit) */
  policyId: string;
}

/**
 * Policy rules are declarative and versioned. A rule matches on capability
 * properties (risk, source, id prefix) and produces a decision. Rules are
 * evaluated in order; the first matching rule wins.
 */
export interface PolicyRule {
  id: string;
  /** match conditions (all must be true) */
  match: {
    risk?: CapabilityRisk | CapabilityRisk[];
    source?: CapabilitySource | CapabilitySource[];
    /** id prefix match (e.g. "fs:" matches all filesystem tools) */
    idPrefix?: string;
  };
  decision: {
    allow: boolean;
    needsApproval: boolean;
    reason: string;
  };
  priority: number; // lower = evaluated first
}

/**
 * The default policy: secure-by-default, deny-first.
 * Read-only operations are allowed without approval.
 * Everything else requires explicit user consent.
 */
export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    id: 'deny-destructive',
    priority: 0,
    match: { risk: 'destructive' },
    decision: { allow: false, needsApproval: false, reason: 'destructive operations are denied by default' },
  },
  {
    id: 'approve-system',
    priority: 10,
    match: { risk: 'system' },
    decision: { allow: true, needsApproval: true, reason: 'system-level operations require approval' },
  },
  {
    id: 'approve-network',
    priority: 20,
    match: { risk: 'network' },
    decision: { allow: true, needsApproval: true, reason: 'network access requires approval' },
  },
  {
    id: 'approve-device',
    priority: 30,
    match: { risk: 'device' },
    decision: { allow: true, needsApproval: true, reason: 'device operations require approval' },
  },
  {
    id: 'approve-workspace-write',
    priority: 40,
    match: { risk: 'workspace-write' },
    decision: { allow: true, needsApproval: true, reason: 'workspace modifications require approval' },
  },
  {
    id: 'approve-plugin',
    priority: 50,
    match: { source: 'plugin' },
    decision: { allow: true, needsApproval: true, reason: 'third-party plugins require approval' },
  },
  {
    id: 'allow-readonly',
    priority: 100,
    match: { risk: 'read-only' },
    decision: { allow: true, needsApproval: false, reason: 'read-only operations are safe' },
  },
  {
    id: 'deny-unknown',
    priority: 999,
    match: {},
    decision: { allow: false, needsApproval: false, reason: 'unclassified capabilities are denied (deny-first)' },
  },
];

/**
 * The CapabilityRegistry holds all registered capabilities and evaluates
 * policy decisions. It is the single entry point for "can the agent do X?"
 */
export class CapabilityRegistry {
  private capabilities = new Map<string, CapabilityManifest>();
  private rules: PolicyRule[];

  constructor(rules: PolicyRule[] = DEFAULT_POLICY_RULES) {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
  }

  /** Register a capability. Duplicate ids are rejected (supply-chain safety). */
  register(manifest: CapabilityManifest): { ok: boolean; reason?: string } {
    if (this.capabilities.has(manifest.id)) {
      return { ok: false, reason: `capability ${manifest.id} already registered (deny overwrite for supply-chain safety)` };
    }
    this.capabilities.set(manifest.id, manifest);
    return { ok: true };
  }

  /** Check if a capability exists. */
  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  /** Get a capability manifest. */
  get(id: string): CapabilityManifest | undefined {
    return this.capabilities.get(id);
  }

  /** List all capabilities, optionally filtered. */
  list(filter?: { risk?: CapabilityRisk; source?: CapabilitySource }): CapabilityManifest[] {
    const all = [...this.capabilities.values()];
    if (!filter) return all;
    return all.filter(c =>
      (!filter.risk || c.risk === filter.risk) &&
      (!filter.source || c.source === filter.source)
    );
  }

  /**
   * Evaluate policy for a capability. This is THE gate every tool call
   * passes through - no exceptions, no bypass paths.
   */
  check(id: string): PolicyDecision {
    const cap = this.capabilities.get(id);
    if (!cap) {
      return { allow: false, reason: `capability ${id} not registered`, needsApproval: false, policyId: 'not-found' };
    }
    for (const rule of this.rules) {
      if (this.matchesRule(cap, rule)) {
        return {
          allow: rule.decision.allow,
          needsApproval: rule.decision.needsApproval,
          reason: rule.decision.reason,
          policyId: rule.id,
        };
      }
    }
    return { allow: false, reason: 'no matching policy rule', needsApproval: false, policyId: 'no-match' };
  }

  private matchesRule(cap: CapabilityManifest, rule: PolicyRule): boolean {
    const m = rule.match;
    if (m.risk) {
      const risks = Array.isArray(m.risk) ? m.risk : [m.risk];
      if (!risks.includes(cap.risk)) return false;
    }
    if (m.source) {
      const sources = Array.isArray(m.source) ? m.source : [m.source];
      if (!sources.includes(cap.source)) return false;
    }
    if (m.idPrefix && !cap.id.startsWith(m.idPrefix)) return false;
    return true;
  }

  /**
   * Add a custom policy rule (for user overrides via config).
   * Custom rules are inserted at the specified priority.
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /** Export the audit trail: all capabilities + their current policy decisions. */
  audit(): Array<{ manifest: CapabilityManifest; decision: PolicyDecision }> {
    return [...this.capabilities.values()].map(m => ({ manifest: m, decision: this.check(m.id) }));
  }
}

/**
 * Helper to classify tool risk from the existing tool registry.
 * Maps hmharness's current `needsApproval` + tool names to the new
 * CapabilityRisk tiers.
 */
export function classifyToolRisk(name: string, needsApproval: boolean): CapabilityRisk {
  const lower = name.toLowerCase();
  // destructive patterns (hardcoded deny in existing kernel)
  if (/rm\s+-rf|del\s+\/[sq]|format|mkfs|dd\s+if=/.test(lower)) return 'destructive';
  if (/reset\s+--hard|force\s+push|clean\s+-xfd/.test(lower)) return 'destructive';
  // device operations
  if (/hdc|emulator|device|install|uninstall|launch/.test(lower)) return 'device';
  // network access
  if (/fetch|web_search|http|url|curl|wget|api/.test(lower)) return 'network';
  // system-level
  if (/shell|exec|spawn|command|process|kill|taskkill|npm\s+install/.test(lower)) return 'system';
  // workspace writes
  if (/write|edit|create|mkdir|move|copy|patch/.test(lower)) return 'workspace-write';
  // read-only by default
  return needsApproval ? 'workspace-write' : 'read-only';
}
