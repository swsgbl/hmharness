/**
 * @hmharness/kernel - Adaptive Model Router (P1-05)
 *
 * The audit called for: "基于历史 success/cost/latency 的路由实验"
 *
 * Routes requests to the best provider based on historical performance
 * metrics (success rate, token cost, latency) per task type.
 */

export interface RouteHistoryEntry {
  provider: string;
  taskType: string;
  success: boolean;
  tokens: number;
  durationMs: number;
  timestamp: string;
}

export interface ProviderStats {
  provider: string;
  taskType: string;
  totalRequests: number;
  successRate: number;
  avgTokens: number;
  avgDurationMs: number;
  /** composite score [0,1] - higher is better */
  score: number;
}

export interface RouteDecision {
  provider: string;
  reason: string;
  stats?: ProviderStats;
  /** all candidates considered */
  alternatives: Array<{ provider: string; score: number }>;
}

/**
 * Compute statistics for a provider from history.
 * Pure - testable.
 */
export function computeStats(history: RouteHistoryEntry[], provider: string, taskType: string): ProviderStats | undefined {
  const entries = history.filter(h => h.provider === provider && h.taskType === taskType);
  if (entries.length === 0) return undefined;
  const success = entries.filter(e => e.success).length;
  const avgTokens = entries.reduce((a, b) => a + b.tokens, 0) / entries.length;
  const avgDuration = entries.reduce((a, b) => a + b.durationMs, 0) / entries.length;
  const successRate = success / entries.length;
  // composite: 60% success + 20% cost efficiency + 20% latency efficiency
  // cost and latency are inverse-normalized against the best in the set
  return {
    provider, taskType,
    totalRequests: entries.length,
    successRate,
    avgTokens,
    avgDurationMs: avgDuration,
    score: successRate, // will be adjusted by computeRoute
  };
}

/**
 * Decide which provider to route to based on historical performance.
 * Pure - testable.
 */
export function computeRoute(
  history: RouteHistoryEntry[],
  taskType: string,
  candidates: string[],
  opts: { minSamples?: number; successWeight?: number; costWeight?: number; latencyWeight?: number } = {},
): RouteDecision {
  const { minSamples = 3, successWeight = 0.6, costWeight = 0.2, latencyWeight = 0.2 } = opts;
  const statsList: ProviderStats[] = [];
  for (const p of candidates) {
    const s = computeStats(history, p, taskType);
    if (s && s.totalRequests >= minSamples) statsList.push(s);
  }
  if (statsList.length === 0) {
    return {
      provider: candidates[0] ?? 'default',
      reason: 'insufficient history - using first candidate',
      alternatives: candidates.map(p => ({ provider: p, score: 0 })),
    };
  }
  // normalize cost and latency across candidates
  const minTokens = Math.min(...statsList.map(s => s.avgTokens));
  const minDuration = Math.min(...statsList.map(s => s.avgDurationMs));
  for (const s of statsList) {
    const costEff = minTokens > 0 ? minTokens / s.avgTokens : 1;
    const latencyEff = minDuration > 0 ? minDuration / s.avgDurationMs : 1;
    s.score = successWeight * s.successRate + costWeight * costEff + latencyWeight * latencyEff;
  }
  statsList.sort((a, b) => b.score - a.score);
  const best = statsList[0];
  return {
    provider: best.provider,
    reason: `best composite score ${best.score.toFixed(3)} (success ${(best.successRate * 100).toFixed(0)}%, ${best.totalRequests} samples)`,
    stats: best,
    alternatives: statsList.map(s => ({ provider: s.provider, score: Math.round(s.score * 1000) / 1000 })),
  };
}

/**
 * Format route history as a summary string.
 * Pure - testable.
 */
export function routeSummary(history: RouteHistoryEntry[]): string {
  const byProvider = new Map<string, { total: number; success: number; avgTokens: number }>();
  for (const h of history) {
    const cur = byProvider.get(h.provider) ?? { total: 0, success: 0, avgTokens: 0 };
    cur.total++;
    if (h.success) cur.success++;
    cur.avgTokens = (cur.avgTokens * (cur.total - 1) + h.tokens) / cur.total;
    byProvider.set(h.provider, cur);
  }
  const lines = [`routing history: ${history.length} entries`];
  for (const [p, s] of byProvider) {
    lines.push(`  ${p}: ${s.success}/${s.total} success (${Math.round(s.success / s.total * 100)}%), avg ${Math.round(s.avgTokens)} tokens`);
  }
  return lines.join('\n');
}
