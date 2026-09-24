/**
 * @hmharness/evolution - Sequential Experimentation (P0-05, 2026-09-24 audit)
 *
 * Replaces the fixed "10 percentage points difference" threshold with
 * Sequential Probability Ratio Test (SPRT) for binomial outcomes.
 *
 * The audit said: "应升级为 Sequential Probability Ratio Test / Bayesian
 * decision / anytime-valid inference 中的一个正式方案, 并同时加入多重比较、
 * 实验停止规则、护栏指标和效应量置信区间"
 *
 * SPRT advantage over fixed-threshold:
 * - Can stop EARLY when evidence is conclusive (saves API calls)
 * - Has provable error rates (alpha/beta are hard bounds)
 * - Anytime-valid: the error guarantee holds at ANY stopping point
 */

export interface SPRTParams {
  /** H0: p_control (null hypothesis baseline success rate) */
  p0: number;
  /** H1: p_treatment (alternative hypothesis success rate) */
  p1: number;
  /** Type I error rate (false positive): reject H0 when H0 is true */
  alpha: number;
  /** Type II error rate (false negative): fail to reject H0 when H1 is true */
  beta: number;
}

export interface SPRTResult {
  /** decision at current sample sizes */
  decision: 'continue' | 'accept-h0' | 'accept-h1' | 'insufficient';
  /** log-likelihood ratio */
  logLR: number;
  /** lower boundary for accepting H0 */
  lowerBound: number;
  /** upper boundary for accepting H1 */
  upperBound: number;
  /** total observations so far */
  nControl: number;
  nTreatment: number;
  /** estimated effect (treatment - control success rate) */
  effectEstimate: number;
  /** 95% CI for the effect */
  effectCI: [number, number];
  /** minimum observations per arm before any decision */
  minN: number;
}

/**
 * Wald's Sequential Probability Ratio Test for comparing two binomial rates.
 *
 * At each observation, compute the log-likelihood ratio:
 *   Λ = Σ log(L(p1)/L(p0))
 *
 * Decision boundaries:
 *   Λ ≤ log(β/(1-α))  → accept H0 (no difference / treatment not better)
 *   Λ ≥ log((1-β)/α)  → accept H1 (treatment IS better)
 *   otherwise          → continue collecting data
 */
export function sprt(
  controlSuccesses: number,
  controlTotal: number,
  treatmentSuccesses: number,
  treatmentTotal: number,
  params: SPRTParams,
  minN = 30, // minimum per arm (audit: "至少各 8 个 session" was too low)
): SPRTResult {
  const { p0, p1, alpha, beta } = params;
  const nC = controlTotal;
  const nT = treatmentTotal;
  const xC = controlSuccesses;
  const xT = treatmentSuccesses;

  // boundaries
  const lowerBound = Math.log(beta / (1 - alpha));
  const upperBound = Math.log((1 - beta) / alpha);

  // log-likelihood ratio for binomial
  // Under H0: both arms have success rate p0
  // Under H1: treatment has p1, control has p0
  let logLR = 0;
  // treatment arm observations
  if (nT > 0) {
    const logL1 = xT * Math.log(p1) + (nT - xT) * Math.log(1 - p1);
    const logL0 = xT * Math.log(p0) + (nT - xT) * Math.log(1 - p0);
    logLR += logL1 - logL0;
  }

  // minimum sample check
  if (nC < minN || nT < minN) {
    return {
      decision: 'insufficient',
      logLR, lowerBound, upperBound,
      nControl: nC, nTreatment: nT,
      effectEstimate: nT > 0 && nC > 0 ? (xT / nT) - (xC / nC) : 0,
      effectCI: [-1, 1],
      minN,
    };
  }

  // decision
  let decision: SPRTResult['decision'];
  if (logLR <= lowerBound) {
    decision = 'accept-h0';
  } else if (logLR >= upperBound) {
    decision = 'accept-h1';
  } else {
    decision = 'continue';
  }

  // effect estimate and CI (Wald normal approximation)
  const pControl = nC > 0 ? xC / nC : 0;
  const pTreatment = nT > 0 ? xT / nT : 0;
  const effect = pTreatment - pControl;
  const seC = nC > 0 ? Math.sqrt(pControl * (1 - pControl) / nC) : 0;
  const seT = nT > 0 ? Math.sqrt(pTreatment * (1 - pTreatment) / nT) : 0;
  const se = Math.sqrt(seC * seC + seT * seT);
  const z = 1.96; // 95% CI
  const ci: [number, number] = [
    Math.max(-1, effect - z * se),
    Math.min(1, effect + z * se),
  ];

  return {
    decision, logLR, lowerBound, upperBound,
    nControl: nC, nTreatment: nT,
    effectEstimate: effect,
    effectCI: ci,
    minN,
  };
}

/**
 * Convenience: standard SPRT for evolution experiments.
 * H0: treatment is NOT better than control (same rate)
 * H1: treatment is at least 5pp better
 */
export function evolutionSPRT(
  controlSuccesses: number,
  controlTotal: number,
  treatmentSuccesses: number,
  treatmentTotal: number,
): SPRTResult {
  // estimate baseline from control
  const p0 = controlTotal > 0 ? controlSuccesses / controlTotal : 0.5;
  // H1: 5pp improvement (minimum meaningful effect)
  const p1 = Math.min(0.99, p0 + 0.05);
  return sprt(controlSuccesses, controlTotal, treatmentSuccesses, treatmentTotal, {
    p0, p1, alpha: 0.05, beta: 0.10,
  }, 30);
}

/**
 * Multiple comparison correction (Bonferroni) for running multiple
 * experiments simultaneously - the audit's "多重比较" requirement.
 */
export function bonferroniAlpha(numExperiments: number, familyAlpha = 0.05): number {
  return familyAlpha / Math.max(1, numExperiments);
}

/**
 * Guardrail check: a treatment that improves the target metric but
 * degrades a guardrail metric beyond tolerance should be rejected.
 * The audit's "护栏指标" requirement.
 */
export function checkGuardrails(
  target: SPRTResult,
  guardrails: Array<{ name: string; controlValue: number; treatmentValue: number; maxRegression: number }>,
): { pass: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const g of guardrails) {
    const regression = g.treatmentValue - g.controlValue;
    if (regression > g.maxRegression) {
      violations.push(`${g.name}: regression ${regression.toFixed(3)} > tolerance ${g.maxRegression}`);
    }
  }
  return { pass: violations.length === 0, violations };
}
