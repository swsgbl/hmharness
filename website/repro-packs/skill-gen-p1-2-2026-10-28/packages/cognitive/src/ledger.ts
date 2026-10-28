/**
 * @hmharness/cognitive - Cognitive Ledger (v0, 2026-10-05 upgrade pack §16)
 *
 * The append-only record of significant cognitive changes — the data
 * structure Credit Assignment will read: belief.created/revised,
 * prediction.made/failed/confirmed, exploration.chosen, observation.recorded,
 * skill.candidate/promoted/rejected, memory.promoted/contradicted,
 * goal.revised, model.routed, capability.denied.
 *
 * Discipline carried over from the trust stores and multi-agent audit:
 *  - append-only: events are frozen at append time, seq is strictly
 *    monotonic and never reused; there is no edit API by design
 *  - parentSeq links an event to the one it answers (PREDICTION_FAILED
 *    points back at its PREDICTION_MADE; BELIEF_REVISED at the failed
 *    prediction or the earlier belief) — chain() walks lineage to the root
 *  - persistence is one JSON object per line under
 *    HMH_HOME/cognitive/ledger.jsonl; a corrupt line is skipped and
 *    counted, never a crash (same posture as every cognitive state file)
 *  - v0 is honest about scope: it records WHO changed and WHAT changed,
 *    with lineage hooks for runId/taskId (Evidence Ledger v2). It does
 *    not claim causality — attribution is a later, separate claim.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LedgerEventKind =
  | 'belief.created'
  | 'belief.revised'
  /** Ledger 2.0 (weekly pack 0.24 P0): the DAG vocabulary grows so the
   *  replayable cognitive graph can express supersession, contradiction,
   *  causal hypotheses, strategy changes and attribution results. */
  | 'belief.superseded'
  | 'belief.contradicted'
  | 'causal.hypothesis'
  | 'strategy.changed'
  | 'credit.attribution'
  | 'prediction.made'
  | 'prediction.confirmed'
  | 'prediction.failed'
  | 'exploration.chosen'
  | 'observation.recorded'
  | 'skill.candidate'
  | 'skill.promoted'
  | 'skill.rejected'
  | 'memory.promoted'
  | 'memory.contradicted'
  | 'goal.revised'
  | 'model.routed'
  | 'capability.denied';

export interface LedgerEvent {
  /** strictly monotonic per store; never reused */
  readonly seq: number;
  readonly at: string;
  readonly kind: LedgerEventKind;
  /** what changed: belief id / skill id / memory id / goal id / model name */
  readonly subject: string;
  readonly detail?: string;
  /** Evidence Ledger v2 lineage linkage */
  readonly runId?: string;
  readonly taskId?: string;
  /** confidence at the time of the event, when applicable */
  readonly confidence?: number;
  /** the event this one answers or revises */
  readonly parentSeq?: number;
  /** Ledger 2.0: the version of the belief after this event (belief.* only) */
  readonly beliefVersion?: number;
}

export interface LedgerSummary {
  total: number;
  byKind: Partial<Record<LedgerEventKind, number>>;
  corruptLinesSkipped: number;
  lastSeq: number;
}

export interface LedgerAppendInput {
  at?: string;
  detail?: string;
  runId?: string;
  taskId?: string;
  confidence?: number;
  parentSeq?: number;
  /** Ledger 2.0: belief version after this event (belief.* kinds) */
  beliefVersion?: number;
}

/** Pure in-memory append-only ledger. Rebuild from persistence with loadLedger. */
export class CognitiveLedger {
  private readonly eventsBySeq: LedgerEvent[] = [];
  private corruptLinesSkipped = 0;

  append(kind: LedgerEventKind, subject: string, input: LedgerAppendInput = {}): LedgerEvent {
    const seq = this.eventsBySeq.length ? this.eventsBySeq[this.eventsBySeq.length - 1].seq + 1 : 1;
    const evt: LedgerEvent = Object.freeze({
      seq,
      at: input.at ?? new Date().toISOString(),
      kind,
      subject,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.parentSeq !== undefined ? { parentSeq: input.parentSeq } : {}),
      ...(input.beliefVersion !== undefined ? { beliefVersion: input.beliefVersion } : {}),
    });
    this.eventsBySeq.push(evt);
    return evt;
  }

  /** Rebuild from raw persistence lines (used by loadLedger). */
  ingest(lines: string[]): void {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Partial<LedgerEvent>;
        if (typeof raw.seq !== 'number' || typeof raw.kind !== 'string' || typeof raw.subject !== 'string') {
          this.corruptLinesSkipped++;
          continue;
        }
        const seq = this.eventsBySeq.length ? this.eventsBySeq[this.eventsBySeq.length - 1].seq + 1 : 1;
        this.eventsBySeq.push(Object.freeze({ ...raw, seq, at: raw.at ?? new Date().toISOString() } as LedgerEvent));
      } catch {
        this.corruptLinesSkipped++;
      }
    }
  }

  events(): readonly LedgerEvent[] {
    return this.eventsBySeq.slice();
  }

  /** Lineage chain: the event with this seq plus every ancestor via parentSeq. */
  chain(seq: number): LedgerEvent[] {
    const out: LedgerEvent[] = [];
    let cursor: LedgerEvent | undefined = this.eventsBySeq.find((e) => e.seq === seq);
    while (cursor) {
      out.unshift(cursor);
      const parent: number | undefined = cursor.parentSeq;
      cursor = parent === undefined ? undefined : this.eventsBySeq.find((e) => e.seq === parent);
    }
    return out;
  }

  /** Ledger 2.0: everything downstream of an event (the replay-from-cause
   *  query - what did this belief revision LEAD to?). Branches included. */
  descendants(seq: number): LedgerEvent[] {
    const childrenOf = new Map<number, LedgerEvent[]>();
    for (const e of this.eventsBySeq) {
      if (e.parentSeq === undefined) continue;
      const list = childrenOf.get(e.parentSeq) ?? [];
      list.push(e);
      childrenOf.set(e.parentSeq, list);
    }
    const out: LedgerEvent[] = [];
    const queue = [seq];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        out.push(child);
        queue.push(child.seq);
      }
    }
    return out;
  }

  summary(): LedgerSummary {
    const byKind: Partial<Record<LedgerEventKind, number>> = {};
    for (const e of this.eventsBySeq) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return {
      total: this.eventsBySeq.length,
      byKind,
      corruptLinesSkipped: this.corruptLinesSkipped,
      lastSeq: this.eventsBySeq.length ? this.eventsBySeq[this.eventsBySeq.length - 1].seq : 0,
    };
  }
}

export function ledgerPath(home: string): string {
  return join(home, 'cognitive', 'ledger.jsonl');
}

/** Load the persisted ledger. Absent = empty; corrupt lines are skipped and counted. */
export async function loadLedger(home: string): Promise<CognitiveLedger> {
  const ledger = new CognitiveLedger();
  let text = '';
  try {
    text = await readFile(ledgerPath(home), 'utf8');
  } catch {
    return ledger; // absent = fresh ledger, never a crash
  }
  ledger.ingest(text.split('\n'));
  return ledger;
}

/** Append one event to the persisted store (one JSON line). */
export async function appendLedgerEvent(home: string, evt: LedgerEvent): Promise<void> {
  await mkdir(join(home, 'cognitive'), { recursive: true });
  await appendFile(ledgerPath(home), JSON.stringify(evt) + '\n', 'utf8');
}
