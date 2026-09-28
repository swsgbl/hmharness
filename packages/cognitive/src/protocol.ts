/**
 * @hmharness/cognitive - protocol (blueprint §1 Environment API + §22 interfaces)
 *
 * THE contract everything else builds on. An environment is an observable,
 * actionable, snapshotable, restorable, evaluable world. Protocol-first
 * discipline: these types + validateAction/validateObservation ship and are
 * tested BEFORE any concrete environment exists (master prompt rule: schema
 * and runtime validation are separated, and no capability is declared that
 * is not executable).
 *
 * Hard rules encoded here:
 *  - every Observation carries availableActions (the agent may only choose
 *    from what the environment declared — no invented affordances)
 *  - every ActionResult is success|failure|unknown with structured errors
 *    (blueprint: all errors must have a structured code)
 *  - Snapshot carries a stateHash so replay/restore can detect divergence
 *  - evaluate() is the environment's own voice, never the only judge
 *    (evaluator independence is enforced upstream in evolution2.ts)
 */

/** ENV-002. What the agent sees of the world at one instant. */
export interface Observation {
  environmentId: string;
  timestamp: string;
  /** environment-specific structured state (files, DOM, device tree…) */
  state: unknown;
  /** affordances the environment currently offers (ENV-003) */
  availableActions: ActionSpec[];
  /** optional raw payload (screenshot bytes ref, JSONL dump ref…) */
  raw?: unknown;
}

/** ENV-003. Declarative affordance: what an action needs and returns. */
export interface ActionSpec {
  id: string;
  type: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
  /** declared cost used by exploration budgeting (arbitrary units) */
  cost?: number;
  /** true when the action cannot undo itself (delete, publish, deploy) */
  irreversible?: boolean;
}

/** ENV-003. What the agent does. `reason` is mandatory culture: decisions
 *  are observable (AHE decision observability, blueprint §10). */
export interface Action {
  id: string;
  type: string;
  args: Record<string, unknown>;
  reason?: string;
}

export interface ActionResult {
  actionId: string;
  outcome: 'success' | 'failure' | 'unknown';
  /** structured error, never a bare string (blueprint coding discipline) */
  error?: { code: string; message: string };
  output?: unknown;
  observationRef?: string;
  durationMs?: number;
  cost?: number;
}

export interface ResetOptions {
  /** deterministic seed when the environment supports replay */
  seed?: string;
  /** scratch root for filesystem-backed environments */
  workspaceDir?: string;
}

/** ENV-004. Restorable world state. stateHash detects divergence on restore. */
export interface Snapshot {
  environmentId: string;
  version: number;
  takenAt: string;
  stateHash: string;
  payload: unknown;
}

/** The environment's self-assessment. Never the only promotion signal. */
export interface EnvironmentScore {
  environmentId: string;
  metrics: Record<string, number>;
  details?: string;
}

/** ENV-001. The world contract. observe/act/reset/snapshot/restore/evaluate/close. */
export interface Environment {
  id: string;
  version: string;
  capabilities(): Promise<Capability[]>;
  reset(opts?: ResetOptions): Promise<Observation>;
  observe(): Promise<Observation>;
  act(action: Action): Promise<ActionResult>;
  snapshot(): Promise<Snapshot>;
  restore(snapshot: Snapshot): Promise<void>;
  evaluate(): Promise<EnvironmentScore>;
  close(): Promise<void>;
}

/** ENV-006. What an environment can do, discovered not assumed. */
export interface Capability {
  kind: 'observe' | 'act' | 'evaluate' | 'snapshot' | 'restore' | 'network' | 'filesystem' | 'process' | 'display';
  detail: string;
  /** absent = fully available; present = degraded and why (honesty rule) */
  limitation?: string;
}

/* ---- trajectory (blueprint §23 schema, cognitive step level) ---- */

export interface TrajectoryStep {
  step: number;
  observationRef?: string;
  action: Action;
  prediction?: { claim: string; confidence: number };
  outcome: 'success' | 'failure' | 'unknown';
  reward?: number;
  evidence: string[];
  toolCallId?: string;
  durationMs?: number;
}

export interface TrajectoryMetrics {
  success: boolean;
  actions: number;
  elapsedMs: number;
  recoveryCount: number;
  /** prediction calibration on this trajectory (Brier score, lower=better) */
  brierScore?: number;
}

export interface CognitiveTrajectory {
  id: string;
  sessionId: string;
  environment: { id: string; version: string };
  goal?: { id: string; description: string };
  steps: TrajectoryStep[];
  metrics: TrajectoryMetrics;
  startedAt: string;
  endedAt?: string;
}

export const TRAJECTORY_SCHEMA_VERSION = 1;

/* ---- runtime validation (schema and runtime validation are separated) ---- */

export function validateAction(a: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof a !== 'object' || a === null) return { valid: false, errors: ['action must be an object'] };
  const o = a as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) errors.push('action.id must be a non-empty string');
  if (typeof o.type !== 'string' || !o.type) errors.push('action.type must be a non-empty string');
  if (typeof o.args !== 'object' || o.args === null || Array.isArray(o.args)) errors.push('action.args must be an object');
  if (o.reason !== undefined && typeof o.reason !== 'string') errors.push('action.reason must be a string when present');
  return { valid: errors.length === 0, errors };
}

export function validateObservation(o: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof o !== 'object' || o === null) return { valid: false, errors: ['observation must be an object'] };
  const v = o as Record<string, unknown>;
  if (typeof v.environmentId !== 'string' || !v.environmentId) errors.push('observation.environmentId must be a non-empty string');
  if (typeof v.timestamp !== 'string' || !v.timestamp) errors.push('observation.timestamp must be a non-empty string');
  if (!('state' in v)) errors.push('observation.state is required (may be null)');
  if (!Array.isArray(v.availableActions)) errors.push('observation.availableActions must be an array');
  return { valid: errors.length === 0, errors };
}

export function validateTrajectory(t: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof t !== 'object' || t === null) return { valid: false, errors: ['trajectory must be an object'] };
  const v = t as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id) errors.push('trajectory.id required');
  if (typeof v.sessionId !== 'string' || !v.sessionId) errors.push('trajectory.sessionId required');
  if (typeof v.environment !== 'object' || v.environment === null) errors.push('trajectory.environment required');
  if (!Array.isArray(v.steps)) errors.push('trajectory.steps must be an array');
  else {
    v.steps.forEach((s, i) => {
      const sv = s as Record<string, unknown>;
      if (typeof sv.step !== 'number') errors.push(`steps[${i}].step must be a number`);
      if (!['success', 'failure', 'unknown'].includes(String(sv.outcome))) errors.push(`steps[${i}].outcome invalid`);
      if (sv.prediction !== undefined) {
        const p = sv.prediction as Record<string, unknown>;
        if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
          errors.push(`steps[${i}].prediction.confidence must be within [0,1]`);
        }
      }
    });
  }
  if (typeof v.metrics !== 'object' || v.metrics === null) errors.push('trajectory.metrics required');
  return { valid: errors.length === 0, errors };
}

/** Deterministic non-crypto hash for stateHash / replay divergence checks. */
export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(sortKeys(value));
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + text.charCodeAt(i) * 31) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
