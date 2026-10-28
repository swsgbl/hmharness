/**
 * @hmharness/cognitive - Evidence Ledger v2 (upgrade pack stage A item 3)
 *
 * One lineage ID to answer the pack's acceptance question - "任何指标都能
 * 回答：谁产生、在哪验证、由谁独立验证、是否可回放" - by binding a run
 * to the FULL cognitive context that produced it:
 *
 *   run/task/model/prompt/tool versions/skill versions/world-model
 *   revision/code-world stateHash/datasetHash+seed (the EVAL-IND tie-in)
 *
 * Discipline carried over from the pieces it unifies:
 *  - lineageId = sha256 over a CANONICAL form (sorted keys, order-
 *    independent, content-sensitive - datasetHash's arithmetic)
 *  - comparability is AXIS-EXPLICIT, the reportsComparable lesson: two
 *    lineages are comparable only on the axes you name, and naming no
 *    axes means nothing is comparable
 *  - absent context fields are OMITTED from the canonical form (an
 *    unversioned prompt hashes differently than a versioned one - the
 *    difference is visible, not averaged away)
 */
import { createHash } from 'node:crypto';

export interface EvidenceLineage {
  runId: string;
  taskId?: string;
  modelId: string;
  promptVersion: string;
  toolVersions: Record<string, string>;
  skillVersions?: Record<string, string>;
  /** WorldModel.state.version at run start */
  worldModelVersion?: number;
  /** code-world-store's content-sensitive stateHash at run start */
  codeWorldStateHash?: string;
  /** EVAL-IND tie-in: the task set fingerprint + seed (+ split label) */
  datasetHash?: string;
  seed?: string;
  split?: string;
  createdAt: string;
}

/** order-independent canonical JSON: object keys sorted at every depth */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/** sha256 over the canonical lineage form (createdAt excluded - the same
 *  context re-stamped must keep its identity). */
export function lineageId(lineage: Omit<EvidenceLineage, 'createdAt'> & { createdAt?: string }): string {
  const { createdAt: _drop, ...rest } = lineage;
  void _drop;
  return 'lin-' + createHash('sha256').update(canonical(rest)).digest('hex').slice(0, 16);
}

export const COMPARABLE_AXES = ['modelId', 'promptVersion', 'toolVersions', 'skillVersions', 'datasetHash', 'seed', 'split'] as const;
export type ComparableAxis = (typeof COMPARABLE_AXES)[number];

/** Axis-explicit comparability: both lineages must MATCH on every named
 *  axis. An axis absent on one side and present on the other does NOT
 *  compare (unknown is not equal). Empty axis list compares nothing. */
export function comparableLineage(
  a: EvidenceLineage,
  b: EvidenceLineage,
  axes: readonly ComparableAxis[],
): { comparable: boolean; mismatches: ComparableAxis[] } {
  const mismatches: ComparableAxis[] = [];
  for (const axis of axes) {
    const av = (a as unknown as Record<string, unknown>)[axis];
    const bv = (b as unknown as Record<string, unknown>)[axis];
    if (av === undefined || bv === undefined || canonical(av) !== canonical(bv)) mismatches.push(axis);
  }
  return { comparable: mismatches.length === 0, mismatches };
}

/** The run envelope: lineage + one evidence payload (a metric report, an
 *  audit verdict, a prediction summary). Replay = lineage + payload. */
export interface EvidenceEnvelope<T> {
  lineageId: string;
  lineage: EvidenceLineage;
  kind: string;
  payload: T;
  at: string;
}

export function evidenceEnvelope<T>(lineage: EvidenceLineage, kind: string, payload: T): EvidenceEnvelope<T> {
  return { lineageId: lineageId(lineage), lineage, kind, payload, at: new Date().toISOString() };
}
