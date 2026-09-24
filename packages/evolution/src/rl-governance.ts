/**
 * @hmharness/evolution - RL Governance (P3-01 + P3-05)
 *
 * The audit: "只有 trajectory 数据经过过滤、去污染、去泄漏、holdout 后再考虑"
 *
 * Formalizes the governance pipeline that ALL training data must pass
 * before entering model fine-tuning. This is the data quality gate.
 */

export type DecontaminationAction = 'pass' | 'quarantine' | 'reject';

export interface TrajectoryRecord {
  id: string;
  taskId: string;
  prompt: string;
  output: string;
  outcome: 'ok' | 'degraded' | 'timeout' | 'error';
  tokens: number;
  turns: number;
  /** whether this trajectory came from an external task */
  isExternal: boolean;
  /** whether this trajectory is in the holdout set */
  isHoldout: boolean;
}

export interface DecontaminationResult {
  recordId: string;
  action: DecontaminationAction;
  reasons: string[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/** Types of leakage to check for */
export type LeakageType =
  | 'holdout-in-train'      // holdout task leaked into training set
  | 'self-eval'             // agent evaluating its own output as ground truth
  | 'prompt-duplication'    // same prompt in both train and eval
  | 'external-in-train';    // external holdout task in training data

export interface LeakageCheck {
  type: LeakageType;
  detected: boolean;
  details: string[];
}

/**
 * Filter trajectories by quality before training.
 * Pure - testable.
 */
export function filterForTraining(records: TrajectoryRecord[]): {
  eligible: TrajectoryRecord[];
  rejected: Array<{ record: TrajectoryRecord; reason: string }>;
} {
  const eligible: TrajectoryRecord[] = [];
  const rejected: Array<{ record: TrajectoryRecord; reason: string }> = [];
  for (const r of records) {
    if (r.isHoldout) { rejected.push({ record: r, reason: 'holdout record must never enter training' }); continue; }
    if (r.isExternal) { rejected.push({ record: r, reason: 'external task must stay in holdout' }); continue; }
    if (!r.prompt.trim()) { rejected.push({ record: r, reason: 'empty prompt' }); continue; }
    if (!r.output.trim()) { rejected.push({ record: r, reason: 'empty output' }); continue; }
    if (r.outcome === 'error') { rejected.push({ record: r, reason: 'error outcome not suitable for training' }); continue; }
    eligible.push(r);
  }
  return { eligible, rejected };
}

/**
 * Detect leakage between training and holdout sets.
 * Pure - testable.
 */
export function detectLeakage(
  trainingRecords: TrajectoryRecord[],
  holdoutRecords: TrajectoryRecord[],
): LeakageCheck[] {
  const checks: LeakageCheck[] = [];
  // 1. holdout-in-train: any holdout record's prompt appears in training
  const holdoutPrompts = new Set(holdoutRecords.map(r => r.prompt.trim().toLowerCase().slice(0, 100)));
  const holdoutInTrain = trainingRecords.filter(r => holdoutPrompts.has(r.prompt.trim().toLowerCase().slice(0, 100)));
  checks.push({
    type: 'holdout-in-train',
    detected: holdoutInTrain.length > 0,
    details: holdoutInTrain.map(r => `training record ${r.id} matches holdout prompt`),
  });
  // 2. self-eval: check if evaluator score correlates suspiciously with self-report
  const selfEval = trainingRecords.filter(r => r.outcome === 'ok' && r.turns <= 1 && r.tokens < 50);
  checks.push({
    type: 'self-eval',
    detected: selfEval.length > 0 && trainingRecords.length > 0 && selfEval.length / trainingRecords.length > 0.8,
    details: selfEval.length > 0 && selfEval.length / trainingRecords.length > 0.8
      ? [`${selfEval.length}/${trainingRecords.length} records are trivially self-reported (1 turn, <50 tokens)`]
      : [],
  });
  // 3. prompt-duplication within training set
  const promptCounts = new Map<string, number>();
  for (const r of trainingRecords) {
    const key = r.prompt.trim().toLowerCase().slice(0, 100);
    promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1);
  }
  const dupes = [...promptCounts.entries()].filter(([, n]) => n > 5);
  checks.push({
    type: 'prompt-duplication',
    detected: dupes.length > 0,
    details: dupes.map(([k, n]) => `prompt "${k.slice(0, 40)}..." appears ${n} times`),
  });
  // 4. external-in-train
  const externalInTrain = trainingRecords.filter(r => r.isExternal);
  checks.push({
    type: 'external-in-train',
    detected: externalInTrain.length > 0,
    details: externalInTrain.map(r => `external record ${r.id} found in training set`),
  });
  return checks;
}

/**
 * Full decontamination pipeline: run all checks and decide action.
 * Pure - testable.
 */
export function decontaminate(
  record: TrajectoryRecord,
  holdoutPrompts: string[],
): DecontaminationResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const reasons: string[] = [];
  // holdout check
  const promptKey = record.prompt.trim().toLowerCase().slice(0, 100);
  const inHoldout = holdoutPrompts.some(p => p.trim().toLowerCase().slice(0, 100) === promptKey);
  checks.push({ name: 'holdout-overlap', passed: !inHoldout, detail: inHoldout ? 'prompt matches holdout' : 'clear' });
  if (inHoldout) reasons.push('record overlaps with holdout set');
  // quality check
  const qualityOk = record.prompt.trim().length > 0 && record.output.trim().length > 0;
  checks.push({ name: 'quality', passed: qualityOk, detail: qualityOk ? 'non-empty' : 'empty prompt/output' });
  if (!qualityOk) reasons.push('empty prompt or output');
  // outcome check
  const outcomeOk = record.outcome !== 'error';
  checks.push({ name: 'outcome', passed: outcomeOk, detail: `outcome=${record.outcome}` });
  if (!outcomeOk) reasons.push('error outcome');
  // external check
  const externalOk = !record.isExternal;
  checks.push({ name: 'external', passed: externalOk, detail: record.isExternal ? 'is external' : 'internal' });
  if (!externalOk) reasons.push('external record must stay in holdout');
  const action: DecontaminationAction = reasons.length === 0 ? 'pass' : reasons.some(r => r.includes('holdout') || r.includes('external')) ? 'reject' : 'quarantine';
  return { recordId: record.id, action, reasons, checks };
}

/**
 * Generate an RL readiness report.
 * Pure - testable.
 */
export function rlReadinessReport(params: {
  totalTrajectories: number;
  eligibleForTraining: number;
  holdoutSize: number;
  leakageChecks: LeakageCheck[];
}): { ready: boolean; score: number; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (params.eligibleForTraining < 100) blockers.push(`only ${params.eligibleForTraining} eligible trajectories (need >=100)`);
  if (params.holdoutSize < 10) blockers.push(`holdout too small (${params.holdoutSize}, need >=10)`);
  const criticalLeakage = params.leakageChecks.filter(c => c.detected && (c.type === 'holdout-in-train' || c.type === 'external-in-train'));
  if (criticalLeakage.length > 0) blockers.push(`critical leakage detected: ${criticalLeakage.map(c => c.type).join(', ')}`);
  for (const c of params.leakageChecks) {
    if (c.detected && !blockers.some(b => b.includes(c.type))) warnings.push(`${c.type}: ${c.details.join('; ')}`);
  }
  const score = Math.max(0, 100 - blockers.length * 30 - warnings.length * 10);
  return { ready: blockers.length === 0, score, blockers, warnings };
}
