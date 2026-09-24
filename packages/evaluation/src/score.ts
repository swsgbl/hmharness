/**
 * @hmharness/evaluation - HMH Score 1.0 (P1-03)
 *
 * The audit called for: "统一 0-100 多维总分体系" with dimensions:
 * correctness, test, reliability, repair, security, cost, latency,
 * human, maintainability.
 *
 * HMH Score is the single number that tracks whether the harness is
 * actually getting better. Every dimension maps to [0,100]; the composite
 * is a weighted mean. Weights are versioned (changing weights = version bump).
 */

export const HMH_SCORE_VERSION = '1.0.0';

export type ScoreDimension =
  | 'correctness'
  | 'test'
  | 'reliability'
  | 'repair'
  | 'security'
  | 'cost'
  | 'latency'
  | 'human'
  | 'maintainability';

/** All dimensions in canonical order */
export const ALL_DIMENSIONS: ScoreDimension[] = [
  'correctness', 'test', 'reliability', 'repair', 'security',
  'cost', 'latency', 'human', 'maintainability',
];

/** Default weights (sum to 1.0) - versioned, changing requires bump */
export const DEFAULT_WEIGHTS: Record<ScoreDimension, number> = {
  correctness: 0.25,
  test: 0.15,
  reliability: 0.12,
  repair: 0.08,
  security: 0.10,
  cost: 0.08,
  latency: 0.07,
  human: 0.10,
  maintainability: 0.05,
};

export interface DimensionScore {
  dimension: ScoreDimension;
  /** raw score [0,100] */
  score: number;
  /** how this score was computed (for audit) */
  method: string;
  /** sample size used to compute this score */
  sampleSize: number;
}

export interface HMHScore {
  version: string;
  /** composite score [0,100] */
  composite: number;
  /** per-dimension breakdown */
  dimensions: DimensionScore[];
  /** when this score was computed */
  computedAt: string;
  /** any warnings about data quality */
  warnings: string[];
}

/**
 * Compute the composite HMH Score from dimension scores.
 * Pure - testable.
 */
export function computeHMHScore(
  dimensions: DimensionScore[],
  weights: Record<ScoreDimension, number> = DEFAULT_WEIGHTS,
): HMHScore {
  const warnings: string[] = [];
  const dimMap = new Map(dimensions.map(d => [d.dimension, d]));
  const missing = ALL_DIMENSIONS.filter(d => !dimMap.has(d));
  if (missing.length > 0) warnings.push(`missing dimensions: ${missing.join(', ')} (treated as 0)`);

  let composite = 0;
  let totalWeight = 0;
  for (const dim of ALL_DIMENSIONS) {
    const ds = dimMap.get(dim);
    const w = weights[dim] ?? 0;
    if (ds) {
      composite += Math.max(0, Math.min(100, ds.score)) * w;
      totalWeight += w;
    }
  }
  if (totalWeight > 0) composite = composite / totalWeight;

  return {
    version: HMH_SCORE_VERSION,
    composite: Math.round(composite * 100) / 100,
    dimensions,
    computedAt: new Date().toISOString(),
    warnings,
  };
}

/**
 * Compute correctness from pass rate.
 * Pure - testable.
 */
export function correctnessFromPassRate(passRate: number, sampleSize: number): DimensionScore {
  return {
    dimension: 'correctness',
    score: Math.round(passRate * 100),
    method: `pass rate × 100 (${sampleSize} samples)`,
    sampleSize,
  };
}

/**
 * Compute test coverage score.
 * Pure - testable.
 */
export function testFromCoverage(coveragePercent: number): DimensionScore {
  return {
    dimension: 'test',
    score: Math.round(Math.min(100, coveragePercent)),
    method: `test coverage % (${coveragePercent.toFixed(1)}%)`,
    sampleSize: 1,
  };
}

/**
 * Compute reliability from success rate.
 * Pure - testable.
 */
export function reliabilityFromSuccessRate(successRate: number, sessions: number): DimensionScore {
  return {
    dimension: 'reliability',
    score: Math.round(successRate * 100),
    method: `session success rate × 100 (${sessions} sessions)`,
    sampleSize: sessions,
  };
}

/**
 * Compute security score from red-team results.
 * Pure - testable.
 */
export function securityFromRedTeam(blocked: number, total: number): DimensionScore {
  const rate = total > 0 ? blocked / total : 0;
  return {
    dimension: 'security',
    score: Math.round(rate * 100),
    method: `red-team block rate (${blocked}/${total} attacks blocked)`,
    sampleSize: total,
  };
}

/**
 * Compute cost efficiency (inverse of cost, normalized).
 * Pure - testable.
 */
export function costFromTokensPerTask(avgTokens: number, budgetTokens: number): DimensionScore {
  const ratio = budgetTokens > 0 ? avgTokens / budgetTokens : 1;
  const score = Math.round(Math.max(0, Math.min(100, (1 - ratio) * 100)));
  return {
    dimension: 'cost',
    score,
    method: `token efficiency (avg ${avgTokens} / budget ${budgetTokens})`,
    sampleSize: 1,
  };
}

/**
 * Compute latency score (inverse of duration, normalized).
 * Pure - testable.
 */
export function latencyFromDuration(avgMs: number, budgetMs: number): DimensionScore {
  const ratio = budgetMs > 0 ? avgMs / budgetMs : 1;
  const score = Math.round(Math.max(0, Math.min(100, (1 - ratio) * 100)));
  return {
    dimension: 'latency',
    score,
    method: `latency efficiency (avg ${avgMs}ms / budget ${budgetMs}ms)`,
    sampleSize: 1,
  };
}

/**
 * Compute human satisfaction from judge scores.
 * Pure - testable.
 */
export function humanFromJudgeScores(scores: number[]): DimensionScore {
  if (scores.length === 0) {
    return { dimension: 'human', score: 0, method: 'no judge scores', sampleSize: 0 };
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    dimension: 'human',
    score: Math.round((avg / 5) * 100), // 5-point scale → 0-100
    method: `avg judge score (${avg.toFixed(2)}/5 across ${scores.length} sessions)`,
    sampleSize: scores.length,
  };
}

/**
 * Format an HMH Score as a human-readable string.
 * Pure - testable.
 */
export function formatHMHScore(score: HMHScore): string {
  const lines = [`HMH Score v${score.version}: ${score.composite}/100`];
  const sorted = [...score.dimensions].sort((a, b) => b.score - a.score);
  for (const d of sorted) {
    const bar = '█'.repeat(Math.round(d.score / 10)) + '░'.repeat(10 - Math.round(d.score / 10));
    lines.push(`  ${d.dimension.padEnd(16)} ${bar} ${String(d.score).padStart(3)}  (${d.method})`);
  }
  if (score.warnings.length > 0) {
    lines.push(`  ⚠ ${score.warnings.join('; ')}`);
  }
  return lines.join('\n');
}
