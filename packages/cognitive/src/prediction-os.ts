/**
 * @hmharness/cognitive - Prediction OS unified schema (v0, upgrade pack §10)
 *
 * The pack's first core line: the three prediction families that grew up in
 * separate modules become ONE record shape with ONE aggregate report -
 *
 *   Outcome Pred (world-model action success)  -> calibration
 *   State Delta (WM 2.0 shape predictions)     -> delta accuracy
 *   Edit Pred (Code WM blast radius)           -> edit error
 *        |
 *   unified prediction -> resolution -> normalized error
 *        -> ranked learning signal (worstErrors) for the exploration policy
 *        -> Cognitive Ledger mirroring (prediction.made/confirmed/failed
 *           chained by parentSeq)
 *
 * Honesty rules:
 *  - error is DOMAIN-DEFINED and normalized to [0,1]; the aggregate Brier
 *    is the mean of squared normalized errors - for the outcome domain
 *    this is the classical binary Brier, for delta/edit it is the same
 *    arithmetic on the domain's normalized error (stated, not hidden)
 *  - verdict threshold is explicit: error <= CONFIRM_THRESHOLD confirmed,
 *    otherwise failed; a resolution is write-once (double-resolve refuses)
 *  - worstErrors RANKS by observed error; ranking is not causation
 */
import type { CognitiveLedger } from './ledger.ts';
import type { Prediction } from './world-model.ts';
import type { EditDelta, PredictionError } from './code-world-model.ts';

export type PredictionDomain = 'outcome' | 'state-delta' | 'edit';

/** error at or below this counts as a confirmed prediction */
export const CONFIRM_THRESHOLD = 0.5;

export interface UnifiedPrediction {
  readonly id: string;
  readonly domain: PredictionDomain;
  /** what the prediction is about: actionType | stateKey | entity id */
  readonly subject: string;
  /** canonical predicted value/shape (domain-specific string) */
  readonly predicted: string;
  readonly confidence: number;
  readonly madeAt: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly resolvedAt?: string;
  readonly actual?: string;
  /** normalized [0,1], domain-defined */
  readonly error?: number;
  readonly verdict?: 'confirmed' | 'failed';
}

export interface DomainStats {
  n: number;
  resolved: number;
  confirmed: number;
  meanConfidence: number;
  meanError: number;
  /** mean of squared normalized errors (binary Brier on the outcome domain) */
  brier: number;
}

export interface PredictionOSSummary {
  total: number;
  unresolved: number;
  byDomain: Record<PredictionDomain, DomainStats>;
}

export interface RecordInput {
  domain: PredictionDomain;
  subject: string;
  predicted: string;
  confidence: number;
  runId?: string;
  taskId?: string;
  id?: string;
  at?: string;
}

export class PredictionOS {
  private readonly byId = new Map<string, UnifiedPrediction>();
  private readonly order: string[] = [];
  /** seq of each prediction's ledger.made event, for parentSeq chaining */
  private readonly madeSeq = new Map<string, number>();
  /** when set, record/resolve mirror into the Cognitive Ledger */
  ledger?: CognitiveLedger;

  record(input: RecordInput): UnifiedPrediction {
    const id = input.id ?? `pred-${this.byId.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.byId.has(id)) throw new Error(`prediction ${id} already exists - ids are write-once`);
    const p: UnifiedPrediction = Object.freeze({
      id,
      domain: input.domain,
      subject: input.subject,
      predicted: input.predicted,
      confidence: input.confidence,
      madeAt: input.at ?? new Date().toISOString(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    });
    this.byId.set(id, p);
    this.order.push(id);
    if (this.ledger) {
      this.madeSeq.set(id, this.ledger.append('prediction.made', input.subject, {
        detail: `${input.domain}: ${input.predicted}`,
        runId: input.runId,
        taskId: input.taskId,
        confidence: input.confidence,
      }).seq);
    }
    return p;
  }

  /** Write-once resolution: the second resolve on the same id refuses. */
  resolve(id: string, actual: string, error: number): UnifiedPrediction {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`prediction ${id} not found`);
    if (existing.resolvedAt !== undefined) throw new Error(`prediction ${id} already resolved - resolutions are write-once`);
    const clamped = Math.max(0, Math.min(1, error));
    const resolved: UnifiedPrediction = Object.freeze({
      ...existing,
      resolvedAt: new Date().toISOString(),
      actual,
      error: clamped,
      verdict: clamped <= CONFIRM_THRESHOLD ? 'confirmed' : 'failed',
    });
    this.byId.set(id, resolved);
    if (this.ledger) {
      this.ledger.append(resolved.verdict === 'confirmed' ? 'prediction.confirmed' : 'prediction.failed', resolved.subject, {
        detail: `${resolved.domain}: predicted ${resolved.predicted}, actual ${actual}`,
        runId: resolved.runId,
        taskId: resolved.taskId,
        confidence: resolved.confidence,
        ...(this.madeSeq.has(id) ? { parentSeq: this.madeSeq.get(id) } : {}),
      });
    }
    return resolved;
  }

  get(id: string): UnifiedPrediction | undefined {
    return this.byId.get(id);
  }

  unresolved(domain?: PredictionDomain): UnifiedPrediction[] {
    return this.order
      .map((id) => this.byId.get(id)!)
      .filter((p) => p.resolvedAt === undefined && (domain === undefined || p.domain === domain));
  }

  /** Ranked learning-signal feed: worst observed errors first. */
  worstErrors(limit = 10, domain?: PredictionDomain): UnifiedPrediction[] {
    return this.order
      .map((id) => this.byId.get(id)!)
      .filter((p) => p.error !== undefined && (domain === undefined || p.domain === domain))
      .sort((a, b) => (b.error ?? 0) - (a.error ?? 0))
      .slice(0, limit);
  }

  summary(): PredictionOSSummary {
    const domains: PredictionDomain[] = ['outcome', 'state-delta', 'edit'];
    const byDomain = {} as Record<PredictionDomain, DomainStats>;
    let unresolved = 0;
    for (const d of domains) {
      const ps = this.order.map((id) => this.byId.get(id)!).filter((p) => p.domain === d);
      const res = ps.filter((p) => p.error !== undefined);
      byDomain[d] = {
        n: ps.length,
        resolved: res.length,
        confirmed: res.filter((p) => p.verdict === 'confirmed').length,
        meanConfidence: ps.length ? Number((ps.reduce((s, p) => s + p.confidence, 0) / ps.length).toFixed(3)) : 0,
        meanError: res.length ? Number((res.reduce((s, p) => s + (p.error ?? 0), 0) / res.length).toFixed(3)) : 0,
        brier: res.length ? Number((res.reduce((s, p) => s + (p.error ?? 0) ** 2, 0) / res.length).toFixed(3)) : 0,
      };
      unresolved += ps.filter((p) => p.resolvedAt === undefined).length;
    }
    return { total: this.order.length, unresolved, byDomain };
  }
}

/* ---------------- domain adapters ---------------- */

/** Outcome family: world-model action-success predictions. */
export function fromOutcome(p: Prediction, runId?: string, taskId?: string): RecordInput & { resolved?: { actual: string; error: number } } {
  const predictedCall = p.confidence > CONFIRM_THRESHOLD ? 'success' : 'failure';
  const input: RecordInput & { resolved?: { actual: string; error: number } } = {
    id: p.id,
    domain: 'outcome',
    subject: p.actionType,
    predicted: predictedCall,
    confidence: p.confidence,
    at: p.createdAt,
    runId,
    taskId,
  };
  if (p.actual === 'success' || p.actual === 'failure') {
    // classical binary error: |confidence - actual(0/1)|
    const actual01 = p.actual === 'success' ? 1 : 0;
    input.resolved = { actual: p.actual, error: p.error ?? Math.abs(p.confidence - actual01) };
  }
  return input;
}

/** State-delta family: WM 2.0 shape predictions resolve hit-or-miss. */
export function fromDelta(actionType: string, predictedShape: string, confidence: number, hit: boolean, runId?: string): RecordInput & { resolved?: { actual: string; error: number } } {
  return {
    domain: 'state-delta',
    subject: actionType,
    predicted: predictedShape,
    confidence,
    runId,
    resolved: { actual: hit ? predictedShape : 'other-shape', error: hit ? 0 : 1 },
  };
}

/** Edit family: Code WM blast-radius predictions scored by Jaccard. */
export function fromEditResolution(edit: EditDelta, err: PredictionError, runId?: string): RecordInput & { resolved: { actual: string; error: number } } {
  return {
    domain: 'edit',
    subject: edit.target,
    predicted: `${edit.editKind}(${edit.touchedEntities.length}e/${edit.touchedRelations.length}r)`,
    confidence: 1 - edit.newDiagnosticEstimate,
    runId,
    resolved: {
      actual: `jaccard ${err.jaccard.toFixed(3)} (missed ${err.missed.length}, spurious ${err.spurious.length})`,
      error: Number(Math.max(0, Math.min(1, 1 - err.jaccard)).toFixed(3)),
    },
  };
}

/** Record-and-optionally-resolve an adapted prediction in one call. */
export function ingestAdapted(pos: PredictionOS, adapted: RecordInput & { resolved?: { actual: string; error: number } }): UnifiedPrediction {
  const { resolved, ...input } = adapted;
  const p = pos.record(input);
  return resolved ? pos.resolve(p.id, resolved.actual, resolved.error) : p;
}
