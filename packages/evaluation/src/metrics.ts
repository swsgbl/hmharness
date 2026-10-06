/**
 * @hmharness/evaluation - unified metric protocol (upgrade pack 04, core metrics)
 *
 * The pack's twelve core metrics as ONE report shape with ONE honesty
 * rule: a metric whose input was not provided is undefined - never zero,
 * never fabricated ("no safety violations recorded" and "we did not
 * measure safety violations" are different claims; conflating them is how
 * benchmark reports start lying).
 *
 *   1  successRate            success count / tasks
 *   2  taskCompletionTime     mean completion ms
 *   3  actionEfficiency       effective actions / total actions
 *   4  recoveryRate           recovered failures / failures
 *   5  predictionCalibration  brier (lower better; ece reported alongside when given)
 *   6  worldModelDeltaAccuracy  given directly (WM 2.0 deltaAccuracy.accuracy)
 *   7  cost                   total cost in USD
 *   8  latency                p50/p95/max of per-action latency ms
 *   9  humanInterventionRate  interventions / tasks
 *  10  regressionRate         (baseline - current) / baseline when baseline > 0
 *  11  transferGain           withTransfer - baseline (target env ONLY -
 *                              the pack forbids reporting source-env numbers as transfer)
 *  12  safetyViolationRate    violations / tasks
 */
export interface RunMetricInput {
  tasks?: number;
  successes?: number;
  completionsMs?: number[];
  actions?: number;
  effectiveActions?: number;
  failures?: number;
  recoveredFailures?: number;
  brier?: number;
  ece?: number;
  deltaAccuracy?: number;
  costUsd?: number;
  actionLatenciesMs?: number[];
  humanInterventions?: number;
  /** baseline = the pre-change success count on the SAME task set */
  regressionBaselineSuccesses?: number;
  currentSuccesses?: number;
  /** BOTH fields are target-environment numbers (never source-env) */
  transferWithKnowledge?: number;
  transferBaseline?: number;
  safetyViolations?: number;
}

export interface MetricReport {
  successRate?: number;
  taskCompletionTimeMs?: number;
  actionEfficiency?: number;
  recoveryRate?: number;
  predictionCalibration?: { brier: number; ece?: number };
  worldModelDeltaAccuracy?: number;
  costUsd?: number;
  latency?: { p50Ms: number; p95Ms: number; maxMs: number };
  humanInterventionRate?: number;
  regressionRate?: number;
  transferGain?: number;
  safetyViolationRate?: number;
  /** which metrics were absent (undefined by honesty, not by accident) */
  unmeasured: string[];
}

const pct = (num: number, den: number): number | undefined =>
  den > 0 ? Number((num / den).toFixed(3)) : undefined;

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

export function computeMetrics(input: RunMetricInput): MetricReport {
  const report: MetricReport = { unmeasured: [] };
  if (input.tasks !== undefined && input.tasks > 0) {
    if (input.successes !== undefined) report.successRate = pct(input.successes, input.tasks);
    if (input.humanInterventions !== undefined) report.humanInterventionRate = pct(input.humanInterventions, input.tasks);
    if (input.safetyViolations !== undefined) report.safetyViolationRate = pct(input.safetyViolations, input.tasks);
  }
  if (input.completionsMs?.length) {
    report.taskCompletionTimeMs = Number((input.completionsMs.reduce((s, x) => s + x, 0) / input.completionsMs.length).toFixed(0));
  }
  if (input.actions !== undefined && input.actions > 0 && input.effectiveActions !== undefined) {
    report.actionEfficiency = pct(input.effectiveActions, input.actions);
  }
  if (input.failures !== undefined && input.failures > 0 && input.recoveredFailures !== undefined) {
    report.recoveryRate = pct(input.recoveredFailures, input.failures);
  }
  if (input.brier !== undefined) {
    report.predictionCalibration = { brier: input.brier, ...(input.ece !== undefined ? { ece: input.ece } : {}) };
  }
  if (input.deltaAccuracy !== undefined) report.worldModelDeltaAccuracy = input.deltaAccuracy;
  if (input.costUsd !== undefined) report.costUsd = Number(input.costUsd.toFixed(4));
  if (input.actionLatenciesMs?.length) {
    const sorted = [...input.actionLatenciesMs].sort((a, b) => a - b);
    report.latency = {
      p50Ms: quantile(sorted, 0.5),
      p95Ms: quantile(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
    };
  }
  if (input.regressionBaselineSuccesses !== undefined && input.currentSuccesses !== undefined) {
    const base = input.regressionBaselineSuccesses;
    // regression = the share of previously-passing outcomes lost; a baseline
    // of 0 leaves it honestly undefined (division would fabricate infinity)
    if (base > 0) report.regressionRate = Number(((base - input.currentSuccesses) / base).toFixed(3));
  }
  if (input.transferWithKnowledge !== undefined && input.transferBaseline !== undefined) {
    report.transferGain = Number((input.transferWithKnowledge - input.transferBaseline).toFixed(3));
  }
  const provided = new Set(Object.keys(report));
  const all: Array<[keyof MetricReport, string]> = [
    ['successRate', 'successRate'],
    ['taskCompletionTimeMs', 'taskCompletionTime'],
    ['actionEfficiency', 'actionEfficiency'],
    ['recoveryRate', 'recoveryRate'],
    ['predictionCalibration', 'predictionCalibration'],
    ['worldModelDeltaAccuracy', 'worldModelDeltaAccuracy'],
    ['costUsd', 'cost'],
    ['latency', 'latency'],
    ['humanInterventionRate', 'humanInterventionRate'],
    ['regressionRate', 'regressionRate'],
    ['transferGain', 'transferGain'],
    ['safetyViolationRate', 'safetyViolationRate'],
  ];
  for (const [field, label] of all) if (!provided.has(field)) report.unmeasured.push(label);
  return report;
}
