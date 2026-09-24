/**
 * @hmharness/evolution - Router Evolution (P2-05)
 *
 * The audit called for: "让 model routing 本身成为可实验、可回滚策略"
 *
 * Makes routing decisions experimentable: a routing policy can be registered
 * as a candidate, A/B tested against the current policy, and promoted or
 * rolled back based on SPRT results.
 */

import type { RouteHistoryEntry } from '@hmharness/kernel';

export interface RoutingPolicy {
  id: string;
  name: string;
  description: string;
  /** the routing function */
  decide: (history: RouteHistoryEntry[], taskType: string, candidates: string[]) => string;
}

export interface RoutingExperiment {
  id: string;
  /** the challenger policy */
  challenger: RoutingPolicy;
  /** incumbent policy (or 'default' for current behavior) */
  incumbent: string;
  /** control arm results */
  controlSuccesses: number;
  controlTotal: number;
  /** treatment arm results */
  treatmentSuccesses: number;
  treatmentTotal: number;
  status: 'running' | 'promoted' | 'rolled-back' | 'inconclusive';
  startedAt: string;
}

/**
 * Evaluate a routing experiment using simple SPRT logic.
 * Pure - testable.
 */
export function evaluateExperiment(exp: RoutingExperiment): {
  decision: 'continue' | 'promote' | 'rollback';
  reason: string;
} {
  const minN = 20; // minimum samples per arm
  if (exp.controlTotal < minN || exp.treatmentTotal < minN) {
    return { decision: 'continue', reason: `insufficient samples (control ${exp.controlTotal}/${minN}, treatment ${exp.treatmentTotal}/${minN})` };
  }
  const controlRate = exp.controlSuccesses / exp.controlTotal;
  const treatmentRate = exp.treatmentSuccesses / exp.treatmentTotal;
  const diff = treatmentRate - controlRate;
  // promote if treatment is 5pp better, rollback if 5pp worse
  if (diff >= 0.05) {
    return { decision: 'promote', reason: `treatment ${treatmentRate.toFixed(2)} vs control ${controlRate.toFixed(2)} (+${(diff * 100).toFixed(1)}pp)` };
  }
  if (diff <= -0.05) {
    return { decision: 'rollback', reason: `treatment ${treatmentRate.toFixed(2)} vs control ${controlRate.toFixed(2)} (${(diff * 100).toFixed(1)}pp)` };
  }
  return { decision: 'continue', reason: `diff ${(diff * 100).toFixed(1)}pp within noise band` };
}

/**
 * The routing policy registry - manages candidate and active policies.
 */
export class RoutingPolicyRegistry {
  private policies = new Map<string, RoutingPolicy>();
  private activePolicyId = 'default';

  register(policy: RoutingPolicy): { ok: boolean; reason?: string } {
    if (this.policies.has(policy.id)) return { ok: false, reason: `policy ${policy.id} already registered` };
    this.policies.set(policy.id, policy);
    return { ok: true };
  }

  get(id: string): RoutingPolicy | undefined {
    return this.policies.get(id);
  }

  list(): RoutingPolicy[] {
    return [...this.policies.values()];
  }

  /** Get the currently active policy */
  getActive(): RoutingPolicy | undefined {
    return this.policies.get(this.activePolicyId);
  }

  /** Promote a policy to active (rollback = set back to 'default') */
  promote(policyId: string): boolean {
    if (!this.policies.has(policyId)) return false;
    this.activePolicyId = policyId;
    return true;
  }

  /** Rollback to default policy */
  rollback(): void {
    this.activePolicyId = 'default';
  }

  get activeId(): string {
    return this.activePolicyId;
  }
}
