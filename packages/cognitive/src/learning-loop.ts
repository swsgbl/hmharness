/**
 * @hmharness/cognitive - learning loop (blueprint M8 / CL-005 live)
 *
 * Closes the harness-level learning ring over REAL data:
 *   diagnose (analysis.ts, live trajectories)
 *     -> train: for memory-target opportunities, distill the failing runs
 *        into semantic memory entries (full provenance) AND an evolution
 *        memory note so the NEXT task's retrieval injection can use them
 *     -> promotion is NOT taken here: candidates flow into the existing
 *        evolve bench pipeline (train/holdout gates) — this loop never
 *        self-promotes (evaluator independence, blueprint §9).
 */
import { CognitiveMemory } from './memory.ts';
import { diagnoseOpportunities } from './analysis.ts';

export interface LearnOutcome {
  opportunityId: string;
  signal: string;
  trained: boolean;
  memoryEntries: string[];
  note: 'promotion continues through the evolve bench pipeline (train/holdout gates)';
}

export interface LearnReport {
  trajectories: number;
  opportunities: number;
  trained: number;
  outcomes: LearnOutcome[];
}

/** The real trainer for memory-target opportunities: distill failing runs
 *  into semantic memory with provenance + an evolution note for retrieval. */
export async function runLearningLoop(home: string, opts: { writeEvolutionNote?: (note: string) => Promise<void> } = {}): Promise<LearnReport> {
  const { opportunities, trajectories } = await diagnoseOpportunities(home);
  const mem = new CognitiveMemory(home);
  await mem.load();
  const outcomes: LearnOutcome[] = [];
  let trained = 0;
  for (const opp of opportunities) {
    if (!opp.suggestedTargets.includes('memory')) {
      outcomes.push({ opportunityId: opp.id, signal: opp.signal, trained: false, memoryEntries: [], note: 'promotion continues through the evolve bench pipeline (train/holdout gates)' });
      continue;
    }
    // distill: the signal IS the lesson (deterministic; the LLM refinement
    // layer can polish wording later — provenance is what cannot be faked)
    const content = `[lesson] ${opp.signal} — address via ${opp.suggestedTargets.join('/')}`;
    const entry = await mem.write({
      layer: 'semantic',
      content,
      payload: { opportunityId: opp.id, evidence: opp.evidence },
      source: 'learning-loop',
      provenance: `opportunity:${opp.id}`,
      confidence: Math.min(0.85, 0.5 + opp.evidence.value / 20),
      environment: 'terminal',
      session: 'learning-loop',
      tags: ['lesson', ...opp.suggestedTargets],
    });
    await opts.writeEvolutionNote?.(content).catch(() => undefined);
    trained += 1;
    outcomes.push({ opportunityId: opp.id, signal: opp.signal, trained: true, memoryEntries: [entry.id], note: 'promotion continues through the evolve bench pipeline (train/holdout gates)' });
  }
  return { trajectories, opportunities: opportunities.length, trained, outcomes };
}
