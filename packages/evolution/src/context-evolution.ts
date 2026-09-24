/**
 * @hmharness/evolution - Context Ranker Evolution (P2-04)
 *
 * The audit called for: "让 context policy 进入 Evolution"
 *
 * Makes the context ranker's weights evolvable: they can be registered
 * as candidates, A/B tested, and promoted/rolled back via the same
 * evolution machinery that handles skills and routing policies.
 *
 * The existing ContextRanker uses fixed RANK_WEIGHTS; this module wraps
 * those weights in an experimentable policy.
 */

export interface ContextWeights {
  /** relevance to current task */
  relevance: number;
  /** recency (newer = higher) */
  recency: number;
  /** frequency of access */
  frequency: number;
  /** token cost penalty (lower cost = higher rank) */
  costEfficiency: number;
  /** source trust (insights > generic) */
  source: number;
}

export const DEFAULT_CONTEXT_WEIGHTS: ContextWeights = {
  relevance: 0.40,
  recency: 0.20,
  frequency: 0.15,
  costEfficiency: 0.10,
  source: 0.15,
};

export interface ContextPolicy {
  id: string;
  name: string;
  weights: ContextWeights;
  description: string;
}

export interface ContextEvolutionExperiment {
  id: string;
  challenger: ContextPolicy;
  incumbent: ContextPolicy;
  /** A/B results */
  controlScores: number[];   // outcome scores with incumbent weights
  treatmentScores: number[]; // outcome scores with challenger weights
  status: 'running' | 'promoted' | 'rolled-back' | 'inconclusive';
  startedAt: string;
}

/**
 * Validate that context weights are reasonable (sum to ~1, all non-negative).
 * Pure - testable.
 */
export function validateWeights(w: ContextWeights): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const entries = Object.entries(w);
  for (const [k, v] of entries) {
    if (v < 0) errors.push(`${k} must be >= 0, got ${v}`);
    if (v > 1) errors.push(`${k} must be <= 1, got ${v}`);
  }
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (Math.abs(sum - 1) > 0.05) errors.push(`weights sum to ${sum.toFixed(2)}, expected ~1.0`);
  return { valid: errors.length === 0, errors };
}

/**
 * Score a context item given weights and features.
 * Pure - testable.
 */
export function scoreContextItem(
  weights: ContextWeights,
  features: { relevance: number; recency: number; frequency: number; tokenCost: number; sourceTrust: number },
): number {
  const costEff = features.tokenCost > 0 ? 1 / (1 + features.tokenCost / 1000) : 1;
  return (
    weights.relevance * features.relevance +
    weights.recency * features.recency +
    weights.frequency * features.frequency +
    weights.costEfficiency * costEff +
    weights.source * features.sourceTrust
  );
}

/**
 * Rank context items by score (highest first).
 * Pure - testable.
 */
export function rankItems(
  weights: ContextWeights,
  items: Array<{ id: string; features: Parameters<typeof scoreContextItem>[1] }>,
): Array<{ id: string; score: number }> {
  return items
    .map(item => ({ id: item.id, score: scoreContextItem(weights, item.features) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Evaluate a context evolution experiment.
 * Simple paired comparison of mean scores.
 * Pure - testable.
 */
export function evaluateContextExperiment(exp: ContextEvolutionExperiment): {
  decision: 'continue' | 'promote' | 'rollback';
  reason: string;
} {
  const minN = 10;
  if (exp.controlScores.length < minN || exp.treatmentScores.length < minN) {
    return { decision: 'continue', reason: `insufficient samples (control ${exp.controlScores.length}/${minN}, treatment ${exp.treatmentScores.length}/${minN})` };
  }
  const ctrlMean = exp.controlScores.reduce((a, b) => a + b, 0) / exp.controlScores.length;
  const trtMean = exp.treatmentScores.reduce((a, b) => a + b, 0) / exp.treatmentScores.length;
  const diff = trtMean - ctrlMean;
  // promote if challenger is meaningfully better
  if (diff > 0.02) return { decision: 'promote', reason: `treatment ${trtMean.toFixed(3)} vs control ${ctrlMean.toFixed(3)} (+${diff.toFixed(3)})` };
  if (diff < -0.02) return { decision: 'rollback', reason: `treatment ${trtMean.toFixed(3)} vs control ${ctrlMean.toFixed(3)} (${diff.toFixed(3)})` };
  return { decision: 'continue', reason: `diff ${diff.toFixed(3)} within noise` };
}

/**
 * Registry for context policies (similar to RoutingPolicyRegistry).
 */
export class ContextPolicyRegistry {
  private policies = new Map<string, ContextPolicy>();
  private activeId = 'default';

  register(policy: ContextPolicy): { ok: boolean; reason?: string } {
    const v = validateWeights(policy.weights);
    if (!v.valid) return { ok: false, reason: v.errors.join('; ') };
    if (this.policies.has(policy.id)) return { ok: false, reason: `policy ${policy.id} already registered` };
    this.policies.set(policy.id, policy);
    return { ok: true };
  }

  get(id: string): ContextPolicy | undefined { return this.policies.get(id); }
  list(): ContextPolicy[] { return [...this.policies.values()]; }
  getActive(): ContextPolicy | undefined { return this.policies.get(this.activeId); }
  get activePolicyId(): string { return this.activeId; }

  promote(id: string): boolean {
    if (!this.policies.has(id)) return false;
    this.activeId = id;
    return true;
  }

  rollback(): void { this.activeId = 'default'; }
}
