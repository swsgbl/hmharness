/**
 * @hmharness/cognitive - goal system (blueprint §4 / GOAL-001..010)
 *
 * Goals form a graph (parent/sub), each with executable success criteria.
 * Safety rules from the blueprint, enforced structurally:
 *  - source "intrinsic" goals are ALWAYS proposals: adopt() refuses them
 *    unless approved=true (GOAL-008 gate lives here, not in a caller's good
 *    intentions)
 *  - goals declaring real-world side effects (sideEffects=true) require the
 *    same explicit approval
 *  - detectDrift compares the trajectory's outcomes against the goal's
 *    success criteria and returns a report the supervisor can pause on
 */
import type { Transition } from './world-model.ts';
import type { Action } from './protocol.ts';

export interface Constraint {
  kind: 'time' | 'budget' | 'capability' | 'safety';
  expression: string;
}

/** GOAL-004 hooks: executable checks, injected by the host (CLI/web/agent).
 *  Returning false = criterion not (yet) met; throwing = check itself
 *  failed and counts as unknown, never as pass. */
export type CriterionCheck = (goal: Goal, context: GoalContext) => boolean | Promise<boolean>;

export interface SuccessCriterion {
  id: string;
  description: string;
  /** structural predicate over the final world state / last observation */
  check?: string;
}

export interface Goal {
  id: string;
  description: string;
  source: 'user' | 'environment' | 'intrinsic' | 'subagent';
  priority: number;
  constraints: Constraint[];
  successCriteria: SuccessCriterion[];
  deadline?: string;
  parentGoalId?: string;
  /** declared real-world side effects (deploys, sends, deletions) */
  sideEffects?: string[];
  /** lifecycle */
  status: 'proposed' | 'active' | 'achieved' | 'abandoned' | 'blocked';
  createdAt: string;
}

export interface GoalContext {
  sessionId: string;
  workspaceDir?: string;
  /** host-provided criterion evaluators keyed by criterion check string */
  evaluators?: Record<string, CriterionCheck>;
  budgetMs?: number;
  elapsedMs?: number;
  actionsTaken?: number;
}

export interface GoalDriftReport {
  goalId: string;
  driftScore: number;
  signals: string[];
  recommendation: 'continue' | 'pause' | 'request-confirmation' | 'abandon';
}

export class GoalManager {
  private goals = new Map<string, Goal>();

  list(): Goal[] {
    return [...this.goals.values()];
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  /** GOAL-007. Intrinsic goals enter as proposals only. */
  propose(goal: Omit<Goal, 'status' | 'createdAt'>): Goal {
    const g: Goal = {
      ...goal,
      status: goal.source === 'intrinsic' ? 'proposed' : 'proposed',
      createdAt: new Date().toISOString(),
    };
    this.goals.set(g.id, g);
    return g;
  }

  /** GOAL-008. The approval gate. High-impact = intrinsic source OR declared
   *  side effects; those cannot be activated without explicit approval. */
  async adopt(goalId: string, opts?: { approved?: boolean }): Promise<void> {
    const g = this.goals.get(goalId);
    if (!g) throw new Error(`unknown goal ${goalId}`);
    const highImpact = g.source === 'intrinsic' || (g.sideEffects ?? []).length > 0;
    if (highImpact && !opts?.approved) {
      throw new Error(`goal ${goalId} is high-impact (source=${g.source}, sideEffects=${(g.sideEffects ?? []).join(',') || 'none'}) and requires explicit approval`);
    }
    g.status = 'active';
  }

  /** GOAL-003. Decomposition is host-injectable: the default splitter is a
   *  deterministic one-criterion-per-subgoal carve; LLM decomposition plugs
   *  in by passing a custom decomposer. Subgoals inherit constraints and
   *  reference the parent. */
  async decompose(
    goalId: string,
    decomposer?: (goal: Goal) => Array<{ description: string; successCriteria: SuccessCriterion[] }>,
  ): Promise<Goal[]> {
    const parent = this.goals.get(goalId);
    if (!parent) throw new Error(`unknown goal ${goalId}`);
    const parts = decomposer
      ? decomposer(parent)
      : parent.successCriteria.map((c, i) => ({ description: `${parent.description} — criterion ${i + 1}: ${c.description}`, successCriteria: [c] }));
    return parts.map((p, i) => {
      const sub: Goal = {
        id: `${parent.id}/sub-${i + 1}`,
        description: p.description,
        source: 'subagent',
        priority: parent.priority,
        constraints: parent.constraints,
        successCriteria: p.successCriteria,
        parentGoalId: parent.id,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      this.goals.set(sub.id, sub);
      return sub;
    });
  }

  /** GOAL-004. Score = priority x progress(criteria) x urgency(deadline). */
  async score(goal: Goal, context: GoalContext): Promise<number> {
    const results = await this.checkCriteria(goal, context);
    const met = results.filter((r) => r.met).length;
    const progress = results.length ? met / results.length : 0;
    let urgency = 1;
    if (goal.deadline) {
      const remainMs = new Date(goal.deadline).getTime() - Date.now();
      urgency = remainMs < 0 ? 0.2 : remainMs < 3_600_000 ? 1.5 : 1;
    }
    const budgetPenalty = context.budgetMs && context.elapsedMs && context.elapsedMs > context.budgetMs ? 0.5 : 1;
    return Number((goal.priority * progress * urgency * budgetPenalty).toFixed(4));
  }

  async checkCriteria(goal: Goal, context: GoalContext): Promise<Array<{ criterion: SuccessCriterion; met: boolean | 'unknown' }>> {
    const out: Array<{ criterion: SuccessCriterion; met: boolean | 'unknown' }> = [];
    for (const c of goal.successCriteria) {
      const fn = c.check ? context.evaluators?.[c.check] : undefined;
      if (!fn) {
        out.push({ criterion: c, met: 'unknown' });
        continue;
      }
      try {
        out.push({ criterion: c, met: await fn(goal, context) });
      } catch {
        out.push({ criterion: c, met: 'unknown' });
      }
    }
    return out;
  }

  /** GOAL-005. Drift = trajectory stops serving the goal's success criteria.
   *  Signals: low criterion coverage of recent actions, budget overrun with
   *  zero met criteria, repeated failures on unrelated action types. */
  detectDrift(goal: Goal, trajectory: Transition[], context: GoalContext): GoalDriftReport {
    const signals: string[] = [];
    const keywords = extractKeywords(goal);
    const recent = trajectory.slice(-20);
    const relevant = recent.filter((t) => mentionsAny(t.action, keywords)).length;
    const coverage = recent.length ? relevant / recent.length : 1;
    // nearly-zero goal coverage is a STRONG signal on its own
    const offCourse = recent.length >= 5 && coverage < 0.15;
    if (recent.length >= 5 && coverage < 0.3) signals.push(`only ${Math.round(coverage * 100)}% of recent actions reference goal keywords`);
    const failures = recent.filter((t) => t.outcome === 'failure').length;
    if (recent.length >= 5 && failures / recent.length > 0.7) signals.push(`${failures}/${recent.length} recent transitions failed`);
    if (context.budgetMs && (context.elapsedMs ?? 0) > context.budgetMs) signals.push('budget exceeded');
    const driftScore = Number(Math.min(1, signals.length * 0.35 + (1 - coverage) * 0.3).toFixed(3));
    let recommendation: GoalDriftReport['recommendation'] = 'continue';
    if (signals.length >= 2 || driftScore >= 0.7 || offCourse) recommendation = goal.source === 'user' ? 'request-confirmation' : 'pause';
    return { goalId: goal.id, driftScore, signals, recommendation };
  }

  /** GOAL-002. The graph view: parent -> children edges with statuses. */
  graph(): { nodes: Goal[]; edges: Array<{ from: string; to: string }> } {
    const nodes = [...this.goals.values()];
    const edges = nodes.filter((n) => n.parentGoalId).map((n) => ({ from: n.parentGoalId!, to: n.id }));
    return { nodes, edges };
  }

  mark(goalId: string, status: Goal['status']): void {
    const g = this.goals.get(goalId);
    if (g) g.status = status;
  }
}

function extractKeywords(goal: Goal): string[] {
  return goal.description
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 3);
}

function mentionsAny(action: Action, keywords: string[]): boolean {
  const hay = `${action.type} ${action.reason ?? ''} ${Object.keys(action.args).join(' ')}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}
