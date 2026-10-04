/**
 * @hmharness/cognitive - WM-2 deep water: causal / temporal / counterfactual
 * (2026-10-04 audit M2: "entity/relation/causal/temporal/counterfactual")
 *
 * The first WM-2 slice gave State→Action→PredictedDelta→ActualDelta→
 * PredictionError (stateDiff/predictDelta/deltaAccuracy). This slice adds
 * the three deep layers over the SAME TransitionStore:
 *
 *   CAUSAL      mineCausalLinks — for each (actionType, stateKey) pair,
 *               temporal precedence is ENFORCED (the delta must FOLLOW the
 *               action at lag 0 or 1), then observational lift compares
 *               P(delta|action) vs P(delta|no-action). Honest label:
 *               observational, not interventional — we never claim
 *               experiments we didn't run.
 *   TEMPORAL    lag is measured: how many steps after the action the delta
 *               lands (lag 0 = same transition, lag 1 = next transition).
 *   COUNTERFACTUAL  counterfactualWithout — replay the transition history
 *               EXCLUDING one action type and diff the learned world state
 *               against the real one. Honest label: model-based
 *               extrapolation (the replayed world is what the belief table
 *               WOULD have learned — not a claim about the environment).
 */
import type { Observation } from './protocol.ts';
import { stateDiff, WorldModel, type Transition, type WorldState } from './world-model.ts';

/* ---------------- causal + temporal mining ---------------- */

export interface CausalLink {
  actionType: string;
  stateKey: string;
  /** observational lift: P(delta on key | action) − P(delta on key | no action) */
  lift: number;
  /** transitions where the action ran and the key changed (within lag) */
  support: number;
  /** measured lag in steps (0 = same transition, 1 = next transition) */
  lag: 0 | 1;
  /** "observational" — stamped on every link: no intervention was performed */
  evidence: 'observational';
}

function deltaKeys(t: Transition): string[] {
  const before = t.stateBefore.variables ?? t.stateBefore;
  const after = t.stateAfter ? (t.stateAfter.variables ?? t.stateAfter) : t.observation.state;
  const d = stateDiff(before, after);
  return [...d.added, ...d.removed, ...d.changed.map((c) => c.key)];
}

/**
 * Mine causal candidates from the transition journal. Bookkeeping is
 * class-conditional: for every (actionType, stateKey, lag) we count
 * P(key changes | action ran) against P(key changes | action did NOT run)
 * over the same lag window — a link survives only with positive lift and
 * enough support. Temporal precedence is structural: the delta window
 * starts AT the action (lag 0) or one step after (lag 1).
 */
export function mineCausalLinks(transitions: Transition[], opts: { minSupport?: number; minLift?: number } = {}): CausalLink[] {
  const minSupport = opts.minSupport ?? 2;
  const minLift = opts.minLift ?? 0.2;
  const chronological = [...transitions].sort((a, b) => String(a.observation.timestamp).localeCompare(String(b.observation.timestamp)));

  // runs per action type
  const runs = new Map<string, number>();
  for (const t of chronological) runs.set(t.action.type, (runs.get(t.action.type) ?? 0) + 1);

  // key-change counters per lag window
  // with: key changed in the window of a transition whose ACTION is `type`
  // total: key changed in that window regardless of action
  const withAction = new Map<string, number>(); // `${type}|${key}|${lag}`
  const totalAtLag = new Map<string, number>(); // `${key}|${lag}`
  const windows: Array<{ keys: string[]; lag: 0 | 1; type: string }> = [];
  for (let i = 0; i < chronological.length; i++) {
    const t = chronological[i]!;
    windows.push({ keys: deltaKeys(t), lag: 0 as const, type: t.action.type });
    const next = chronological[i + 1];
    if (next) windows.push({ keys: deltaKeys(next), lag: 1 as const, type: t.action.type });
  }
  for (const w of windows) {
    for (const key of new Set(w.keys)) {
      const wk = `${w.type}|${key}|${w.lag}`;
      withAction.set(wk, (withAction.get(wk) ?? 0) + 1);
      const tk = `${key}|${w.lag}`;
      totalAtLag.set(tk, (totalAtLag.get(tk) ?? 0) + 1);
    }
  }

  // Occam suppression for lag-1 links: when the immediate successor action
  // explains the same key at lag 0 with a rate >= this link's lag-1 rate,
  // the shorter path wins (the bystander must not harvest the successor's
  // work — caught by the red-team-style test where login preceded deploy).
  const pWithOf = (type: string, key: string, lag: 0 | 1): number => {
    const w = withAction.get(`${type}|${key}|${lag}`) ?? 0;
    return w / Math.max(1, runs.get(type) ?? 1);
  };
  const links: CausalLink[] = [];
  for (const [wk, withCount] of withAction) {
    const [type, key, lagStr] = wk.split('|');
    const lag = Number(lagStr) as 0 | 1;
    const typeRuns = runs.get(type) ?? 0;
    const windowCount = lag === 0 ? chronological.length : Math.max(0, chronological.length - 1);
    const pWith = withCount / Math.max(1, typeRuns);
    const withoutCount = Math.max(0, (totalAtLag.get(`${key}|${lag}`) ?? 0) - withCount);
    const noActionWindows = Math.max(1, windowCount - typeRuns);
    const pWithout = withoutCount / noActionWindows;
    const lift = Number((pWith - pWithout).toFixed(3));
    if (withCount < minSupport || lift < minLift) continue;
    if (lag === 1) {
      let suppressed = false;
      for (const [sk, sw] of withAction) {
        const [sType, sKey, sLagStr] = sk.split('|');
        if (sLagStr !== '0' || sKey !== key) continue;
        const sP = sw / Math.max(1, runs.get(sType!) ?? 1);
        if (sP >= pWith) { suppressed = true; break; }
      }
      if (suppressed) continue;
    }
    // same (type,key) may appear at both lags — keep the stronger one
    const prev = links.find((l) => l.actionType === type && l.stateKey === key);
    if (prev) {
      if (lift > prev.lift) { prev.lift = lift; prev.support = withCount; prev.lag = lag; }
      continue;
    }
    void pWithOf;
    links.push({ actionType: type!, stateKey: key!, lift, support: withCount, lag, evidence: 'observational' });
  }
  return links.sort((a, b) => b.lift - a.lift || b.support - a.support);
}

/* ---------------- counterfactual ---------------- */

export interface CounterfactualReport {
  /** the intervention: replay WITHOUT this action type */
  withoutActionType: string;
  /** honest epistemic label — this is what the BELIEF TABLE would have learned */
  nature: 'model-based-extrapolation';
  /** beliefs present in reality but ABSENT in the counterfactual world */
  lostBeliefs: Array<{ actionType: string; confidence: number }>;
  /** the real vs counterfactual belief counts */
  realBeliefs: number;
  counterfactualBeliefs: number;
  /** transitions that carried the action (excluded from the replay) */
  excludedTransitions: number;
}

/**
 * Replay the history WITHOUT one action type and diff the learned world
 * against reality. NOT an environment claim: it answers "what would the
 * harness have believed" — the honest scope of observational
 * counterfactuals. Interventions on the environment belong to exploration.
 */
export function counterfactualWithout(transitions: Transition[], withoutActionType: string, environmentId = 'terminal'): CounterfactualReport {
  const real = new WorldModel(environmentId);
  for (const t of transitions) real.update(t);
  const kept = transitions.filter((t) => t.action.type !== withoutActionType);
  const cf = new WorldModel(environmentId);
  for (const t of kept) cf.update(t);
  const cfTypes = new Set(cf.worldState.beliefs.filter((b) => b.id.startsWith('act:')).map((b) => b.id.slice(4)));
  const lostBeliefs = real.worldState.beliefs
    .filter((b) => b.id.startsWith('act:') && !cfTypes.has(b.id.slice(4)))
    .map((b) => ({ actionType: b.id.slice(4), confidence: b.confidence }));
  return {
    withoutActionType,
    nature: 'model-based-extrapolation',
    lostBeliefs,
    realBeliefs: real.worldState.beliefs.filter((b) => b.id.startsWith('act:')).length,
    counterfactualBeliefs: cf.worldState.beliefs.filter((b) => b.id.startsWith('act:')).length,
    excludedTransitions: transitions.filter((t) => t.action.type === withoutActionType).length,
  };
}
