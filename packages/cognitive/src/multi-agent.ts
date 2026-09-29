/**
 * @hmharness/cognitive - multi-agent 2.0 (blueprint §11 / MA-001..010)
 *
 * Roles, contracts, budgets, heartbeats and cancellation — the governance
 * shell around the EXISTING agent/spawn + roles + topology machinery. This
 * module does not re-implement spawning; it defines the topology contract
 * the host bridges onto spawn_agent, with the shared blackboard the
 * blueprint demands: goal graph, world model, evidence store, budget,
 * approval policy, artifact store.
 */
import type { Goal } from './goal.ts';

export type AgentRoleName = 'supervisor' | 'explorer' | 'planner' | 'implementer' | 'critic' | 'verifier' | 'researcher' | 'memory-curator';

export interface AgentContract {
  role: AgentRoleName;
  /** what this role consumes */
  input: Record<string, string>;
  /** what this role must produce */
  output: Record<string, string>;
  timeoutMs: number;
  budget: { maxActions: number; maxCostUnits: number };
  heartbeatIntervalMs: number;
}

export interface AgentNode {
  id: string;
  role: AgentRoleName;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  contract: AgentContract;
  lastHeartbeatAt?: string;
  startedAt?: string;
  endedAt?: string;
  result?: unknown;
  failure?: { code: string; message: string };
}

export interface SharedBlackboard {
  goalGraph: { nodes: Goal[]; edges: Array<{ from: string; to: string }> };
  /** world-model digest the agents read (belief table + uncertainty) */
  worldDigest: { beliefs: Array<{ claim: string; confidence: number }>; uncertainty: Record<string, number> };
  evidence: string[];
  budget: { totalCostUnits: number; spent: number };
  approvals: string[];
  artifacts: Array<{ id: string; kind: string; ref: string }>;
}

export interface TopologySpec {
  /** roles that participate, in dependency order */
  nodes: AgentContract[];
  edges: Array<{ from: string; to: string; handoff: string }>;
}

export const ROLE_CONTRACTS: Record<AgentRoleName, AgentContract> = {
  supervisor: { role: 'supervisor', input: { goal: 'the goal graph' }, output: { verdict: 'final verified result' }, timeoutMs: 30 * 60_000, budget: { maxActions: 200, maxCostUnits: 500 }, heartbeatIntervalMs: 60_000 },
  explorer: { role: 'explorer', input: { observation: 'current environment affordances' }, output: { map: 'unknown-action report + hypotheses' }, timeoutMs: 10 * 60_000, budget: { maxActions: 30, maxCostUnits: 60 }, heartbeatIntervalMs: 30_000 },
  planner: { role: 'planner', input: { goal: 'goal', world: 'belief table' }, output: { plan: 'ordered action proposal' }, timeoutMs: 5 * 60_000, budget: { maxActions: 15, maxCostUnits: 30 }, heartbeatIntervalMs: 30_000 },
  implementer: { role: 'implementer', input: { plan: 'ordered actions' }, output: { changes: 'applied actions + artifacts' }, timeoutMs: 20 * 60_000, budget: { maxActions: 100, maxCostUnits: 200 }, heartbeatIntervalMs: 30_000 },
  critic: { role: 'critic', input: { changes: 'applied changes' }, output: { review: 'risks + regressions found' }, timeoutMs: 5 * 60_000, budget: { maxActions: 10, maxCostUnits: 20 }, heartbeatIntervalMs: 30_000 },
  verifier: { role: 'verifier', input: { changes: 'applied changes', criteria: 'success criteria' }, output: { verdict: 'pass/fail per criterion' }, timeoutMs: 10 * 60_000, budget: { maxActions: 40, maxCostUnits: 80 }, heartbeatIntervalMs: 30_000 },
  researcher: { role: 'researcher', input: { question: 'open question' }, output: { findings: 'evidence-linked findings' }, timeoutMs: 10 * 60_000, budget: { maxActions: 30, maxCostUnits: 60 }, heartbeatIntervalMs: 30_000 },
  'memory-curator': { role: 'memory-curator', input: { trajectory: 'finished trajectory' }, output: { memories: 'distilled entries with provenance' }, timeoutMs: 5 * 60_000, budget: { maxActions: 20, maxCostUnits: 40 }, heartbeatIntervalMs: 30_000 },
};

/** MA-002/003. Compose a topology from roles with handoffs. */
export function defineTopology(roles: AgentRoleName[], handoffs?: Array<{ from: AgentRoleName; to: AgentRoleName; handoff: string }>): TopologySpec {
  const seen = new Set<AgentRoleName>();
  const nodes: AgentContract[] = [];
  for (const r of roles) {
    if (seen.has(r)) continue;
    seen.add(r);
    nodes.push(ROLE_CONTRACTS[r]);
  }
  const edges = (handoffs ?? []).map((h) => ({ from: h.from, to: h.to, handoff: h.handoff }));
  return { nodes, edges };
}

/** The supervisor-owned runtime state for one multi-agent run. */
export class AgentTopology {
  private nodes = new Map<string, AgentNode>();
  private blackboard: SharedBlackboard;
  private seq = 0;

  constructor(
    public spec: TopologySpec,
    blackboard: SharedBlackboard,
  ) {
    this.blackboard = blackboard;
    for (const c of spec.nodes) {
      const id = `${c.role}-${++this.seq}`;
      this.nodes.set(id, { id, role: c.role, status: 'pending', contract: c });
    }
  }

  view(): AgentNode[] {
    return [...this.nodes.values()];
  }

  /** grow the running topology with a new node of a role (live spawns) */
  addNode(role: AgentRoleName): AgentNode {
    const contract = ROLE_CONTRACTS[role];
    const id = `${role}-${++this.seq}`;
    const node: AgentNode = { id, role, status: 'pending', contract };
    this.nodes.set(id, node);
    this.spec.nodes.push(contract);
    return node;
  }

  board(): SharedBlackboard {
    return JSON.parse(JSON.stringify(this.blackboard));
  }

  start(id: string): void {
    const n = this.nodes.get(id);
    if (n && n.status === 'pending') {
      n.status = 'running';
      n.startedAt = new Date().toISOString();
      n.lastHeartbeatAt = n.startedAt;
    }
  }

  /** MA-007. Liveness signal; stale agents are visible to the supervisor. */
  heartbeat(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.lastHeartbeatAt = new Date().toISOString();
  }

  /** MA-007 watchdog: running agents silent past 3x their interval. */
  staleAgents(now = Date.now()): AgentNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.status === 'running' && n.lastHeartbeatAt && now - new Date(n.lastHeartbeatAt).getTime() > 3 * n.contract.heartbeatIntervalMs,
    );
  }

  finish(id: string, result: unknown): void {
    const n = this.nodes.get(id);
    if (n && n.status === 'running') {
      n.status = 'done';
      n.endedAt = new Date().toISOString();
      n.result = result;
    }
  }

  fail(id: string, failure: { code: string; message: string }): void {
    const n = this.nodes.get(id);
    if (n && (n.status === 'running' || n.status === 'pending')) {
      n.status = 'failed';
      n.endedAt = new Date().toISOString();
      n.failure = failure;
    }
  }

  /** MA-008. Cancellation cascades downstream over the role handoff graph:
   *  agents whose inputs depend on a cancelled role cannot run. */
  cancel(id: string): AgentRoleName[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    n.status = 'cancelled';
    n.endedAt = new Date().toISOString();
    const cancelledRoles = new Set<AgentRoleName>([n.contract.role]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const e of this.spec.edges) {
        if (cancelledRoles.has(e.from as AgentRoleName) && !cancelledRoles.has(e.to as AgentRoleName)) {
          cancelledRoles.add(e.to as AgentRoleName);
          expanded = true;
        }
      }
    }
    for (const node of this.nodes.values()) {
      if (cancelledRoles.has(node.contract.role) && (node.status === 'pending' || node.status === 'running')) {
        node.status = 'cancelled';
        node.endedAt = new Date().toISOString();
      }
    }
    return [...cancelledRoles];
  }

  /** MA-009. Budget enforcement on the shared board. */
  trySpend(costUnits: number): { ok: boolean; spent: number; total: number } {
    const { totalCostUnits, spent } = this.blackboard.budget;
    const ok = spent + costUnits <= totalCostUnits;
    if (ok) this.blackboard.budget.spent += costUnits;
    return { ok, spent: this.blackboard.budget.spent, total: totalCostUnits };
  }

  addEvidence(ref: string): void {
    this.blackboard.evidence.push(ref);
  }

  addArtifact(artifact: { id: string; kind: string; ref: string }): void {
    this.blackboard.artifacts.push(artifact);
  }
}
