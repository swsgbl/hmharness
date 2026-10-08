/**
 * @hmharness/evaluation - Research/Production Gate (weekly pack 0.31 P2)
 *
 * The pack asks: "安全、可靠性、泛化、迁移、成本、可解释、可回放、外部复现
 * 八项均有数据；未满足显示 NEEDS-DATA。" This gate audits each dimension
 * against what the codebase actually has (modules, tests, evidence) and
 * reports either the concrete data source or NEEDS-DATA - never a fabricated
 * "pass". The gate is a READ-ONLY instrument: it reports the state of the
 * world, it does not change it.
 *
 *   1  safety       Capability Broker + sandbox red-team + SANDBOX_BYPASS_VECTORS
 *   2  reliability  flaky root fixes + recorder drain contract + restart-budget hardening
 *   3  generalization  skill generalization lab + holdout gates + multi-seed
 *   4  transfer     Transfer OS 2.0 (IR + readiness + 5x5 matrix) + cross-env evidence
 *   5  cost         12-metric protocol (cost) + estTokens CJK correction
 *   6  explainability  Cognitive Ledger DAG + credit assignment (observational)
 *   7  replayability   Evidence Ledger v2 + world-model checkpoint + trajectory replay
 *   8  external reproduction  awesome-list PR + open-source public evidence page
 */
export type GateDimension =
  | 'safety'
  | 'reliability'
  | 'generalization'
  | 'transfer'
  | 'cost'
  | 'explainability'
  | 'replayability'
  | 'external-reproduction';

export type GateStatus = 'has-data' | 'needs-data';

export interface GateFinding {
  dimension: GateDimension;
  status: GateStatus;
  /** what exists (modules, tests, scripts, evidence) when status is has-data */
  evidence: string[];
  /** what is missing and what would fill it, when status is needs-data */
  gap: string;
}

export interface GateReport {
  generatedAt: string;
  findings: GateFinding[];
  summary: { hasData: number; needsData: number; total: number };
}

/** Audit the eight dimensions against what actually exists in the repo.
 *  Pure - takes the existence map as input so tests can construct scenarios. */
export function researchGate(exists: (path: string) => boolean): GateReport {
  const findings: GateFinding[] = [];
  const check = (dim: GateDimension, paths: string[], gapIfMissing: string) => {
    const evidence = paths.filter(exists);
    findings.push(
      evidence.length > 0
        ? { dimension: dim, status: 'has-data' as const, evidence, gap: '' }
        : { dimension: dim, status: 'needs-data' as const, evidence: [], gap: gapIfMissing },
    );
  };

  check('safety', [
    'packages/sandbox/src/broker.ts',
    'packages/sandbox/src/redteam.ts',
    'packages/sandbox/src/__tests__/broker2.test.ts',
  ], 'Capability Broker egress/mount/secret policies + red-team payloads with bypass vectors declared');

  check('reliability', [
    'packages/observability/src/recorder.ts',
    'packages/cognitive/src/evalset.ts',
    'packages/lsp/src/__tests__/lsp.test.ts',
  ], 'Flaky root fixes (recorder drain contract, restart-budget await-the-boundary, holdout discipline)');

  check('generalization', [
    'scripts/skill-generalization-lab.mts',
    'scripts/real-cycle-multiseed.mts',
    'packages/cognitive/src/skill-compiler.ts',
  ], 'Generalization lab (axis attribution), multi-seed instruments, SkillSpecV2 counterexamples');

  check('transfer', [
    'packages/cognitive/src/abstract-actions.ts',
    'scripts/prediction-to-action.mts',
  ], 'Transfer OS 2.0 (Skill IR + environment IR + readiness), cross-env prediction-to-action evidence');

  check('cost', [
    'packages/evaluation/src/metrics.ts',
  ], 'Unified 12-metric protocol including cost dimension');

  check('explainability', [
    'packages/cognitive/src/ledger.ts',
    'packages/cognitive/src/credit-assignment.ts',
  ], 'Cognitive Ledger 2.0 (replayable DAG) + credit assignment (observational lift)');

  check('replayability', [
    'packages/cognitive/src/evidence-ledger.ts',
    'packages/cognitive/src/world-model.ts',
  ], 'Evidence Ledger v2 (canonical lineageId) + world-model checkpoint round-trip');

  check('external-reproduction', [
    'website/evidence/index.html',
  ], 'Public evidence page + awesome-list entry + fresh-install verification scripts');

  const hasData = findings.filter((f) => f.status === 'has-data').length;
  return {
    generatedAt: new Date().toISOString(),
    findings,
    summary: { hasData, needsData: findings.length - hasData, total: findings.length },
  };
}
