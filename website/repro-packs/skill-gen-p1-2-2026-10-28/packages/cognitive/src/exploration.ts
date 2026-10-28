/**
 * @hmharness/cognitive - exploration engine (blueprint §5 / EXP-001..010)
 *
 * NOT random exploration: the policy ranks candidate actions by
 *   score = w_u*uncertaintyReduction + w_i*informationGain
 *         + w_g*goalRelevance - w_r*risk
 * under a hard action/cost budget (EXP-008), and every exploration run is a
 * hypothesis -> experiment -> observation -> belief update loop (EXP-005/006):
 * a HypothesisRegistry tracks claims with expected evidence; outcomes resolve
 * them into world-model belief updates or explicit refutations.
 */
import type { Action, ActionSpec, Observation } from './protocol.ts';
import type { WorldModel } from './world-model.ts';

export interface Hypothesis {
  id: string;
  claim: string;
  /** what observation would support it */
  expectedEvidence: string;
  /** what observation would refute it */
  refutingEvidence: string;
  status: 'open' | 'supported' | 'refuted';
  createdAt: string;
  resolvedAt?: string;
  note?: string;
}

export class HypothesisRegistry {
  private items: Hypothesis[] = [];
  private seq = 0;

  register(h: Omit<Hypothesis, 'id' | 'status' | 'createdAt'>): Hypothesis {
    const full: Hypothesis = { ...h, id: `hyp-${++this.seq}`, status: 'open', createdAt: new Date().toISOString() };
    this.items.push(full);
    return full;
  }

  open(): Hypothesis[] {
    return this.items.filter((h) => h.status === 'open');
  }

  all(): readonly Hypothesis[] {
    return this.items;
  }

  resolve(id: string, status: 'supported' | 'refuted', note?: string): void {
    const h = this.items.find((x) => x.id === id);
    if (h && h.status === 'open') {
      h.status = status;
      h.resolvedAt = new Date().toISOString();
      h.note = note;
    }
  }
}

export interface ExplorationContext {
  observation: Observation;
  worldModel: WorldModel;
  goalKeywords?: string[];
  hypotheses: HypothesisRegistry;
  /** calibration-targeted exploration (§26 finding→product): per-action
   *  1−reliability from the trajectory store; poorly-calibrated actions get
   *  a score BOOST — the model's prediction error IS the information gain */
  calibrationBias?: Record<string, number>;
}

export interface ExplorationOutcome {
  action: Action;
  result: { outcome: string };
  hypothesisId?: string;
}

export interface ExplorationRunOptions {
  maxActions: number;
  maxCost: number;
  riskTolerance: number;
  weights?: Partial<{ uncertainty: number; information: number; goal: number; risk: number }>;
  chooseAction?: (candidates: Array<{ spec: ActionSpec; score: number }>) => ActionSpec | undefined;
}

export interface ExplorationResult {
  actionsTaken: number;
  costSpent: number;
  hypothesesResolved: number;
  unknownActionTypesBefore: number;
  unknownActionTypesAfter: number;
  aborted?: 'budget' | 'no-candidates' | 'risk';
}

export interface ExplorationPolicy {
  selectAction(ctx: ExplorationContext, opts: ExplorationRunOptions): Promise<Action | undefined>;
  informationGain(action: Action, state: { uncertaintyByAction: Record<string, number> }): Promise<number>;
  novelty(state: unknown, seenStates: unknown[]): number;
  risk(action: Action): number;
}

/** EXP-002. Novelty = fraction of unseen structural features vs history. */
export function noveltyScore(state: unknown, seenStates: unknown[]): number {
  if (seenStates.length === 0) return 1;
  const features = stateFeatures(state);
  const seen = new Set<string>();
  for (const s of seenStates) for (const f of stateFeatures(s)) seen.add(f);
  const unseen = [...features].filter((f) => !seen.has(f));
  return features.length ? unseen.length / features.length : 0;
}

function stateFeatures(state: unknown, prefix = ''): string[] {
  if (typeof state !== 'object' || state === null) return [`${prefix}=${String(state)}`];
  if (Array.isArray(state)) {
    const out: string[] = [];
    state.slice(0, 20).forEach((v, i) => out.push(...stateFeatures(v, `${prefix}[${i}]`)));
    return out;
  }
  const out: string[] = [];
  Object.entries(state as Record<string, unknown>).slice(0, 30).forEach(([k, v]) => {
    out.push(...stateFeatures(v, prefix ? `${prefix}.${k}` : k));
  });
  return out;
}

export class UcbExplorationPolicy implements ExplorationPolicy {
  constructor(
    private weights: Required<NonNullable<ExplorationRunOptions['weights']>> = {
      uncertainty: 0.35,
      information: 0.25,
      goal: 0.25,
      risk: 0.15,
    },
    /** calibration weight: 0 = pure UCB, >0 boosts poorly-predicted actions */
    private calibrationWeight = 0.2,
  ) {}

  async informationGain(action: Action, state: { uncertaintyByAction: Record<string, number> }): Promise<number> {
    // actions of an uncertain type carry more information: resolving high
    // uncertainty teaches more than re-confirming a known action
    return state.uncertaintyByAction[action.type] ?? 1;
  }

  novelty(state: unknown, seenStates: unknown[]): number {
    return noveltyScore(state, seenStates);
  }

  risk(action: Action): number {
    // structural risk: irreversible affordances and destructive verbs
    const verbs = ['delete', 'remove', 'drop', 'publish', 'deploy', 'send', 'reset', 'format', 'kill'];
    const hay = `${action.type} ${Object.keys(action.args).join(' ')}`.toLowerCase();
    return verbs.some((v) => hay.includes(v)) ? 0.8 : 0.1;
  }

  async selectAction(ctx: ExplorationContext, opts: ExplorationRunOptions): Promise<Action | undefined> {
    const wm = ctx.worldModel.worldState;
    const seenStates: unknown[] = [];
    const candidates: Array<{ spec: ActionSpec; score: number }> = [];
    for (const spec of ctx.observation.availableActions) {
      const probe: Action = { id: `explore-${spec.id}`, type: spec.type, args: {}, reason: 'exploration probe' };
      const uncertainty = wm.uncertainty.byAction[spec.type] ?? 1;
      const info = await this.informationGain(probe, { uncertaintyByAction: wm.uncertainty.byAction });
      const goalRelevance = this.goalScore(spec, ctx.goalKeywords ?? []);
      const risk = this.risk(probe) + (spec.irreversible ? 0.4 : 0);
      if (risk > opts.riskTolerance) continue; // EXP-007 safe exploration
      // calibration targeting: the model's prediction error on this action
      // type is direct evidence that probing it teaches the world model
      const calBias = ctx.calibrationBias?.[spec.type] ?? 0;
      const score =
        this.weights.uncertainty * uncertainty +
        this.weights.information * info +
        this.weights.goal * goalRelevance +
        this.calibrationWeight * calBias -
        this.weights.risk * risk;
      candidates.push({ spec, score });
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.score - a.score);
    const chosen = opts.chooseAction ? opts.chooseAction(candidates) : candidates[0].spec;
    if (!chosen) return undefined;
    seenStates.push(ctx.observation.state);
    return { id: `explore-${chosen.id}`, type: chosen.type, args: defaultArgs(chosen), reason: `exploration: top-scored affordance (${chosen.id})` };
  }

  private goalScore(spec: ActionSpec, keywords: string[]): number {
    if (keywords.length === 0) return 0.5;
    const hay = `${spec.type} ${spec.description ?? ''} ${spec.id}`.toLowerCase();
    const hits = keywords.filter((k) => hay.includes(k)).length;
    return keywords.length ? hits / keywords.length : 0;
  }
}

/** probe values must be WELL-FORMED for the arg's role: a malformed probe
 *  (url='probe') measures arg synthesis, not the environment — every
 *  resulting failure would be an artifact polluting the calibration curve. */
function probeValue(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('url') || k === 'href') return 'https://example.com';
  if (k.includes('selector')) return 'a';
  if (k.includes('path') || k.includes('file')) return 'probe.txt';
  return 'probe';
}

function defaultArgs(spec: ActionSpec): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const schema = spec.argsSchema ?? {};
  for (const [k, v] of Object.entries(schema)) {
    args[k] = typeof v === 'string' && v.includes('string') ? probeValue(k) : null;
  }
  return args;
}

export class ExplorationEngine {
  private policy: ExplorationPolicy;
  private seenStates: unknown[] = [];
  outcomeLog: ExplorationOutcome[] = [];

  constructor(policy?: ExplorationPolicy) {
    this.policy = policy ?? new UcbExplorationPolicy();
  }

  /** Run the explore loop against an act() callable. The caller owns the
   *  environment; the engine owns budgeting, hypothesis bookkeeping and
   *  novelty tracking. */
  async run(
    opts: ExplorationRunOptions & {
      ctx: ExplorationContext;
      act: (a: Action) => Promise<{ outcome: string }>;
    },
  ): Promise<ExplorationResult> {
    const unknownBefore = opts.ctx.worldModel.worldState.uncertainty.byAction;
    let actions = 0;
    let cost = 0;
    let hypothesesResolved = 0;
    let lastObs: unknown = opts.ctx.observation.state;
    while (actions < opts.maxActions && cost < opts.maxCost) {
      const action = await this.policy.selectAction(opts.ctx, opts);
      if (!action) {
        return { actionsTaken: actions, costSpent: cost, hypothesesResolved, unknownActionTypesBefore: countUnknown(unknownBefore), unknownActionTypesAfter: countUnknown(opts.ctx.worldModel.worldState.uncertainty.byAction), aborted: 'no-candidates' };
      }
      const spec = opts.ctx.observation.availableActions.find((s) => s.type === action.type);
      const stepCost = spec?.cost ?? 1;
      const risk = await Promise.resolve(this.policy.risk(action));
      if (risk > opts.riskTolerance) {
        return { actionsTaken: actions, costSpent: cost, hypothesesResolved, unknownActionTypesBefore: countUnknown(unknownBefore), unknownActionTypesAfter: countUnknown(opts.ctx.worldModel.worldState.uncertainty.byAction), aborted: 'risk' };
      }
      const result = await opts.act(action);
      actions += 1;
      cost += stepCost;
      this.outcomeLog.push({ action, result });
      this.seenStates.push(lastObs);
      // belief update happens through the caller's worldModel.update in the
      // act loop; here we only track novelty of the new state
      lastObs = opts.ctx.observation.state;
      const open = opts.ctx.hypotheses.open();
      for (const h of open.slice(0, 3)) {
        // resolve hypotheses whose expected/refuting evidence matches outcome
        const successLike = result.outcome === 'success';
        if (h.expectedEvidence.includes('succeeds') && successLike) {
          opts.ctx.hypotheses.resolve(h.id, 'supported', `action ${action.type} succeeded`);
          hypothesesResolved += 1;
        } else if (h.refutingEvidence.includes('fails') && !successLike) {
          opts.ctx.hypotheses.resolve(h.id, 'refuted', `action ${action.type} -> ${result.outcome}`);
          hypothesesResolved += 1;
        }
      }
    }
    return {
      actionsTaken: actions,
      costSpent: cost,
      hypothesesResolved,
      unknownActionTypesBefore: countUnknown(unknownBefore),
      unknownActionTypesAfter: countUnknown(opts.ctx.worldModel.worldState.uncertainty.byAction),
      aborted: actions >= opts.maxActions || cost >= opts.maxCost ? 'budget' : undefined,
    };
  }

  updateFromOutcome(_outcome: ExplorationOutcome): void {
    // policy currently stateless beyond novelty history; hook kept for
    // learned-policies (EXP: updateFromOutcome contract in blueprint)
  }
}

function countUnknown(map: Record<string, number>): number {
  return Object.values(map).filter((u) => u >= 0.95).length;
}
