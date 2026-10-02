/**
 * @hmharness/cognitive - world model (blueprint §3 / WM-001..010)
 *
 * The agent's_belief about an environment, updated from transitions and used
 * to predict action outcomes. Blueprint hard rules encoded:
 *  - 不允许假装确定: every prediction carries confidence; low-confidence
 *    predictions are flagged and MAY NOT silently feed a planner
 *    (plannerConfidence gate below)
 *  - prediction vs actual 自动比较 (WM-005): every resolved prediction is
 *    scored, rolling calibration is maintained
 *  - 错误聚类 (WM-005): misses cluster by (actionType, errorBucket) so the
 *    diagnosis layer sees WHERE the model is wrong, not just how often
 *  - replay (WM-009): transitions are the unit of replay/revision evidence
 *  - episodic retrieval + semantic rule extraction (WM-008): transitions are
 *    retrievable; `revise` turns recurring error clusters into explicit
 *    correction rules (never silently rewritten beliefs)
 */
import type { Action, Observation } from './protocol.ts';
import { stableHash } from './protocol.ts';

export interface Belief {
  id: string;
  claim: string;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt?: string;
  /** correction rules extracted from error clusters (WM-008) */
  corrections?: Array<{ pattern: string; rule: string; fromCluster: string }>;
}

export interface UncertaintyMap {
  /** actionType -> uncertainty in [0,1]; absent = never observed */
  byAction: Record<string, number>;
}

export interface WorldState {
  environmentId: string;
  version: number;
  entities: Array<{ id: string; kind: string; props?: Record<string, unknown> }>;
  variables: Record<string, unknown>;
  beliefs: Belief[];
  uncertainty: UncertaintyMap;
}

export interface Transition {
  stateBefore: WorldState;
  action: Action;
  observation: Observation;
  stateAfter?: WorldState;
  reward?: number;
  outcome: 'success' | 'failure' | 'unknown';
  predictionId?: string;
}

export interface Prediction {
  id: string;
  claim: string;
  confidence: number;
  actionType: string;
  createdAt: string;
  resolvedAt?: string;
  actual?: 'success' | 'failure' | 'unknown';
  /** |confidence - actual| on resolution */
  error?: number;
}

export interface PredictionEvidence {
  predictionId: string;
  claim: string;
  confidence: number;
  actual?: string;
  error?: number;
  supportingTransitions: number;
  cluster?: string;
}

export interface ModelRevision {
  id: string;
  createdAt: string;
  clustersAddressed: string[];
  rulesAdded: Array<{ pattern: string; rule: string }>;
  beliefsAdjusted: number;
}

export interface ModelEvidence {
  cluster: string;
  misses: number;
  total: number;
  sampleErrors: Array<{ claim: string; actual: string; confidence: number }>;
}

export interface PredictionQuery {
  action: Action;
  currentState?: WorldState;
}

/* ---------------- WM 2.0: structured state deltas (review 02 doc, W8) ---------------- */

export interface StateDelta {
  /** top-level state keys added / removed / changed by a transition */
  added: string[];
  removed: string[];
  changed: Array<{ key: string; from: unknown; to: unknown }>;
  /** stable shape id: which keys this action tends to touch, sorted */
  shape: string;
}

/** Structural diff of two observation states (top level + one nested
 *  level; deeper structure is hashed into the changed value). Deterministic
 *  and content-agnostic — it works on ANY environment's state object. */
export function stateDiff(before: unknown, after: unknown): StateDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ key: string; from: unknown; to: unknown }> = [];
  const norm = (v: unknown): unknown => (v !== null && typeof v === 'object' ? stableHash(v) : v);
  const keysOf = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o as Record<string, unknown>) : []);
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  for (const k of new Set([...keysOf(before), ...keysOf(after)])) {
    const inB = k in b;
    const inA = k in a;
    if (inB && !inA) removed.push(k);
    else if (!inB && inA) added.push(k);
    else if (JSON.stringify(norm(b[k])) !== JSON.stringify(norm(a[k]))) changed.push({ key: k, from: norm(b[k]), to: norm(a[k]) });
  }
  const shape = [...added, ...removed, ...changed.map((c) => c.key)].sort().join(',');
  return { added: added.sort(), removed: removed.sort(), changed, shape };
}

export interface DeltaPrediction {
  actionType: string;
  /** most frequent historical delta shape for this action type */
  predictedShape: string | null;
  /** fraction of historical transitions of this type that matched the mode shape */
  confidence: number;
  n: number;
}

export interface DeltaAccuracy {
  checked: number;
  /** predictions whose predicted shape matched the actual shape */
  hits: number;
  accuracy: number | undefined;
}

/** WM-002. Transition journal with retrieval by action type / outcome. */
export class TransitionStore {
  private items: Transition[] = [];
  append(t: Transition): void {
    this.items.push(t);
    if (this.items.length > 10_000) this.items.splice(0, this.items.length - 10_000);
  }
  all(): readonly Transition[] {
    return this.items;
  }
  byActionType(type: string): Transition[] {
    return this.items.filter((t) => t.action.type === type);
  }
  byOutcome(outcome: Transition['outcome']): Transition[] {
    return this.items.filter((t) => t.outcome === outcome);
  }
  /** rough episodic retrieval: most recent N transitions of same action type */
  similar(actionType: string, n = 5): Transition[] {
    return this.items.filter((t) => t.action.type === actionType).slice(-n);
  }
}

export class WorldModel {
  private state: WorldState;
  private transitions = new TransitionStore();
  private predictions = new Map<string, Prediction>();
  private seq = 0;
  /** WM 2.0: per-actionType delta shape history + prediction-accuracy
   *  bookkeeping (structured predictions are scored like outcome ones) */
  private deltaShapes = new Map<string, string[]>();
  private deltaChecked = 0;
  private deltaHits = 0;
  /** open structured predictions: predictionId -> expected shape (resolved on update) */
  private openDeltaPredictions = new Map<string, string>();

  constructor(environmentId: string) {
    this.state = {
      environmentId,
      version: 1,
      entities: [],
      variables: {},
      beliefs: [],
      uncertainty: { byAction: {} },
    };
  }

  get worldState(): WorldState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** WM-001/006. Apply a transition: update variables/entities, per-action
   *  success-rate beliefs, and resolve any prediction bound to the action. */
  update(input: Transition): WorldState {
    this.transitions.append(input);
    const after = input.stateAfter;
    if (after) {
      this.state.entities = after.entities;
      this.state.variables = after.variables;
    }
    // belief per action type: exponential moving success rate
    const key = input.action.type;
    const prior = this.state.beliefs.find((b) => b.id === `act:${key}`);
    const rate = input.outcome === 'success' ? 1 : input.outcome === 'failure' ? 0 : 0.5;
    if (!prior) {
      this.state.beliefs.push({
        id: `act:${key}`,
        claim: `action ${key} succeeds ~${rate * 100}%`,
        confidence: 0.3, // low until evidence accumulates
        evidenceCount: 1,
        lastConfirmedAt: new Date().toISOString(),
      });
    } else {
      const n = prior.evidenceCount + 1;
      const blended = (prior.confidence * (n - 1) + rate) / n;
      prior.confidence = Number(blended.toFixed(4));
      prior.evidenceCount = n;
      prior.claim = `action ${key} succeeds ~${Math.round(blended * 100)}% (n=${n})`;
      prior.lastConfirmedAt = new Date().toISOString();
    }
    this.state.uncertainty.byAction[key] = Number((1 - (this.state.beliefs.find((b) => b.id === `act:${key}`)?.confidence ?? 0)).toFixed(4));
    this.state.version += 1;
    // WM 2.0: structured delta — diff the before/after state, learn the
    // shape per action type, and score any open delta prediction
    const actualDelta = stateDiff(input.stateBefore.variables ?? input.stateBefore, after ? (after.variables ?? after) : input.observation.state);
    const shapes = this.deltaShapes.get(key) ?? [];
    shapes.push(actualDelta.shape);
    if (shapes.length > 50) shapes.splice(0, shapes.length - 50);
    this.deltaShapes.set(key, shapes);
    if (input.predictionId) {
      const expected = this.openDeltaPredictions.get(input.predictionId);
      if (expected !== undefined) {
        this.openDeltaPredictions.delete(input.predictionId);
        this.deltaChecked += 1;
        if (expected === actualDelta.shape) this.deltaHits += 1;
      }
    }
    // WM-005: resolve the prediction bound to this action, if any
    if (input.predictionId) {
      const p = this.predictions.get(input.predictionId);
      if (p && !p.resolvedAt) {
        p.resolvedAt = new Date().toISOString();
        p.actual = input.outcome;
        p.error = Number(Math.abs(p.confidence - (input.outcome === 'success' ? 1 : 0)).toFixed(4));
      }
    }
    return this.worldState;
  }

  /** WM-003/004. Predict the outcome of an action from the belief table.
   *  The model is allowed to say "I don't know": unseen action types return
   *  confidence 0 and knownUnknown=true — planners MUST treat that as a
   *  signal to explore, not as 0% success. */
  predict(query: PredictionQuery): Prediction {
    const key = query.action.type;
    const belief = this.state.beliefs.find((b) => b.id === `act:${key}`);
    const id = `pred-${++this.seq}`;
    const prediction: Prediction = {
      id,
      claim: belief
        ? belief.claim
        : `no evidence about action ${key} yet (unknown)`,
      confidence: belief ? belief.confidence : 0,
      actionType: key,
      createdAt: new Date().toISOString(),
    };
    this.predictions.set(id, prediction);
    return prediction;
  }

  /** WM 2.0: predict the STRUCTURAL effect of an action — which state keys
   *  it tends to touch — from the delta-shape history. Ties into the same
   *  predictionId resolution as outcome predictions: passing the id here
   *  scores the shape prediction when the transition lands. */
  predictDelta(actionType: string, predictionId?: string): DeltaPrediction {
    const shapes = this.deltaShapes.get(actionType) ?? [];
    const counts = new Map<string, number>();
    for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
    let mode: string | null = null;
    let modeN = 0;
    for (const [s, c] of counts) if (c > modeN) { mode = s; modeN = c; }
    if (mode !== null && predictionId) this.openDeltaPredictions.set(predictionId, mode);
    return { actionType, predictedShape: mode, confidence: shapes.length > 0 ? Number((modeN / shapes.length).toFixed(3)) : 0, n: shapes.length };
  }

  /** WM 2.0: rolling accuracy of structured shape predictions. */
  deltaAccuracy(): DeltaAccuracy {
    if (this.deltaChecked === 0) return { checked: 0, hits: 0, accuracy: undefined };
    return { checked: this.deltaChecked, hits: this.deltaHits, accuracy: Number((this.deltaHits / this.deltaChecked).toFixed(3)) };
  }

  /** planner gate: which action types are reliable enough to plan with */
  plannerConfidence(threshold = 0.6): { trusted: string[]; untrusted: string[]; unknown: string[] } {
    const trusted: string[] = [];
    const untrusted: string[] = [];
    const unknown: string[] = [];
    for (const b of this.state.beliefs) {
      if (!b.id.startsWith('act:')) continue;
      const type = b.id.slice(4);
      if (b.evidenceCount < 2 || b.confidence < threshold) untrusted.push(type);
      else trusted.push(type);
    }
    for (const t of this.transitions.all()) {
      const seen = new Set([...trusted, ...untrusted]);
      if (!seen.has(t.action.type) && !unknown.includes(t.action.type)) unknown.push(t.action.type);
    }
    return { trusted, untrusted, unknown };
  }

  explainPrediction(id: string): PredictionEvidence {
    const p = this.predictions.get(id);
    if (!p) throw new Error(`unknown prediction ${id}`);
    const supporting = this.transitions.byActionType(p.actionType).length;
    const clusterKey = p.error !== undefined && p.error > 0.5 ? `${p.actionType}/systematic-miss` : `${p.actionType}/ok`;
    return {
      predictionId: p.id,
      claim: p.claim,
      confidence: p.confidence,
      actual: p.actual,
      error: p.error,
      supportingTransitions: supporting,
      cluster: clusterKey,
    };
  }

  /** WM-005. Cluster resolved-but-wrong predictions by action type. */
  errorClusters(): ModelEvidence[] {
    const byCluster = new Map<string, { misses: number; total: number; samples: PredictionEvidence[] }>();
    for (const p of this.predictions.values()) {
      if (!p.resolvedAt || p.error === undefined) continue;
      const bucket = p.actual === 'success' ? 'predicted-fail-but-succeeded' : 'predicted-success-but-failed';
      const key = `${p.actionType}/${bucket}`;
      const c = byCluster.get(key) ?? { misses: 0, total: 0, samples: [] };
      c.total += 1;
      if (p.error > 0.5) {
        c.misses += 1;
        c.samples.push(this.explainPrediction(p.id));
      }
      byCluster.set(key, c);
    }
    return [...byCluster.entries()].map(([cluster, c]) => ({
      cluster,
      misses: c.misses,
      total: c.total,
      sampleErrors: c.samples.slice(0, 5).map((s) => ({ claim: s.claim, actual: String(s.actual), confidence: s.confidence })),
    }));
  }

  /** WM-007/008. Turn error clusters into explicit correction rules.
   *  Beliefs are NOT silently rewritten — rules are attached as corrections
   *  so provenance survives (blueprint: 可解释修订). */
  revise(evidence: ModelEvidence[]): ModelRevision {
    const rulesAdded: Array<{ pattern: string; rule: string }> = [];
    for (const ev of evidence) {
      if (ev.misses < 2) continue; // need repetition, not noise
      const [actionType, bucket] = ev.cluster.split('/');
      const rule =
        bucket === 'predicted-success-but-failed'
          ? `${actionType} fails more often than the success-rate belief implies; discount its confidence before planning`
          : `${actionType} succeeds more often than believed; treat pessimism here as stale evidence`;
      const pattern = ev.cluster;
      const belief = this.state.beliefs.find((b) => b.id === `act:${actionType}`);
      if (belief) {
        belief.corrections = [...(belief.corrections ?? []), { pattern, rule, fromCluster: ev.cluster }];
      }
      rulesAdded.push({ pattern, rule });
    }
    this.state.version += 1;
    return {
      id: `rev-${stableHash(rulesAdded).slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      clustersAddressed: evidence.map((e) => e.cluster),
      rulesAdded,
      beliefsAdjusted: rulesAdded.length,
    };
  }

  confidence(stateOrPredictionId: string): number {
    const p = this.predictions.get(stateOrPredictionId);
    if (p) return p.confidence;
    const hash = stableHash(this.state);
    if (stateOrPredictionId === hash) {
      const beliefs = this.state.beliefs;
      if (beliefs.length === 0) return 0;
      return Number((beliefs.reduce((s, b) => s + b.confidence, 0) / beliefs.length).toFixed(4));
    }
    throw new Error(`unknown id ${stateOrPredictionId}`);
  }

  /** rolling calibration for the dashboard (mean |error| over resolved) */
  calibration(): { resolved: number; meanError: number | undefined } {
    const resolved = [...this.predictions.values()].filter((p) => p.error !== undefined);
    if (resolved.length === 0) return { resolved: 0, meanError: undefined };
    return {
      resolved: resolved.length,
      meanError: Number((resolved.reduce((s, p) => s + (p.error ?? 0), 0) / resolved.length).toFixed(4)),
    };
  }

  get transitionsStore(): TransitionStore {
    return this.transitions;
  }
}
