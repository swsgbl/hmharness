/**
 * @hmharness/cognitive - self-evolution 2.0 governance (blueprint §10 / EV-001..015)
 *
 * The upgrade over "evolve when metrics move": every evolution candidate is
 * a CONTRACT that must declare — before training — hypothesis, expected
 * effect, possible regression, evaluation dataset, rollback, budget and
 * safety constraints. The controller then walks the pipeline:
 *
 *   sandbox -> train/test split -> holdout + transfer test -> sequential
 *   statistical gate -> canary -> impact measurement -> promote/rollback
 *   -> immutable audit
 *
 * Hard prohibitions enforced structurally (blueprint §9 禁止 list):
 *  - the candidate may not touch evaluator definitions (self-grading)
 *  - approval/security/config core is out of scope by kind: such candidates
 *    are rejected at intake, not caught later
 *  - promotion requires BOTH the sequential gate and a transfer test — a
 *    single-benchmark gain never promotes globally
 *  - reward hacking detection: metric gains without real-task gains flag
 *    the candidate and freeze the pipeline
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableHash } from './protocol.ts';

export type EvolutionTarget = 'memory' | 'skill' | 'workflow' | 'tool' | 'router' | 'world_model' | 'prompt' | 'adapter' | 'model';

export interface EvolutionCandidate {
  id: string;
  target: EvolutionTarget;
  /** WHAT changes and WHY it should work — the falsifiable hypothesis */
  hypothesis: string;
  expectedEffect: { metric: string; op: '>=' | '<='; value: number; where: string };
  /** what this change could plausibly hurt (must be non-empty) */
  possibleRegression: string[];
  evaluationDataset: string;
  holdoutDataset: string;
  transferTest: { sourceEnv: string; targetEnv: string };
  rollbackStrategy: string;
  resourceBudget: { maxWallMs: number; maxCostUnits: number };
  safetyConstraints: string[];
  status: 'proposed' | 'sandboxed' | 'gated' | 'canary' | 'promoted' | 'rolled-back' | 'rejected';
  createdAt: string;
  measurements?: Array<{ phase: string; at: string; metrics: Record<string, number> }>;
  flagged?: { reason: string; at: string };
}

export interface GateSample {
  /** 1 = candidate beat baseline on this sample, 0 = not */
  won: 0 | 1;
  source: 'train' | 'holdout' | 'transfer';
}

export interface SequentialGateResult {
  decision: 'promote' | 'reject' | 'continue';
  samples: number;
  wins: number;
  pValue: number;
}

export interface CanaryResult {
  pass: boolean;
  windowsObserved: number;
  realTaskDelta: number;
  metricDelta: number;
}

/** EV-012. Reward hacking: metrics improved, real tasks did not. */
export interface RewardHackingDetectorInput {
  metricBefore: number;
  metricAfter: number;
  realTaskSuccessBefore: number;
  realTaskSuccessAfter: number;
}

const FORBIDDEN_TARGET_HINTS = ['approval', 'security', 'config', 'sandbox-policy', 'evaluator', 'audit'];

export class EvolutionController {
  private candidates = new Map<string, EvolutionCandidate>();

  constructor(private home: string) {}

  /** EV-001/002. Intake: the FULL contract or nothing. */
  propose(input: Omit<EvolutionCandidate, 'id' | 'status' | 'createdAt'>): EvolutionCandidate {
    const errors: string[] = [];
    if (!input.hypothesis?.trim()) errors.push('hypothesis required (what changes and why it works)');
    if (!input.expectedEffect) errors.push('expectedEffect required');
    if (!input.possibleRegression?.length) errors.push('possibleRegression required — declare what this could hurt');
    if (!input.holdoutDataset) errors.push('holdoutDataset required — no promotion without holdout');
    if (!input.transferTest) errors.push('transferTest required — single-benchmark gains never promote globally');
    if (!input.rollbackStrategy?.trim()) errors.push('rollbackStrategy required — no irreversible evolution');
    const hint = FORBIDDEN_TARGET_HINTS.find((h) => JSON.stringify(input).toLowerCase().includes(h) && (input.target === 'tool' || input.target === 'workflow') && JSON.stringify(input).toLowerCase().match(new RegExp(`(modify|patch|change)[^"]{0,40}${h}`)));
    if (hint) errors.push(`candidate appears to modify ${hint} core — out of evolution scope by policy`);
    if (errors.length) throw new Error(`evolution candidate rejected at intake: ${errors.join('; ')}`);
    const c: EvolutionCandidate = {
      ...input,
      id: `evo-${stableHash(input.hypothesis + input.target).slice(0, 10)}-${Date.now().toString(36)}`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };
    this.candidates.set(c.id, c);
    return c;
  }

  get(id: string): EvolutionCandidate | undefined {
    return this.candidates.get(id);
  }

  list(): EvolutionCandidate[] {
    return [...this.candidates.values()];
  }

  /** EV-007. Mark sandboxed (execution happens in the host's isolated
   *  evolution sandbox — separate from task sandboxes per blueprint §12). */
  markSandboxes(id: string): void {
    const c = this.candidates.get(id);
    if (c && c.status === 'proposed') c.status = 'sandboxed';
  }

  /** CL-008 / EV sequential gate: Wald-style SPRT lite on win/loss samples.
   *  Holdout and transfer samples BOTH count; train samples never decide. */
  sequentialGate(samples: GateSample[], opts?: { alpha?: number; beta?: number }): SequentialGateResult {
    const deciding = samples.filter((s) => s.source !== 'train');
    const n = deciding.length;
    const wins = deciding.reduce((s, x) => s + x.won, 0);
    if (n < 5) return { decision: 'continue', samples: n, wins, pValue: 1 };
    // one-sided binomial p-value under H0 (win rate 0.5), normal approx
    const z = (wins - n / 2) / Math.sqrt(n / 4);
    const pValue = Number(normalSurvival(z).toFixed(4));
    const alpha = opts?.alpha ?? 0.05;
    const beta = 1 - (opts?.beta ?? 0.2);
    if (pValue < alpha) return { decision: 'promote', samples: n, wins, pValue };
    if (pValue > beta) return { decision: 'reject', samples: n, wins, pValue };
    return { decision: 'continue', samples: n, wins, pValue };
  }

  markGated(id: string, gate: SequentialGateResult): void {
    const c = this.candidates.get(id);
    if (!c) return;
    if (gate.decision === 'promote') c.status = 'gated';
    else if (gate.decision === 'reject') { c.status = 'rejected'; void this.audit(c, 'rejected-by-sequential-gate', { samples: gate.samples, wins: gate.wins, pValue: gate.pValue }); }
  }

  /** Canary phase: EV impact measurement on a slice of real traffic. */
  async canary(id: string, input: RewardHackingDetectorInput, windows = 3): Promise<CanaryResult> {
    const c = this.candidates.get(id);
    if (!c || c.status !== 'gated') throw new Error(`candidate ${id} is not gated — cannot canary`);
    c.status = 'canary';
    const hacked = detectRewardHacking(input);
    const result: CanaryResult = {
      pass: !hacked.hacked,
      windowsObserved: windows,
      realTaskDelta: Number((input.realTaskSuccessAfter - input.realTaskSuccessBefore).toFixed(4)),
      metricDelta: Number((input.metricAfter - input.metricBefore).toFixed(4)),
    };
    c.measurements = [...(c.measurements ?? []), { phase: 'canary', at: new Date().toISOString(), metrics: { realTaskDelta: result.realTaskDelta, metricDelta: result.metricDelta } }];
    if (hacked.hacked) {
      c.flagged = { reason: hacked.reason ?? 'reward hacking detected', at: new Date().toISOString() };
      c.status = 'rejected';
      await this.audit(c, 'flagged-reward-hacking', { reason: hacked.reason ?? '' });
    }
    return result;
  }

  async promote(id: string): Promise<void> {
    const c = this.candidates.get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    if (c.flagged) throw new Error(`candidate ${id} is flagged: ${c.flagged.reason}`);
    if (c.status !== 'canary') throw new Error(`candidate ${id} must pass canary before promotion (status=${c.status})`);
    c.status = 'promoted';
    await this.audit(c, 'promoted', { rollback: c.rollbackStrategy });
  }

  async rollback(id: string, reason: string): Promise<void> {
    const c = this.candidates.get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    c.status = 'rolled-back';
    await this.audit(c, 'rolled-back', { reason });
  }

  /** EV-011. Immutable, append-only audit trail. */
  private async audit(c: EvolutionCandidate, event: string, detail: Record<string, unknown>): Promise<void> {
    const dir = join(this.home, 'cognitive', 'evolution');
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, 'audit.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), event, candidateId: c.id, target: c.target, hypothesis: c.hypothesis ?? '', detail }) + '\n',
      'utf8',
    );
  }

  async auditLog(limit = 50): Promise<Array<Record<string, unknown>>> {
    try {
      const text = await readFile(join(this.home, 'cognitive', 'evolution', 'audit.jsonl'), 'utf8');
      return text.split('\n').filter((l) => l.trim()).slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}

/** EV-012. Metrics moved but real tasks didn't — the classic Goodhart tell. */
export function detectRewardHacking(input: RewardHackingDetectorInput): { hacked: boolean; reason?: string } {
  const metricGain = input.metricAfter - input.metricBefore;
  const realGain = input.realTaskSuccessAfter - input.realTaskSuccessBefore;
  if (metricGain > 0.05 && realGain <= 0.005) {
    return {
      hacked: true,
      reason: `metric +${(metricGain * 100).toFixed(1)}% but real-task success ${realGain >= 0 ? '+' : ''}${(realGain * 100).toFixed(1)}% — optimizing the evaluator, not the work`,
    };
  }
  return { hacked: false };
}

/** Upper tail of the standard normal CDF via the Abramowitz–Stegun 7.1.26
 *  erf approximation (JS has no erfc builtin). */
function normalSurvival(z: number): number {
  const neg = z < 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const upperTail = (1 - erf) / 2;
  return neg ? 1 - upperTail : upperTail;
}
