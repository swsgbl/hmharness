/**
 * @hmharness/agent - pipeline runtime (V3 first slice, ADR-0006)
 * Blueprint V3 DoD chain, staged: plan → code → test → review → judge, with
 * a bounded repair loop back to code+test on a FAIL verdict. Each stage is a
 * runLoop call carrying the M7 role charter; the judge's `VERDICT: PASS|FAIL`
 * line is the ONLY stage gate. Mechanical assertions run before any LLM judge
 * (M2 evidence-ladder order, applied to orchestration).
 *
 * Everything lands as evidence: per-stage report (HMH_HOME/pipelines/<id>/)
 * plus the M1 trajectories each runLoop already records.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLoop, type ChatMessage, type LoopResult, type ProviderConfig, type Registry, type ToolContext } from '@hmharness/kernel';
import { buildSystemPrompt } from './prompt.ts';
import { roleCharter } from './roles.ts';
import type { DeviceTestOptions, DeviceTestStep } from '@hmharness/domain-harmony';

export type PipelineStage = 'plan' | 'code' | 'test' | 'review' | 'judge' | 'device';
/** stage labels used in runStage (repairer = the repair-loop role) */
export type StageRole = PipelineStage | 'repairer';

export interface StageRecord {
  stage: StageRole;
  attempt: number;
  verdict: 'PASS' | 'FAIL' | 'n/a';
  text: string;
  turns: number;
  toolUses: number;
  reason: LoopResult['reason'];
}

export interface PipelineReport {
  pipelineId: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'budget' | 'error';
  finalVerdict: 'PASS' | 'FAIL' | 'none';
  stages: StageRecord[];
  repairsUsed: number;
}

export interface PipelineOptions {
  task: string;
  provider: ProviderConfig;
  registry: Registry;
  ctx: ToolContext;
  model: string;
  home: string;
  locale?: string;
  /** per-stage turn cap (default 6) */
  maxTurnsPerStage?: number;
  /** repair-loop ceiling on FAIL verdicts (default 2) */
  maxRepairs?: number;
  /** hard global turn budget across stages (default 24) */
  maxTotalTurns?: number;
  signal?: AbortSignal;
  /** injectable loop (tests); default kernel runLoop */
  runLoopImpl?: typeof runLoop;
  /** V3 device gate (ADR-0007): when set, run an on-device install/launch/
   *  log-marker/uninstall pass after the test stage and feed the four steps
   *  to the judge as mechanical evidence. Pure command execution - no model
   *  turns. */
  deviceGate?: {
    hdc: string;
    target?: string;
    hap: string;
    bundle: string;
    ability: string;
    expectLog: string;
    /** injectable runner (tests); default = domain-harmony runDeviceTest */
    runDeviceTestImpl?: (o: DeviceTestOptions) => Promise<DeviceTestStep[]>;
  };
}

/** Pull the judge's verdict line out of the final text; absence = FAIL
 *  (an judge that did not follow the contract did not render a verdict). */
export function parseVerdict(text: string): 'PASS' | 'FAIL' {
  const m = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  return m ? (m[1].toUpperCase() as 'PASS' | 'FAIL') : 'FAIL';
}

/** Mechanical test gate (M2 ladder order): pure function, no model call.
 *  Returns null when there is nothing mechanical to assert. */
export function mechanicalGate(
  outputs: Array<{ name: string; output: string; isError: boolean }>,
  asserts?: Array<{ kind: 'contains' | 'not-contains'; value: string }>,
): { pass: boolean; detail: string } | null {
  const failedTool = outputs.find((o) => o.isError);
  if (asserts && asserts.length > 0) {
    for (const a of asserts) {
      const hit = outputs.some((o) => o.output.toLowerCase().includes(a.value.toLowerCase()));
      if (a.kind === 'contains' && !hit) return { pass: false, detail: `mechanical: expected "${a.value}" in outputs` };
      if (a.kind === 'not-contains' && hit) return { pass: false, detail: `mechanical: forbidden "${a.value}" present` };
    }
    return { pass: true, detail: `mechanical assertions green (${asserts.length})` };
  }
  if (failedTool) return { pass: false, detail: `mechanical: tool ${failedTool.name} errored` };
  return null;
}

function stageMessages(opts: PipelineOptions, role: StageRole, directive: string): ChatMessage[] {
  const charter = roleCharter(role);
  const system = buildSystemPrompt({
    cwd: opts.ctx.cwd,
    home: opts.home,
    memory: '',
    skills: '',
    insights: '',
    model: opts.model,
    ...(opts.locale ? { locale: opts.locale } : {}),
  }) + (charter ? '\n\n' + charter : '');
  return [
    { role: 'system', content: system },
    { role: 'user', content: directive },
  ];
}

const DIRECTIVES: Record<Exclude<PipelineStage, 'device'>, (task: string, extra: string) => string> = {
  plan: (task) => `Goal: ${task}\nProduce the numbered implementation plan (each step names its verification). Do not execute anything.`,
  code: (task, extra) => `Goal: ${task}\n${extra}\nImplement the plan now (surgical edits, cheapest verification per step).`,
  test: (task, extra) => `Goal: ${task}\n${extra}\nRun the verifications from the plan; probe edge cases; report input -> actual vs expected for each probe.`,
  review: (_task, extra) => `Review the changes produced so far on disk.\n${extra}\nFindings first, severity-ordered, file:line evidence, no fixes.`,
  judge: (_task, extra) => `Render the verdict for this pipeline run from EVIDENCE only.\n${extra}\nEnd with exactly "VERDICT: PASS" or "VERDICT: FAIL" plus one line why.`,
};

export async function runPipeline(opts: PipelineOptions): Promise<PipelineReport> {
  const maxTurns = opts.maxTurnsPerStage ?? 6;
  const maxRepairs = opts.maxRepairs ?? 2;
  const totalBudget = opts.maxTotalTurns ?? 24;
  const run = opts.runLoopImpl ?? runLoop;
  const pipelineId = `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(opts.home, 'pipelines', pipelineId);
  await mkdir(dir, { recursive: true });

  const stages: StageRecord[] = [];
  let repairs = 0;
  let spent = 0;
  let status: PipelineReport['status'] = 'completed';
  const startedAt = new Date().toISOString();

  const runStage = async (stage: StageRole, attempt: number, directive: string): Promise<StageRecord> => {
    // maxTurns is only a soft checkpoint in the kernel loop - the HARD caps
    // are maxTotalTurns (clamped to this stage's remaining budget share) and
    // a tightened idle detector, so one rambling stage cannot eat the whole
    // pipeline budget (real smoke: review burned 47 turns without them).
    const remaining = Math.max(1, totalBudget - spent);
    const r = await run({
      provider: opts.provider,
      registry: opts.registry,
      messages: stageMessages(opts, stage, directive),
      ctx: opts.ctx,
      maxTurns,
      maxTotalTurns: Math.min(maxTurns, remaining),
      maxIdleTurns: stage === 'plan' ? 3 : 4,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    spent += r.turns;
    const rec: StageRecord = {
      stage,
      attempt,
      verdict: stage === 'judge' ? parseVerdict(r.text) : 'n/a',
      text: r.text.slice(0, 4000),
      turns: r.turns,
      toolUses: r.toolUses,
      reason: r.reason,
    };
    stages.push(rec);
    try {
      await writeFile(join(dir, `stage-${String(stages.length).padStart(2, '0')}-${stage}.json`), JSON.stringify(rec, null, 2) + '\n', 'utf8');
    } catch { /* best-effort persistence */ }
    return rec;
  };

  /** Device gate: run the four-step on-device pass, record it as a 'device'
   *  stage (no model turns spent), and mirror it into the repair context.
   *  Defined BEFORE the try block - the try body calls it (TDZ otherwise). */
  const runDeviceGate = async (): Promise<void> => {
    const g = opts.deviceGate!;
    const runner = g.runDeviceTestImpl ?? (await import('@hmharness/domain-harmony')).runDeviceTest;
    let steps: DeviceTestStep[];
    try {
      steps = await runner({ hdc: g.hdc, ...(g.target ? { target: g.target } : {}), hap: g.hap, bundle: g.bundle, ability: g.ability, expectLog: g.expectLog });
    } catch (err) {
      steps = [{ step: 'device-gate', pass: false, detail: String(err).slice(0, 300) }];
    }
    const allPass = steps.every((s) => s.pass);
    const rec: StageRecord = {
      stage: 'device',
      attempt: repairs + 1,
      verdict: allPass ? 'PASS' : 'FAIL',
      text: steps.map((s) => `${s.pass ? 'PASS' : 'FAIL'} ${s.step}: ${s.detail}`).join('\n').slice(0, 4000),
      turns: 0,
      toolUses: 0,
      reason: 'final',
    };
    stages.push(rec);
    try {
      await writeFile(join(dir, `stage-${String(stages.length).padStart(2, '0')}-device.json`), JSON.stringify(rec, null, 2) + '\n', 'utf8');
    } catch { /* best-effort */ }
  };

  try {
    // 1. plan
    const plan = await runStage('plan', 1, DIRECTIVES.plan(opts.task, ''));
    if (spent >= totalBudget) { status = 'budget'; return await finish(); }
    // 2. code (carries the plan)
    await runStage('code', 1, DIRECTIVES.code(opts.task, `Approved plan:\n${plan.text.slice(0, 2000)}`));
    if (spent >= totalBudget) { status = 'budget'; return await finish(); }

    // 3. test + repair loop (code+test rerun carries the reviewer/judge findings)
    let testOut = await runStage('test', 1, DIRECTIVES.test(opts.task, `Plan:\n${plan.text.slice(0, 1500)}`));
    if (spent >= totalBudget) { status = 'budget'; return await finish(); }
    // 3b. device gate (V3 slice, ADR-0007): mechanical on-device evidence,
    // zero model turns; judge sees it in the evidence summary
    if (opts.deviceGate) await runDeviceGate();
    let review = await runStage('review', 1, DIRECTIVES.review(opts.task, ''));
    if (spent >= totalBudget) { status = 'budget'; return await finish(); }
    let judge = await runStage('judge', 1, DIRECTIVES.judge(opts.task, evidenceSummary(stages)));
    while (judge.verdict === 'FAIL' && repairs < maxRepairs && spent < totalBudget) {
      repairs++;
      const findings = `${review.text.slice(0, 800)}\n\nJudge findings:\n${judge.text.slice(0, 800)}`;
      await runStage('repairer', repairs, `Repair round ${repairs}.\n${findings}\nReproduce, fix minimally, re-verify.`);
      if (spent >= totalBudget) { status = 'budget'; break; }
      testOut = await runStage('test', repairs + 1, DIRECTIVES.test(opts.task, `Plan:\n${plan.text.slice(0, 1500)}\nRepair ${repairs} applied - re-verify.`));
      if (opts.deviceGate) await runDeviceGate();
      review = await runStage('review', repairs + 1, DIRECTIVES.review(opts.task, `Repair ${repairs} was applied; focus on it.`));
      if (spent >= totalBudget) { status = 'budget'; break; }
      judge = await runStage('judge', repairs + 1, DIRECTIVES.judge(opts.task, evidenceSummary(stages)));
    }

    return await finish(judge && judge.verdict !== 'n/a' ? judge.verdict : 'FAIL');
  } catch (err) {
    status = 'error';
    stages.push({ stage: 'judge' as PipelineStage, attempt: 0, verdict: 'FAIL', text: String(err).slice(0, 500), turns: 0, toolUses: 0, reason: 'final' });
    return await finish('FAIL');
  }

  async function finish(verdict: PipelineReport['finalVerdict'] = 'none'): Promise<PipelineReport> {    const report: PipelineReport = {
      pipelineId,
      task: opts.task,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      finalVerdict: verdict,
      stages,
      repairsUsed: repairs,
    };
    try { await writeFile(join(dir, 'pipeline.report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); } catch { /* best-effort */ }
    return report;
  }
}

function evidenceSummary(stages: StageRecord[]): string {
  const relevant = stages.filter((s) => s.stage === 'test' || s.stage === 'review' || s.stage === 'device');
  return relevant.map((s) => `[${s.stage} #${s.attempt}] ${s.text.slice(0, 600)}`).join('\n\n').slice(0, 3000);
}
