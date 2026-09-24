/**
 * @hmharness/evaluation - Evaluator SDK (P1-02)
 *
 * The audit called for: "统一 evaluator plugin、evidence references、metric registry"
 *
 * This module provides the plugin interface that ALL evaluators implement,
 * evidence references that link scores to concrete proof, and a metric
 * registry for named, versioned scoring functions.
 */

/** Evidence tier per the existing evidence ladder (M2) */
export type EvidenceTier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Reference to concrete evidence backing an evaluation */
export interface EvidenceRef {
  /** what kind of evidence */
  kind: 'build-log' | 'test-result' | 'command-output' | 'file-content' | 'judge-score' | 'device-log' | 'metric';
  /** where to find it (path, URL, or inline) */
  source: string;
  /** relevant excerpt (for audit trail) */
  excerpt?: string;
  /** evidence tier (1=build, 7=llm-judge, 8=self-report) */
  tier: EvidenceTier;
}

/** The result of running an evaluator */
export interface SdkEvaluationResult {
  /** evaluator that produced this result */
  evaluatorId: string;
  /** pass/fail/indeterminate */
  outcome: 'pass' | 'fail' | 'indeterminate';
  /** numeric score [0,1] if applicable */
  score?: number;
  /** human-readable detail */
  detail: string;
  /** evidence backing this result */
  evidence: EvidenceRef[];
  /** when this evaluation ran */
  evaluatedAt: string;
  /** duration in ms */
  durationMs: number;
}

/** The evaluator plugin interface - ALL evaluators implement this */
export interface SdkEvaluator {
  /** unique evaluator id */
  readonly id: string;
  /** what this evaluator checks */
  readonly description: string;
  /** evidence tier this evaluator operates at */
  readonly tier: EvidenceTier;
  /** evaluate and return a result */
  evaluate(input: unknown): Promise<SdkEvaluationResult>;
}

/** A named metric in the registry */
export interface MetricDef {
  name: string;
  description: string;
  /** units (e.g. 'percent', 'count', 'ms') */
  unit: string;
  /** higher is better? (for display) */
  higherIsBetter: boolean;
  /** compute from evaluation results */
  compute: (results: SdkEvaluationResult[]) => number;
}

/**
 * The metric registry - named, versioned scoring functions.
 * Metrics are registered once and referenced by name everywhere.
 */
export class MetricRegistry {
  private metrics = new Map<string, MetricDef>();

  register(def: MetricDef): { ok: boolean; reason?: string } {
    if (this.metrics.has(def.name)) {
      return { ok: false, reason: `metric ${def.name} already registered` };
    }
    this.metrics.set(def.name, def);
    return { ok: true };
  }

  get(name: string): MetricDef | undefined {
    return this.metrics.get(name);
  }

  list(): MetricDef[] {
    return [...this.metrics.values()];
  }

  /** Compute a metric from evaluation results */
  compute(name: string, results: SdkEvaluationResult[]): number | undefined {
    const m = this.metrics.get(name);
    if (!m) return undefined;
    return m.compute(results);
  }
}

/** Create a standard metric registry with common metrics pre-registered */
export function createDefaultRegistry(): MetricRegistry {
  const reg = new MetricRegistry();
  reg.register({
    name: 'pass_rate', description: 'fraction of evaluations that passed',
    unit: 'fraction', higherIsBetter: true,
    compute: (rs) => rs.length > 0 ? rs.filter(r => r.outcome === 'pass').length / rs.length : 0,
  });
  reg.register({
    name: 'avg_score', description: 'average numeric score',
    unit: 'fraction', higherIsBetter: true,
    compute: (rs) => {
      const scored = rs.filter(r => r.score !== undefined);
      return scored.length > 0 ? scored.reduce((a, b) => a + (b.score ?? 0), 0) / scored.length : 0;
    },
  });
  reg.register({
    name: 'avg_duration', description: 'average evaluation duration',
    unit: 'ms', higherIsBetter: false,
    compute: (rs) => rs.length > 0 ? rs.reduce((a, b) => a + b.durationMs, 0) / rs.length : 0,
  });
  reg.register({
    name: 'evidence_coverage', description: 'fraction of results with evidence',
    unit: 'fraction', higherIsBetter: true,
    compute: (rs) => rs.length > 0 ? rs.filter(r => r.evidence.length > 0).length / rs.length : 0,
  });
  return reg;
}

/**
 * Create a simple pass/fail evaluator from a predicate function.
 * Convenience factory for the most common evaluator pattern.
 */
export function createPredicateEvaluator(
  id: string,
  description: string,
  tier: EvidenceTier,
  predicate: (input: unknown) => boolean,
  evidenceKind: EvidenceRef['kind'] = 'command-output',
): SdkEvaluator {
  return {
    id, description, tier,
    async evaluate(input: unknown): Promise<SdkEvaluationResult> {
      const start = Date.now();
      const pass = predicate(input);
      return {
        evaluatorId: id,
        outcome: pass ? 'pass' : 'fail',
        detail: pass ? 'predicate satisfied' : 'predicate not satisfied',
        evidence: [{ kind: evidenceKind, source: 'inline', tier, excerpt: String(input).slice(0, 200) }],
        evaluatedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
      };
    },
  };
}
