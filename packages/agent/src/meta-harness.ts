/**
 * @hmharness/agent - Harness-of-Harness (P3-03)
 *
 * The audit: "一个 meta-agent 专门设计候选 Harness，再由 independent evaluator 验收"
 *
 * A meta-agent that designs candidate harness configurations (tool sets,
 * prompt strategies, agent topologies) which are then validated by an
 * independent evaluator. This is the self-referential optimization loop.
 */

export interface HarnessCandidate {
  id: string;
  name: string;
  description: string;
  /** what tools are available */
  tools: string[];
  /** system prompt template */
  systemPrompt: string;
  /** agent topology (single/dual/team/pipeline) */
  topology: 'single' | 'dual' | 'team' | 'pipeline';
  /** max turns budget */
  maxTurns: number;
  /** approval policy */
  approvalPolicy: 'ask' | 'auto' | 'yolo';
  /** generation metadata */
  generatedBy: string;
  generation: number; // which iteration of meta-optimization
}

export interface HarnessEvaluation {
  candidateId: string;
  /** independent evaluator's score [0,1] */
  score: number;
  /** specific strengths */
  strengths: string[];
  /** specific weaknesses */
  weaknesses: string[];
  /** recommended action */
  recommendation: 'adopt' | 'reject' | 'iterate';
  evaluatorId: string;
  evaluatedAt: string;
}

export interface MetaHarnessIteration {
  iteration: number;
  candidates: HarnessCandidate[];
  evaluations: HarnessEvaluation[];
  bestCandidate?: HarnessCandidate;
  improvement: number; // vs previous iteration
}

/**
 * Generate a candidate harness variation from a base.
 * Pure - testable.
 */
export function generateCandidate(
  base: HarnessCandidate,
  mutation: Partial<HarnessCandidate>,
  generation: number,
): HarnessCandidate {
  return {
    ...base,
    ...mutation,
    id: `cand-${generation}-${Date.now().toString(36).slice(-4)}`,
    generation,
    generatedBy: `meta-agent-gen-${generation}`,
  };
}

/**
 * Evaluate a candidate (simulated independent evaluator).
 * Pure - testable.
 */
export function evaluateCandidate(
  candidate: HarnessCandidate,
  metrics: { passRate: number; avgTurns: number; avgTokens: number; safetyScore: number },
): HarnessEvaluation {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  if (metrics.passRate > 0.7) strengths.push(`high pass rate (${(metrics.passRate * 100).toFixed(0)}%)`);
  else weaknesses.push(`low pass rate (${(metrics.passRate * 100).toFixed(0)}%)`);
  if (metrics.avgTurns < 10) strengths.push(`efficient (${metrics.avgTurns.toFixed(1)} avg turns)`);
  else weaknesses.push(`too many turns (${metrics.avgTurns.toFixed(1)} avg)`);
  if (metrics.safetyScore > 0.9) strengths.push('safe operation');
  else weaknesses.push(`safety concerns (${(metrics.safetyScore * 100).toFixed(0)}%)`);
  const score = metrics.passRate * 0.5 + Math.max(0, 1 - metrics.avgTurns / 30) * 0.2 + metrics.safetyScore * 0.3;
  const recommendation: HarnessEvaluation['recommendation'] = score > 0.7 ? 'adopt' : score > 0.4 ? 'iterate' : 'reject';
  return {
    candidateId: candidate.id,
    score: Math.round(score * 100) / 100,
    strengths, weaknesses,
    recommendation,
    evaluatorId: 'independent-evaluator-v1',
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Select the best candidate from evaluations.
 * Pure - testable.
 */
export function selectBest(
  candidates: HarnessCandidate[],
  evaluations: HarnessEvaluation[],
): HarnessCandidate | undefined {
  const evalMap = new Map(evaluations.map(e => [e.candidateId, e]));
  const scored = candidates
    .map(c => ({ candidate: c, score: evalMap.get(c.id)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.candidate;
}

/**
 * Run one iteration of the meta-harness loop.
 * Pure - testable.
 */
export function runIteration(
  iteration: number,
  candidates: HarnessCandidate[],
  allEvaluations: HarnessEvaluation[],
  previousBestScore: number,
): MetaHarnessIteration {
  const evaluations = allEvaluations.filter(e => candidates.some(c => c.id === e.candidateId));
  const best = selectBest(candidates, evaluations);
  const bestScore = evaluations.find(e => e.candidateId === best?.id)?.score ?? 0;
  return {
    iteration,
    candidates,
    evaluations,
    bestCandidate: best,
    improvement: Math.round((bestScore - previousBestScore) * 1000) / 1000,
  };
}
