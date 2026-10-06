/**
 * @hmharness/cognitive - Learning Target Registry (upgrade pack stage C / §11)
 *
 * The pack's Learning OS ask: every learning target (memory / skill /
 * workflow / tool / router / world_model / prompt / adapter / model) must
 * carry a SIX-PART contract - trainer, evaluator, holdout, promotionPolicy,
 * rollback, lineage. This registry makes the contract machine-checked: a
 * registration missing any part is refused WITH THE FIELD NAME (the
 * checklist-that-cannot-rot pattern; the ORDER trap guard is precedent).
 *
 * runCycle() orchestrates the doc's pipeline:
 *   trainer -> (policy.requireHoldout ? holdout evaluation : -)
 *           -> evidence bar = max(policy.minEvidence, evidenceThreshold(target))
 *           -> promote | reject
 *           -> Cognitive Ledger mirroring for the kinds the vocabulary has
 *
 * Ledger mapping honesty: only kinds that exist in the vocabulary are
 * emitted (skill.candidate/promoted/rejected, memory.promoted); targets
 * without a vocabulary kind (workflow/router/...) run the same pipeline
 * but mirror nothing - stated, not silently faked.
 *
 * The evidence bar composes with continual.ts's evidenceThreshold: the
 * model target's 0.95 bar is STRICTLY higher than memory's 0.6 - weight
 * changes stay last, not first (the control plane's founding rule).
 */
import type { Candidate, EvalResult, LearningDataset, LearningPlan, LearningTarget } from './continual.ts';
import { evidenceThreshold } from './continual.ts';
import type { CognitiveLedger, LedgerEventKind } from './ledger.ts';
import type { CognitiveTrajectory } from './protocol.ts';
import { mineWorkflows, type WorkflowCandidate } from './skill-compiler.ts';

export type TargetTrainer = (plan: LearningPlan, dataset: LearningDataset) => Promise<Candidate>;
export type TargetEvaluator = (candidate: Candidate, holdout: LearningDataset) => Promise<EvalResult>;
export type TargetRollback = (candidate: Candidate) => Promise<void>;

export interface PromotionPolicy {
  /** minimum evidence metric before promotion is even considered */
  minEvidence: number;
  /** when true, the holdout set is drawn and the evaluator must pass */
  requireHoldout: boolean;
  /** share of sessions the candidate serves during canary, in (0, 1] */
  canaryShare: number;
}

export interface TargetLineage {
  registeredAt: string;
  version: number;
  source: string;
}

export interface TargetRegistration {
  target: LearningTarget;
  trainer: TargetTrainer;
  evaluator: TargetEvaluator;
  holdout: () => Promise<LearningDataset>;
  promotionPolicy: PromotionPolicy;
  rollback: TargetRollback;
  lineage: TargetLineage;
}

export interface CycleOutcome {
  candidate: Candidate;
  evalResult?: EvalResult;
  decision: 'promote' | 'reject';
  bar: number;
  reason: string;
}

const REQUIRED_FIELDS = ['trainer', 'evaluator', 'holdout', 'promotionPolicy', 'rollback', 'lineage'] as const;

/** Only vocabulary kinds are mirrored - see the module doc. */
const LEDGER_MAP: Partial<Record<LearningTarget, { candidate?: LedgerEventKind; promoted?: LedgerEventKind; rejected?: LedgerEventKind }>> = {
  skill: { candidate: 'skill.candidate', promoted: 'skill.promoted', rejected: 'skill.rejected' },
  memory: { promoted: 'memory.promoted' },
};

export const KNOWN_TARGETS: readonly LearningTarget[] = ['memory', 'skill', 'workflow', 'tool', 'router', 'world_model', 'prompt', 'adapter', 'model'];

export class LearningTargetRegistry {
  private readonly byTarget = new Map<LearningTarget, TargetRegistration>();
  /** when set, cycle outcomes mirror into the Cognitive Ledger */
  ledger?: CognitiveLedger;

  register(reg: TargetRegistration): void {
    for (const f of REQUIRED_FIELDS) {
      if ((reg as unknown as Record<string, unknown>)[f] === undefined) {
        throw new Error(`learning target ${reg.target}: registration missing '${f}' - the six-part contract (trainer/evaluator/holdout/promotionPolicy/rollback/lineage) is non-negotiable`);
      }
    }
    const { canaryShare } = reg.promotionPolicy;
    if (!(canaryShare > 0 && canaryShare <= 1)) {
      throw new Error(`learning target ${reg.target}: canaryShare must be in (0, 1], got ${canaryShare}`);
    }
    if (this.byTarget.has(reg.target)) {
      throw new Error(`learning target ${reg.target}: already registered - replace deliberately, never shadow`);
    }
    this.byTarget.set(reg.target, reg);
  }

  get(target: LearningTarget): TargetRegistration | undefined {
    return this.byTarget.get(target);
  }

  list(): LearningTarget[] {
    return [...this.byTarget.keys()];
  }

  /** The honest gap report: what the pack demands vs what is wired. */
  coverage(): { known: number; registered: number; missing: LearningTarget[] } {
    return {
      known: KNOWN_TARGETS.length,
      registered: this.byTarget.size,
      missing: KNOWN_TARGETS.filter((t) => !this.byTarget.has(t)),
    };
  }

  /** The full pipeline for one learning plan against one registered target. */
  async runCycle(plan: LearningPlan, train: LearningDataset): Promise<CycleOutcome> {
    const reg = this.byTarget.get(plan.target);
    if (!reg) throw new Error(`learning target ${plan.target} is not registered - register the six-part contract first`);
    const bar = Math.max(reg.promotionPolicy.minEvidence, evidenceThreshold(reg.target));
    let candidate = await reg.trainer(plan, train);
    candidate = { ...candidate, status: 'trained' };
    this.emit(reg.target, 'candidate', candidate.id, `${plan.target} candidate from opportunity ${plan.opportunityId}`);

    let evalResult: EvalResult | undefined;
    if (reg.promotionPolicy.requireHoldout) {
      const hold = await reg.holdout();
      evalResult = await reg.evaluator(candidate, hold);
      candidate = { ...candidate, status: 'evaluated', evalResult };
    }
    const evidence = evalResult?.metrics.evidence ?? 0;
    const holdoutPassed = !reg.promotionPolicy.requireHoldout || (evalResult?.pass ?? false);
    const decision: 'promote' | 'reject' = holdoutPassed && evidence >= bar ? 'promote' : 'reject';
    const reason = !holdoutPassed
      ? `holdout evaluation failed (pass=${evalResult?.pass})`
      : decision === 'promote'
        ? `evidence ${evidence} >= bar ${bar}`
        : `evidence ${evidence} below bar ${bar}`;
    candidate = { ...candidate, status: decision === 'promote' ? 'promoted' : 'rejected' };
    this.emit(reg.target, decision, candidate.id, reason);
    return { candidate, evalResult, decision, bar, reason };
  }

  private emit(target: LearningTarget, stage: 'candidate' | 'promote' | 'reject', subject: string, detail: string): void {
    const map = LEDGER_MAP[target];
    const kind = map ? (stage === 'candidate' ? map.candidate : stage === 'promote' ? map.promoted : map.rejected) : undefined;
    if (!kind || !this.ledger) return; // no vocabulary kind for this target - mirror nothing, honestly
    try {
      this.ledger.append(kind, subject, { detail });
    } catch { /* the ledger must never break the cycle it observes */ }
  }
}

/* -------- the first REAL target: skill (upgrade pack stage C acceptance) --------
 *
 * The registry existed with fake-capable contracts; this factory registers
 * the 'skill' target with the REAL trainer the codebase already owns:
 * skill-compiler's mineWorkflows (maximal supported action n-grams over
 * successful trajectories). The evaluator replays the top mined workflow
 * against a CALLER-PROVIDED holdout (disjointness is the caller's
 * discipline, same as EVAL-IND's split): evidence = the share of holdout
 * successes whose step sequence contains the workflow contiguously.
 * Small-N honesty: fewer than 2 holdout successes fails the evaluation -
 * a holdout too thin to check is a rejection, not a pass.
 */
export interface SkillCandidate extends Candidate {
  workflows: WorkflowCandidate[];
}

function containsGram(seq: string[], gram: string[]): boolean {
  outer: for (let i = 0; i + gram.length <= seq.length; i++) {
    for (let j = 0; j < gram.length; j++) if (seq[i + j] !== gram[j]) continue outer;
    return true;
  }
  return false;
}

function successSequence(t: CognitiveTrajectory): string[] {
  return t.steps.filter((s) => s.outcome === 'success').map((s) => s.action.type);
}

export function registerSkillTarget(
  registry: LearningTargetRegistry,
  opts: {
    /** disjoint-from-train holdout source - the caller owns the split */
    holdout: () => Promise<LearningDataset>;
    mining?: { minSupport?: number; nMin?: number; nMax?: number };
    policy?: Partial<PromotionPolicy>;
    lineageSource?: string;
  },
): void {
  registry.register({
    target: 'skill',
    trainer: async (plan, dataset): Promise<SkillCandidate> => ({
      id: `skill-${plan.opportunityId}-${Math.random().toString(36).slice(2, 8)}`,
      plan,
      createdAt: new Date().toISOString(),
      status: 'draft',
      workflows: mineWorkflows(dataset.trajectories, opts.mining ?? {}),
    }),
    evaluator: async (candidate, holdout): Promise<EvalResult> => {
      const top = (candidate as SkillCandidate).workflows[0];
      const holdoutSuccesses = holdout.trajectories.filter((t) => t.metrics.success);
      if (!top) {
        return { candidateId: candidate.id, pass: false, metrics: { evidence: 0, holdoutSuccesses: holdoutSuccesses.length }, holdoutSize: holdout.trajectories.length };
      }
      const containing = holdoutSuccesses.filter((t) => containsGram(successSequence(t), top.steps)).length;
      const evidence = holdoutSuccesses.length > 0 ? Number((containing / holdoutSuccesses.length).toFixed(3)) : 0;
      const pass = holdoutSuccesses.length >= 2 && evidence >= 0.5;
      return {
        candidateId: candidate.id,
        pass,
        metrics: { evidence, holdoutSuccesses: holdoutSuccesses.length, workflowSupport: top.support },
        holdoutSize: holdout.trajectories.length,
      };
    },
    holdout: opts.holdout,
    promotionPolicy: { minEvidence: 0.5, requireHoldout: true, canaryShare: 0.2, ...opts.policy },
    rollback: async () => undefined, // skill rollback is host-side promotion bookkeeping; v0 records intent via the ledger chain
    lineage: { registeredAt: new Date().toISOString(), version: 1, source: opts.lineageSource ?? 'skill-compiler.mineWorkflows' },
  });
}
