/**
 * @hmharness/evolution - Policy Optimization (P3-02)
 *
 * The audit: "把 prompt、skill、tool policy、routing、workflow 全部视为可优化 policy"
 *
 * Provides a unified optimization framework where every configurable aspect
 * of the harness (prompts, skills, tool policies, routing, workflows) is
 * a first-class "Policy" that can be experimented on and improved.
 */

export type PolicyKind = 'prompt' | 'skill' | 'tool-policy' | 'routing' | 'workflow' | 'context' | 'model';

export interface OptimizablePolicy {
  id: string;
  kind: PolicyKind;
  name: string;
  /** current value/configuration */
  value: unknown;
  /** human-readable description of what this policy controls */
  description: string;
  /** how changes to this policy are tested */
  evaluationMethod: string;
}

export interface PolicyExperiment {
  id: string;
  policy: OptimizablePolicy;
  /** proposed new value */
  challenger: unknown;
  /** A/B arm results */
  controlScores: number[];
  treatmentScores: number[];
  status: 'proposed' | 'running' | 'promoted' | 'rolled-back' | 'rejected';
  createdAt: string;
}

export interface PolicyOptimizationReport {
  totalPolicies: number;
  activeExperiments: number;
  promotedCount: number;
  rolledBackCount: number;
  byKind: Record<PolicyKind, number>;
}

/**
 * The policy registry - all optimizable policies in one place.
 */
export class PolicyOptimizer {
  private policies = new Map<string, OptimizablePolicy>();
  private experiments = new Map<string, PolicyExperiment>();

  registerPolicy(policy: OptimizablePolicy): { ok: boolean; reason?: string } {
    if (this.policies.has(policy.id)) return { ok: false, reason: `policy ${policy.id} already registered` };
    this.policies.set(policy.id, policy);
    return { ok: true };
  }

  getPolicy(id: string): OptimizablePolicy | undefined {
    return this.policies.get(id);
  }

  listPolicies(kind?: PolicyKind): OptimizablePolicy[] {
    const all = [...this.policies.values()];
    return kind ? all.filter(p => p.kind === kind) : all;
  }

  /**
   * Propose an experiment: change a policy's value.
   */
  proposeExperiment(policyId: string, challenger: unknown): { ok: boolean; experimentId?: string; reason?: string } {
    const policy = this.policies.get(policyId);
    if (!policy) return { ok: false, reason: `policy ${policyId} not found` };
    const expId = `exp-${Date.now().toString(36)}`;
    this.experiments.set(expId, {
      id: expId, policy, challenger,
      controlScores: [], treatmentScores: [],
      status: 'proposed', createdAt: new Date().toISOString(),
    });
    return { ok: true, experimentId: expId };
  }

  /**
   * Record a result for an experiment arm.
   */
  recordResult(experimentId: string, arm: 'control' | 'treatment', score: number): boolean {
    const exp = this.experiments.get(experimentId);
    if (!exp) return false;
    if (arm === 'control') exp.controlScores.push(score);
    else exp.treatmentScores.push(score);
    exp.status = 'running';
    return true;
  }

  /**
   * Evaluate an experiment (simple mean comparison).
   * Pure logic within the method.
   */
  evaluateExperiment(experimentId: string): { decision: string; reason: string } | undefined {
    const exp = this.experiments.get(experimentId);
    if (!exp) return undefined;
    const minN = 10;
    if (exp.controlScores.length < minN || exp.treatmentScores.length < minN) {
      return { decision: 'continue', reason: `insufficient samples (ctrl ${exp.controlScores.length}/${minN}, trt ${exp.treatmentScores.length}/${minN})` };
    }
    const ctrlMean = exp.controlScores.reduce((a, b) => a + b, 0) / exp.controlScores.length;
    const trtMean = exp.treatmentScores.reduce((a, b) => a + b, 0) / exp.treatmentScores.length;
    const diff = trtMean - ctrlMean;
    if (diff > 0.02) {
      exp.status = 'promoted';
      exp.policy.value = exp.challenger;
      return { decision: 'promote', reason: `treatment +${diff.toFixed(3)}` };
    }
    if (diff < -0.02) {
      exp.status = 'rolled-back';
      return { decision: 'rollback', reason: `treatment ${diff.toFixed(3)}` };
    }
    return { decision: 'continue', reason: `diff ${diff.toFixed(3)} within noise` };
  }

  /**
   * Generate a summary report.
   */
  report(): PolicyOptimizationReport {
    const all = [...this.policies.values()];
    const exps = [...this.experiments.values()];
    const byKind: Record<string, number> = {};
    for (const p of all) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    return {
      totalPolicies: all.length,
      activeExperiments: exps.filter(e => e.status === 'running').length,
      promotedCount: exps.filter(e => e.status === 'promoted').length,
      rolledBackCount: exps.filter(e => e.status === 'rolled-back').length,
      byKind: byKind as Record<PolicyKind, number>,
    };
  }
}
