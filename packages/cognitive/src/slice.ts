/**
 * @hmharness/cognitive - vertical cognitive slice (review P0-2, 2026-10-03)
 *
 * The modules existed but as HORIZONTAL pieces; this file chains ONE real
 * task through the full cognitive pipeline, every stage leaving evidence:
 *
 *   Observe (environment/workspace) -> WorldModel view
 *   -> Goal (registered + decomposed from the task text)
 *   -> Plan (world-model digest = what the planner may trust)
 *   -> Act (host-bridged REAL execution — the agent loop, real tools)
 *   -> Evaluate (INDEPENDENT verdict: host checker or structural check;
 *      the agent's own claim is recorded as a CLAIM, never as evidence)
 *   -> Learn (WM replay from the trajectory, memory entry keyed to the
 *      INDEPENDENT verdict, diagnosis line for the next round)
 *
 * The slice REPORT is the audit unit: each stage names what it did and
 * what evidence it produced. Nothing here promotes skills — learning
 * outcomes flow into the existing gated pipelines (evaluator
 * independence, blueprint §9 / review P0-3).
 */
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { CognitiveMemory } from './memory.ts';
import { buildContextDigest, loadTrajectories, replayIntoWorldModel, diagnoseOpportunities } from './analysis.ts';
import { loadCrowdPriors } from './crowd.ts';

export interface SliceStage {
  stage: 'observe' | 'goal' | 'plan' | 'act' | 'evaluate' | 'learn';
  ok: boolean;
  detail: string;
  /** machine-checkable proof artifact per stage (ids, counts, hashes) */
  evidence: Record<string, unknown>;
}

export interface SliceOptions {
  home: string;
  task: string;
  cwd: string;
  /** REAL execution: host bridges to the agent loop (runAgentTask). Must
   *  return the agent's own completion claim + the trajectory id it left. */
  act: () => Promise<{ completed: boolean; claim: string; trajectoryId?: string; turns?: number; toolUses?: number }>;
  /** INDEPENDENT evaluation (review P0-3): runs AFTER act, claim-blind.
   *  The contract below is the separation wall — see IndependentEvaluator. */
  evaluate?: IndependentEvaluator;
}

/**
 * Review P0-3: the evaluator must be structurally SEPARATE from the agent's
 * self-assessment. This contract is the wall:
 *  - the evaluator receives the TASK and the WORKSPACE, never the agent's
 *    claim, turns or tool transcript (claim-blind by construction);
 *  - the verdict's `source` travels with every downstream artifact so a
 *    structural fallback can never masquerade as independent judgment;
 *  - agent self-reports are recorded (in the report) but CANNOT satisfy a
 *    SuccessCriterion — only an IndependentEvaluator (or a future holdout
 *    harness) can.
 */
export interface IndependentEvaluator {
  readonly kind: 'independent-evaluator';
  /** claim-blind by construction: inputs are task + workspace only */
  run(task: string, cwd: string): Promise<{ pass: boolean; reasons: string[] }>;
}

/** Wrap a plain checker into the evaluator contract (asserts claim-blindness
 *  at the type level: the checker signature cannot even receive the claim). */
export function independentEvaluator(run: (task: string, cwd: string) => Promise<{ pass: boolean; reasons: string[] }>): IndependentEvaluator {
  return { kind: 'independent-evaluator', run };
}

export interface SliceReport {
  task: string;
  startedAt: string;
  stages: SliceStage[];
  /** the independent verdict — this, not the agent claim, is what Learn keys on */
  verdict: { source: 'independent' | 'structural'; pass: boolean; reasons: string[] };
  agentClaim: { completed: boolean; claim: string };
  goalDrift?: { score: number; signals: string[] };
}

/** Workspace observation WITHOUT any environment adapter: files + sizes of
 *  the task cwd (first two levels) — a deterministic, cheap world fact the
 *  slice can diff after acting. Environment adapters plug in later via the
 *  same stage contract. */
async function observeWorkspace(cwd: string): Promise<{ files: string[]; topCount: number }> {
  const out: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const e of entries.slice(0, 50)) {
      out.push(e.isDirectory() ? e.name + '/' : e.name);
      if (e.isDirectory() && out.length < 50) {
        try {
          const sub = await readdir(join(cwd, e.name), { withFileTypes: true });
          for (const s of sub.slice(0, 10)) out.push(e.name + '/' + (s.isDirectory() ? s.name + '/' : s.name));
        } catch { /* unreadable subdir is a fact, not a failure */ }
      }
    }
  } catch { /* unreadable cwd recorded as zero files */ }
  return { files: out, topCount: out.filter((f) => !f.includes('/')).length };
}

export async function runVerticalSlice(opts: SliceOptions): Promise<SliceReport> {
  const stages: SliceStage[] = [];
  const startedAt = new Date().toISOString();

  // 1. OBSERVE — workspace facts (pre-act snapshot)
  const before = await observeWorkspace(opts.cwd);
  stages.push({ stage: 'observe', ok: true, detail: `${before.files.length} entries observed in cwd`, evidence: { topCount: before.topCount, sample: before.files.slice(0, 8) } });

  // 2. GOAL — register the task as a goal (propose+adopt: user-sourced
  //    tasks are explicit, no approval ambiguity for slice goals)
  const { GoalManager } = await import('./goal.ts');
  const gm = new GoalManager();
  const goal = gm.propose({ id: `goal-slice-${startedAt}`, description: opts.task, source: 'user', priority: 2, constraints: [], successCriteria: [{ id: 'sc-independent', description: 'independent evaluation passes' }] });
  await gm.adopt(goal.id, { approved: true });
  stages.push({ stage: 'goal', ok: true, detail: 'goal registered from task text', evidence: { goalId: goal.id, criteria: 1 } });

  // 3. PLAN — the world-model digest (trusted/flaky tools + crowd priors)
  const digest = await buildContextDigest(opts.home).catch(() => '');
  const priors = await loadCrowdPriors(opts.home).catch(() => null);
  stages.push({ stage: 'plan', ok: digest.length > 0 || Boolean(priors?.sources.length), detail: digest ? 'world-model digest attached to the planning context' : (priors?.sources.length ? 'crowd priors present (digest empty: little local evidence yet)' : 'no digest yet (cold start) — plan proceeds without WM advice'), evidence: { digestChars: digest.length, crowdSources: priors?.sources.length ?? 0 } });

  // 4. ACT — REAL execution through the host bridge
  let actResult: Awaited<ReturnType<SliceOptions['act']>>;
  try {
    actResult = await opts.act();
  } catch (err) {
    actResult = { completed: false, claim: 'act threw: ' + String(err).slice(0, 160) };
  }
  stages.push({ stage: 'act', ok: actResult.completed, detail: actResult.completed ? 'agent loop completed' : 'agent loop did not complete', evidence: { claim: actResult.claim.slice(0, 200), turns: actResult.turns ?? null, toolUses: actResult.toolUses ?? null, trajectoryId: actResult.trajectoryId ?? null } });

  // 5. EVALUATE — INDEPENDENT of the agent (separate phase, claim-blind:
  //  the evaluator contract only receives task + cwd, never the claim)
  let verdict: SliceReport['verdict'];
  if (opts.evaluate) {
    const r = await opts.evaluate.run(opts.task, opts.cwd).catch((e: unknown) => ({ pass: false, reasons: ['evaluator threw: ' + String(e).slice(0, 120)] }));
    verdict = { source: 'independent', pass: r.pass, reasons: r.reasons.slice(0, 5) };
  } else {
    // structural fallback: completion + (from the latest trajectory) no
    // tool failures — explicitly labeled NOT a quality judgment
    const trajectories = await loadTrajectories(opts.home, 1);
    const last = trajectories[0];
    const failed = last ? last.steps.filter((s) => s.outcome === 'failure').length : 0;
    const pass = actResult.completed && failed === 0 && Boolean(last);
    verdict = { source: 'structural', pass, reasons: [`completed=${actResult.completed}`, `toolFailures=${failed}`, `trajectory=${last?.id ?? 'none'}`] };
  }
  stages.push({ stage: 'evaluate', ok: verdict.pass, detail: `verdict (${verdict.source}): ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reasons.join('; ')}`, evidence: { source: verdict.source, reasons: verdict.reasons } });

  // 6. LEARN — WM replay + memory keyed to the INDEPENDENT verdict
  const trajectories = await loadTrajectories(opts.home, 50);
  const latest = actResult.trajectoryId ? trajectories.find((t) => t.id === actResult.trajectoryId) ?? trajectories[0] : trajectories[0];
  const wm = replayIntoWorldModel(trajectories, latest?.environment.id ?? 'terminal');
  const mem = new CognitiveMemory(opts.home);
  await mem.load();
  const entry = await mem.write({
    layer: 'episodic',
    content: `SLICE ${verdict.pass ? 'PASS' : 'FAIL'}(${verdict.source}): ${opts.task.slice(0, 120)}`,
    payload: { verdict, agentClaim: actResult.claim.slice(0, 200), trajectoryId: latest?.id ?? null, digestChars: digest.length },
    source: 'vertical-slice',
    provenance: `slice:${startedAt}`,
    confidence: verdict.source === 'independent' ? (verdict.pass ? 0.9 : 0.85) : 0.6,
    environment: latest?.environment.id ?? 'terminal',
    session: 'vertical-slice',
    tags: ['slice', verdict.source, verdict.pass ? 'pass' : 'fail'],
  });
  const { opportunities } = await diagnoseOpportunities(opts.home).catch(() => ({ opportunities: [] as Array<{ signal: string }> }));
  stages.push({ stage: 'learn', ok: true, detail: `WM replayed (${wm.worldState.beliefs.length} beliefs); memory entry ${entry.id} keyed to the ${verdict.source} verdict`, evidence: { memoryId: entry.id, beliefs: wm.worldState.beliefs.length, opportunities: opportunities.length } });

  return { task: opts.task, startedAt, stages, verdict, agentClaim: { completed: actResult.completed, claim: actResult.claim } };
}

/** Format a slice report for the CLI (auditable, one line per stage). */
export function formatSliceReport(r: SliceReport): string {
  const lines = [`认知纵切片 · ${r.task.slice(0, 60)}`];
  for (const s of r.stages) {
    lines.push(`  ${s.ok ? '✓' : '✗'} ${s.stage.padEnd(9)} ${s.detail}`);
  }
  lines.push(`  裁决: ${r.verdict.pass ? 'PASS' : 'FAIL'} (${r.verdict.source}) — 学步以此为准，agent 自评仅作记录`);
  return lines.join('\n');
}
