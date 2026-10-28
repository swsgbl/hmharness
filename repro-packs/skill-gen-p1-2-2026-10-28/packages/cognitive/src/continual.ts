/**
 * @hmharness/cognitive - continual learning control plane (blueprint §9 / CL-001..010)
 *
 * Decides WHAT to learn from a trajectory dataset — and at which layer.
 * The learning-target taxonomy is the control plane's core:
 *   memory | skill | workflow | tool | router | world_model | prompt | adapter | model
 * Discipline from the blueprint:
 *  - default harness-level first (memory/skill/workflow/router): cheap,
 *    reversible, fast to validate
 *  - adapter/model updates face a STRICTLY higher evidence bar
 *    (evidenceThreshold('model') > everything else) — weight changes are
 *    last, not first
 *  - diagnosis is deterministic-statistical here (failure clustering,
 *    calibration gaps, repeated patterns); LLM diagnosis plugs in as an
 *    injected diagnoser without changing the contract
 */
import type { CognitiveTrajectory } from './protocol.ts';

export type LearningTarget = 'memory' | 'skill' | 'workflow' | 'tool' | 'router' | 'world_model' | 'prompt' | 'adapter' | 'model';

export interface LearningDataset {
  trajectories: CognitiveTrajectory[];
}

export interface LearningOpportunity {
  id: string;
  signal: string;
  evidence: { trajectories: string[]; metric: string; value: number };
  suggestedTargets: LearningTarget[];
}

export interface LearningPlan {
  opportunityId: string;
  target: LearningTarget;
  /** host-interpretable payload: what to write/patch/train */
  payload: Record<string, unknown>;
  expectedEffect: string;
  rollbackStrategy: string;
}

export interface Candidate {
  id: string;
  plan: LearningPlan;
  createdAt: string;
  status: 'draft' | 'trained' | 'evaluated' | 'promoted' | 'rejected';
  evalResult?: EvalResult;
}

export interface EvalResult {
  candidateId: string;
  pass: boolean;
  metrics: Record<string, number>;
  holdoutSize: number;
}

export interface HostTrainer {
  /** applies a harness-level plan (write memory, patch workflow, reroute…) */
  trainHarness(plan: LearningPlan): Promise<{ payload: Record<string, unknown> }>;
  /** trains an adapter/model — only invoked when evidence threshold met */
  trainModel?(plan: LearningPlan): Promise<{ payload: Record<string, unknown> }>;
}

export interface HostEvaluator {
  evaluate(candidate: Candidate, holdout: LearningDataset): Promise<EvalResult>;
}

/** Evidence bar per target — the blueprint's "model update gate". */
export function evidenceThreshold(target: LearningTarget): number {
  switch (target) {
    case 'model': return 0.95;
    case 'adapter': return 0.9;
    case 'prompt': return 0.8;
    default: return 0.6; // memory/skill/workflow/tool/router/world_model
  }
}

export class LearningController {
  private store: CognitiveTrajectory[] = [];
  private candidates = new Map<string, Candidate>();

  constructor(
    private trainer?: HostTrainer,
    private evaluator?: HostEvaluator,
  ) {}

  /** CL-001/CL-002. Trajectories land here and only here. */
  async collect(trajectory: CognitiveTrajectory): Promise<void> {
    this.store.push(trajectory);
    if (this.store.length > 5_000) this.store.splice(0, this.store.length - 5_000);
  }

  dataset(): LearningDataset {
    return { trajectories: [...this.store] };
  }

  /** CL-003. Deterministic diagnosis: what kind of learning would pay off? */
  async diagnose(dataset: LearningDataset): Promise<LearningOpportunity[]> {
    const out: LearningOpportunity[] = [];
    const failed = dataset.trajectories.filter((t) => !t.metrics.success);
    if (failed.length >= 2) {
      // repeated failure signatures → remember the pitfall (memory) and try
      // to compile what DID work elsewhere (skill)
      const byEnv = new Map<string, CognitiveTrajectory[]>();
      for (const f of failed) byEnv.set(f.environment.id, [...(byEnv.get(f.environment.id) ?? []), f]);
      for (const [env, list] of byEnv) {
        if (list.length < 2) continue;
        out.push({
          id: `opp-fail-${env}`,
          signal: `${list.length} failed trajectories in ${env}`,
          evidence: { trajectories: list.map((t) => t.id), metric: 'failCount', value: list.length },
          suggestedTargets: ['memory', 'skill'],
        });
      }
    }
    const withPredictions = dataset.trajectories.filter((t) => t.metrics.brierScore !== undefined);
    if (withPredictions.length >= 3) {
      const meanBrier = withPredictions.reduce((s, t) => s + (t.metrics.brierScore ?? 0), 0) / withPredictions.length;
      if (meanBrier > 0.25) {
        out.push({
          id: 'opp-calibration',
          signal: `prediction calibration is poor (mean Brier ${meanBrier.toFixed(3)} > 0.25)`,
          evidence: { trajectories: withPredictions.map((t) => t.id), metric: 'meanBrier', value: Number(meanBrier.toFixed(3)) },
          suggestedTargets: ['world_model'],
        });
      }
    }
    const recoveries = dataset.trajectories.filter((t) => t.metrics.recoveryCount >= 2);
    if (recoveries.length >= 2) {
      out.push({
        id: 'opp-recovery',
        signal: `${recoveries.length} trajectories needed multiple recoveries — workflow doesn't encode the fix`,
        evidence: { trajectories: recoveries.map((t) => t.id), metric: 'recoveryCount', value: recoveries.length },
        suggestedTargets: ['workflow', 'skill'],
      });
    }
    const longOnes = dataset.trajectories.filter((t) => t.metrics.actions > 30 && t.metrics.success);
    if (longOnes.length >= 2) {
      out.push({
        id: 'opp-efficiency',
        signal: `${longOnes.length} successful but long trajectories (${Math.round(longOnes.reduce((s, t) => s + t.metrics.actions, 0) / longOnes.length)} actions avg)`,
        evidence: { trajectories: longOnes.map((t) => t.id), metric: 'avgActions', value: Math.round(longOnes.reduce((s, t) => s + t.metrics.actions, 0) / longOnes.length) },
        suggestedTargets: ['router', 'workflow'],
      });
    }
    return out;
  }

  /** CL-004. Choose the learning target: cheapest reversible layer that
   *  addresses the opportunity, gated by evidence strength. */
  chooseTarget(opportunity: LearningOpportunity): LearningTarget {
    const order: LearningTarget[] = ['memory', 'skill', 'workflow', 'router', 'tool', 'world_model', 'prompt', 'adapter', 'model'];
    const strength = Math.min(1, opportunity.evidence.value / 5);
    for (const t of order) {
      if (!opportunity.suggestedTargets.includes(t)) continue;
      if (strength >= evidenceThreshold(t)) return t;
    }
    // evidence too weak for any suggested target: the cheapest safe default
    return opportunity.suggestedTargets[0] ?? 'memory';
  }

  /** CL-005/006. Train = produce a candidate (host-executed for harness
   *  targets; model targets require the trainer to implement trainModel). */
  async train(plan: LearningPlan): Promise<Candidate> {
    if (!this.trainer) throw new Error('no HostTrainer configured');
    if ((plan.target === 'model' || plan.target === 'adapter') && !this.trainer.trainModel) {
      throw new Error(`target ${plan.target} requires a trainer with trainModel() — refusing to fake it`);
    }
    const produced = plan.target === 'model' || plan.target === 'adapter'
      ? await this.trainer.trainModel!(plan)
      : await this.trainer.trainHarness(plan);
    const candidate: Candidate = {
      id: `cand-${plan.opportunityId}-${plan.target}-${Date.now().toString(36)}`,
      plan: { ...plan, payload: { ...plan.payload, ...produced.payload } },
      createdAt: new Date().toISOString(),
      status: 'trained',
    };
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  /** CL-007. Holdout evaluation through the INDEPENDENT host evaluator. */
  async evaluate(candidate: Candidate, holdout: LearningDataset): Promise<EvalResult> {
    if (!this.evaluator) throw new Error('no HostEvaluator configured');
    const result = await this.evaluator.evaluate(candidate, holdout);
    candidate.evalResult = result;
    candidate.status = 'evaluated';
    return result;
  }

  /** CL promotion gate: evaluator pass + (for model targets) threshold met. */
  async promote(candidateId: string): Promise<void> {
    const c = this.candidates.get(candidateId);
    if (!c) throw new Error(`unknown candidate ${candidateId}`);
    if (!c.evalResult?.pass) throw new Error(`candidate ${candidateId} did not pass holdout evaluation`);
    if ((c.plan.target === 'model' || c.plan.target === 'adapter')) {
      const strength = Math.min(1, (c.evalResult.metrics.holdoutSize ?? 0) / 50);
      if (strength < evidenceThreshold(c.plan.target) - 0.1) {
        throw new Error(`candidate ${candidateId} targets ${c.plan.target} but holdout evidence is below the model-update gate`);
      }
    }
    c.status = 'promoted';
  }

  candidate(id: string): Candidate | undefined {
    return this.candidates.get(id);
  }
}
