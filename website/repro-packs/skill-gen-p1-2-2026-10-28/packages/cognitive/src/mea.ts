/**
 * @hmharness/cognitive - MEA long-task loop (2026-10-04 audit COG-MEA / W3)
 *
 * The audit's 下一核心: instead of adding MORE agent roles horizontally,
 * chain the existing ones into a long-task closed loop:
 *
 *   Manager        decomposes the task into steps with acceptance criteria,
 *                  tracks progress, adapts on failures (bounded replans)
 *   Fresh Executor executes ONE step with a FRESH context — it sees the
 *                  step + a blackboard digest, never previous steps'
 *                  transcripts (no contamination across steps)
 *   Read-only      audits each step CLAIM-BLIND (step + criteria + workspace
 *   Auditor        only — the executor's claim is recorded but can never
 *                  satisfy a criterion; same wall as slice's evaluator)
 *   Learner        after the loop, distills into memory keyed to AUDIT
 *                  verdicts (never executor claims) + replays the WM
 *
 * Every role is a host bridge (testable with fakes; the CLI/agent wires
 * real execution). The loop is evidence-first: each step leaves an audit
 * trail entry with the auditor's verdict and replan decisions.
 */
import { CognitiveMemory } from './memory.ts';
import { loadTrajectories, replayIntoWorldModel } from './analysis.ts';

/* ---------------- contracts ---------------- */

export interface MeaStep {
  id: string;
  description: string;
  /** structural acceptance criteria the AUDITOR checks (claim-blind) */
  acceptance: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  attempts: number;
}

export interface ManagerState {
  task: string;
  steps: MeaStep[];
  replansUsed: number;
  budget: { maxSteps: number; maxReplans: number; maxAttemptsPerStep: number };
  history: MeaHistoryEntry[];
}

export interface MeaHistoryEntry {
  at: string;
  kind: 'decompose' | 'execute' | 'audit' | 'replan' | 'learn';
  stepId?: string;
  detail: string;
  /** audit verdicts carry the evidence; executor claims never do */
  evidence?: { source: 'auditor' | 'manager' | 'learner'; pass?: boolean; reasons?: string[] };
}

/** Fresh executor bridge: receives ONLY the step + digest (no prior transcripts). */
export type FreshExecutor = (step: MeaStep, digest: { done: string[]; remaining: string[] }) => Promise<{ completed: boolean; claim: string }>;

/** Read-only auditor bridge: claim-blind by construction (step + criteria + workspace). */
export type ReadOnlyAuditor = (step: MeaStep) => Promise<{ pass: boolean; reasons: string[] }>;

/** Manager decomposition bridge: task -> steps (each with acceptance criteria). */
export type ManagerDecomposer = (task: string) => Promise<MeaStep[]>;

export interface MeaReport {
  task: string;
  startedAt: string;
  finishedAt: string;
  stepsPassed: number;
  stepsFailed: number;
  replansUsed: number;
  verdict: 'complete' | 'partial' | 'budget-exhausted';
  history: MeaHistoryEntry[];
  memoryEntries: string[];
}

export interface MeaOptions {
  home: string;
  task: string;
  decompose: ManagerDecomposer;
  execute: FreshExecutor;
  audit: ReadOnlyAuditor;
  budget?: Partial<ManagerState['budget']>;
  /** digest source for the fresh executor (defaults to steps' own states) */
  digest?: () => { done: string[]; remaining: string[] };
}

/* ---------------- the loop ---------------- */

export async function runMeaLoop(opts: MeaOptions): Promise<MeaReport> {
  const startedAt = new Date().toISOString();
  const state: ManagerState = {
    task: opts.task,
    steps: [],
    replansUsed: 0,
    budget: {
      maxSteps: opts.budget?.maxSteps ?? 10,
      maxReplans: opts.budget?.maxReplans ?? 2,
      maxAttemptsPerStep: opts.budget?.maxAttemptsPerStep ?? 2,
    },
    history: [],
  };

  // 1. MANAGER: decompose
  state.steps = (await opts.decompose(opts.task)).slice(0, state.budget.maxSteps);
  state.history.push({ at: new Date().toISOString(), kind: 'decompose', detail: `${state.steps.length} steps decomposed (cap ${state.budget.maxSteps})`, evidence: { source: 'manager' } });

  const digest = opts.digest ?? (() => ({
    done: state.steps.filter((s) => s.status === 'passed').map((s) => s.description),
    remaining: state.steps.filter((s) => s.status === 'pending').map((s) => s.description),
  }));

  // 2. STEP LOOP: fresh executor -> read-only auditor per step
  for (const step of state.steps) {
    if (step.status !== 'pending') continue;
    step.status = 'running';
    while (step.attempts < state.budget.maxAttemptsPerStep) {
      step.attempts += 1;
      // FRESH EXECUTOR: fresh context — only this step + digest
      const exec = await opts.execute(step, digest()).catch((e: unknown) => ({ completed: false, claim: 'executor threw: ' + String(e).slice(0, 100) }));
      state.history.push({ at: new Date().toISOString(), kind: 'execute', stepId: step.id, detail: `attempt ${step.attempts}: claim="${exec.claim.slice(0, 120)}"` });
      // READ-ONLY AUDITOR: claim-blind — the claim is NOT passed in
      const verdict = await opts.audit(step).catch((e: unknown) => ({ pass: false, reasons: ['auditor threw: ' + String(e).slice(0, 80)] }));
      state.history.push({ at: new Date().toISOString(), kind: 'audit', stepId: step.id, detail: verdict.pass ? 'PASS' : `FAIL: ${verdict.reasons.join('; ').slice(0, 120)}`, evidence: { source: 'auditor', pass: verdict.pass, reasons: verdict.reasons } });
      if (verdict.pass) { step.status = 'passed'; break; }
    }
    if (step.status === 'running') {
      step.status = 'failed';
      // MANAGER ADAPTATION: bounded replan — retry the failed step once as a
      // revised child step before giving up (real managers re-decompose; the
      // contract here is the BOUND, hosts may implement smarter adaptation)
      if (state.replansUsed < state.budget.maxReplans) {
        state.replansUsed += 1;
        const revised: MeaStep = { id: `${step.id}-r${state.replansUsed}`, description: `revise: ${step.description}`, acceptance: step.acceptance, status: 'pending', attempts: 0 };
        state.steps.splice(state.steps.indexOf(step) + 1, 0, revised);
        state.history.push({ at: new Date().toISOString(), kind: 'replan', stepId: step.id, detail: `replan #${state.replansUsed}: revised step ${revised.id} inserted`, evidence: { source: 'manager' } });
      }
    }
  }

  const passed = state.steps.filter((s) => s.status === 'passed').length;
  const failed = state.steps.filter((s) => s.status === 'failed').length;
  const verdict: MeaReport['verdict'] = failed === 0 ? 'complete' : passed > 0 ? 'partial' : 'budget-exhausted';

  // 3. LEARNER: memory keyed to AUDIT verdicts (never executor claims)
  const mem = new CognitiveMemory(opts.home);
  await mem.load();
  const memoryEntries: string[] = [];
  const entry = await mem.write({
    layer: 'episodic',
    content: `MEA ${verdict}: ${opts.task.slice(0, 100)} — ${passed} passed / ${failed} failed / ${state.replansUsed} replans`,
    payload: { verdict, passed, failed, replans: state.replansUsed, history: state.history.filter((h) => h.kind === 'audit').map((h) => ({ step: h.stepId, pass: h.evidence?.pass })) },
    source: 'mea-loop',
    provenance: `mea:${startedAt}`,
    confidence: verdict === 'complete' ? 0.9 : 0.6,
    environment: 'terminal',
    session: 'mea',
    tags: ['mea', verdict],
  });
  memoryEntries.push(entry.id);
  state.history.push({ at: new Date().toISOString(), kind: 'learn', detail: `memory entry ${entry.id} keyed to ${verdict} (audit verdicts, not claims)`, evidence: { source: 'learner' } });

  // WM replay from whatever trajectories the executors left
  const trajectories = await loadTrajectories(opts.home, 50);
  const wm = replayIntoWorldModel(trajectories, 'terminal');

  return {
    task: opts.task,
    startedAt,
    finishedAt: new Date().toISOString(),
    stepsPassed: passed,
    stepsFailed: failed,
    replansUsed: state.replansUsed,
    verdict,
    history: state.history,
    memoryEntries,
  };
}

/** Format for CLI display. */
export function formatMeaReport(r: MeaReport): string {
  const lines = [`MEA 闭环 · ${r.task.slice(0, 60)}`, `  裁决: ${r.verdict}（${r.stepsPassed} 过 / ${r.stepsFailed} 败 / ${r.replansUsed} 重规划）`];
  for (const h of r.history) {
    if (h.kind === 'audit') lines.push(`  ${h.evidence?.pass ? '✓' : '✗'} ${h.kind.padEnd(9)} ${h.stepId ?? ''} ${h.detail.slice(0, 80)}`);
    else if (h.kind !== 'execute') lines.push(`  · ${h.kind.padEnd(9)} ${h.detail.slice(0, 90)}`);
  }
  lines.push(`  学步键定审计裁决（executor 自评仅记录）; WM 重放完成`);
  return lines.join('\n');
}
