/**
 * @hmharness/cognitive - Cognitive Credit Assignment v0 (upgrade pack §15)
 *
 * The question the pack poses: when performance changes, WHICH cognitive
 * change contributed? v0 answers with the same discipline WM-2 established
 * for observational causal mining - it RANKS co-occurrence, it does not
 * claim causation:
 *
 *   For each prediction.confirmed / prediction.failed event in the ledger,
 *   look back a window of W events; for every contributor kind (belief
 *   revision, skill promotion, memory promotion, exploration, model
 *   routing...) count its presence. The kind's association is
 *
 *     P(confirmed | kind present in window) - P(confirmed | absent)
 *
 *   - an observational lift, exactly the wm-causal semantics, carried over
 *   - kinds with support below minSupport report insufficient-evidence
 *     instead of a number (small-sample honesty)
 *   - the report is labeled nature:'observational' BY CONSTRUCTION; a
 *     causal claim would require interventional replay (later work)
 */
import type { CognitiveLedger, LedgerEvent, LedgerEventKind } from './ledger.ts';

export const CONTRIBUTOR_KINDS: readonly LedgerEventKind[] = [
  'belief.created',
  'belief.revised',
  'exploration.chosen',
  'skill.candidate',
  'skill.promoted',
  'skill.rejected',
  'memory.promoted',
  'memory.contradicted',
  'goal.revised',
  'model.routed',
  'capability.denied',
  'observation.recorded',
];

export interface ContributorAttribution {
  kind: LedgerEventKind;
  /** windows in which the kind appeared */
  presentWindows: number;
  /** prediction.confirmed share when present vs absent - observational lift */
  association: number;
  confirmedWhenPresent: number;
  confirmedWhenAbsent: number;
  absentWindows: number;
  support: number;
  /** true when support < minSupport - no number is trusted */
  insufficientEvidence: boolean;
}

export interface CreditReport {
  /** by construction - this v0 ranks co-occurrence, it does not claim causation */
  nature: 'observational';
  windowSize: number;
  outcomeEvents: number;
  baselineConfirmedRate: number;
  ranked: ContributorAttribution[];
}

export interface CreditOptions {
  /** how many preceding events count as the attribution window */
  windowSize?: number;
  /** minimum present-windows before an association is reported */
  minSupport?: number;
}

interface OutcomeTally {
  presentConfirmed: number;
  presentTotal: number;
  absentConfirmed: number;
  absentTotal: number;
}

export function assignCredit(ledger: CognitiveLedger, opts: CreditOptions = {}): CreditReport {
  const W = opts.windowSize ?? 5;
  const minSupport = opts.minSupport ?? 3;
  const events = ledger.events();
  const tallies = new Map<LedgerEventKind, OutcomeTally>();
  let outcomeEvents = 0;
  let confirmedTotal = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'prediction.confirmed' && e.kind !== 'prediction.failed') continue;
    outcomeEvents++;
    const confirmed = e.kind === 'prediction.confirmed';
    if (confirmed) confirmedTotal++;
    const window: LedgerEvent[] = events.slice(Math.max(0, i - W), i);
    const kindsPresent = new Set(window.map((w) => w.kind));
    for (const kind of CONTRIBUTOR_KINDS) {
      let t = tallies.get(kind);
      if (!t) { t = { presentConfirmed: 0, presentTotal: 0, absentConfirmed: 0, absentTotal: 0 }; tallies.set(kind, t); }
      if (kindsPresent.has(kind)) {
        t.presentTotal++;
        if (confirmed) t.presentConfirmed++;
      } else {
        t.absentTotal++;
        if (confirmed) t.absentConfirmed++;
      }
    }
  }

  const baseline = outcomeEvents > 0 ? confirmedTotal / outcomeEvents : 0;
  const ranked: ContributorAttribution[] = [];
  for (const [kind, t] of tallies) {
    const support = t.presentTotal;
    if (support === 0) continue; // never co-occurred - nothing to say
    const pPresent = t.presentTotal > 0 ? t.presentConfirmed / t.presentTotal : 0;
    const pAbsent = t.absentTotal > 0 ? t.absentConfirmed / t.absentTotal : 0;
    const insufficient = support < minSupport;
    ranked.push({
      kind,
      presentWindows: support,
      absentWindows: t.absentTotal,
      confirmedWhenPresent: t.presentConfirmed,
      confirmedWhenAbsent: t.absentConfirmed,
      association: insufficient ? 0 : Number((pPresent - pAbsent).toFixed(3)),
      support,
      insufficientEvidence: insufficient,
    });
  }
  ranked.sort((a, b) => Math.abs(b.association) - Math.abs(a.association) || b.support - a.support);
  return {
    nature: 'observational',
    windowSize: W,
    outcomeEvents,
    baselineConfirmedRate: Number(baseline.toFixed(3)),
    ranked,
  };
}
