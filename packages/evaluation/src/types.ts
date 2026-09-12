/**
 * @hmharness/evaluation - the Evaluator contract (V2 blueprint M2).
 *
 * Evidence outranks narrative. The evidence ladder (ADR-0001 rule 4):
 * a build failure is FACT, an LLM opinion is a guess with good manners.
 * Every evaluation carries machine-checkable evidence references so a
 * promotion decision can be audited without re-running anything.
 */

/** Where a piece of evidence sits on the trust ladder - LOWER number = harder. */
export const EVIDENCE_RANK = {
  build: 1,
  tests: 2,
  static: 3,
  runtime: 4,
  deviceLogs: 5,
  screenshot: 6,
  llmJudge: 7,
  selfReport: 8,
} as const;

export type EvidenceKind = keyof typeof EVIDENCE_RANK;

export interface Evidence {
  kind: EvidenceKind;
  /** What was observed, verbatim where possible (bounded). */
  detail: string;
  passed?: boolean;
}

export interface Failure {
  reason: string;
  evidence?: Evidence;
}

export interface EvaluationResult<E = Evidence> {
  /** 0..1 */
  score: number;
  passed: boolean;
  evidence: E[];
  failures: Failure[];
  evaluatorId: string;
  evaluatorVersion: string;
  durationMs: number;
  /** The run this evaluation judged, when tied to a trajectory. */
  runId?: string;
}

export interface Evaluator<Input = unknown> {
  id: string;
  version: string;
  /** Where this evaluator's evidence sits on the trust ladder. */
  evidenceKind: EvidenceKind;
  description: string;
  evaluate(input: Input): Promise<EvaluationResult>;
}

/** Shared scoring helper: all-or-nothing evidence -> 1 or 0; partial allowed. */
export function scoreFromEvidence(evidence: Evidence[], failures: Failure[]): { score: number; passed: boolean } {
  const ranked = [...evidence].sort((a, b) => EVIDENCE_RANK[a.kind] - EVIDENCE_RANK[b.kind]);
  const passing = ranked.filter((e) => e.passed !== false).length;
  // an llmJudge/selfReport-only pass is never a full pass (evidence-first rule)
  const weakestPass = ranked.length > 0 ? EVIDENCE_RANK[ranked[ranked.length - 1].kind] : EVIDENCE_RANK.selfReport;
  const hardCap = weakestPass >= EVIDENCE_RANK.llmJudge ? 0.7 : 1;
  const ratio = ranked.length > 0 ? passing / ranked.length : 0;
  return { score: Math.min(hardCap, ratio), passed: failures.length === 0 && ratio === 1 };
}
