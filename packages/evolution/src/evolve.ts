/**
 * @hmharness/evolution - evolve
 * The evolution loop, one cycle per invocation (schedule it however you
 * like). Pipeline: mine insights -> propose skill drafts via a meta-model
 * call -> bench A/B (baseline vs candidate injection) -> promote or reject
 * -> append-only memory distillation -> everything logged to
 * evolution/log.jsonl.
 *
 * Guardrails baked in (DGM/GDPevo/ICLR-misevolve lessons):
 *  - drafts are never injected into real sessions; only promotion changes
 *    behavior, and only after the bench shows no regression
 *  - the loop writes only under skills/ and memory/ - it cannot touch
 *    config, security settings, or code
 *  - memory is append-only (ACE: rewriting is how context gets lost)
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, loadConfig, type ProviderConfig } from '@hmharness/kernel';
import { listCases, matchCase, seedCases, type BenchCase } from './bench.ts';
import { deleteDraft, listCanary, listDrafts, listSkills, promoteSkill, rollbackSkill, skillsToPrompt, unpromoteSkill, writeDraft } from './skills.ts';
import { appendMemory, readNotes } from './memory.ts';
import { readInsights } from './insights.ts';
import { readBudget, recordParetoEntry, readParetoEntries, sampleAncestor, impactReport, decayUnusedSkills } from './impact.ts';

export interface SkillProposal {
  name: string;
  description: string;
  skill_md: string;
}

export interface ProposalOutcome {
  name: string;
  action: 'promoted' | 'rejected' | 'error';
  reason: string;
  baseline?: { passRate: number; cases: string };
  candidate?: { passRate: number; cases: string };
  holdout?: { baselineRate: number; candidateRate: number };
  /** P0 lineage ledger: what fed this decision (provenance for impact
   *  attribution - which insights produced which skill, with which scores).
   *  Evolution-artifact genealogy is the GEPA/DGM archive lesson: decisions
   *  without ancestry cannot be audited for objective hacking. */
  lineage?: {
    parentInsights: string[];
    scores: { train: number; holdout?: number };
    metaModel: string;
    decidedAt: string;
  };
}

export interface EvolveReport {
  time: string;
  model: string;
  seededCases: string[];
  insightCount: number;
  noteCount: number;
  proposals: SkillProposal[];
  outcomes: ProposalOutcome[];
  memoryDistilled: string | null;
  /** code-level evolution: proposed patches (DGM bridge) */
  codePatches?: Array<{ name: string; file: string; reason: string }>;
  /** code-level outcomes: merged/reverted/error per patch */
  patchOutcomes?: Array<{ name: string; action: string; reason: string; branch?: string }>;
  /** P0 impact attribution: canary A/B comparison applied this cycle */
  impact?: { rows: Array<{ skill: string; exposed: string; control: string; verdict: string }>; applied: string[] };
  /** P1 lifecycle: skills moved to dormant this cycle */
  decayed?: string[];
  /** budget state at cycle start (observability) */
  budget?: { cyclesToday: number; maxCyclesPerDay?: number };
  /** chars/4 estimate of this cycle's meta-call traffic; feeds the daily
   *  token budget gate (readBudget sums today's entries) */
  estTokens?: number;
}

/** Runs one bench case with the given skills block injected. */
export type CaseRunner = (c: BenchCase, skillsPrompt: string) => Promise<string>;

/** One bench run through the structured assertion (upgraded gate: exact/
 *  regex/none/any modes, not just substrings). Also returns the raw output
 *  so callers can cost-cap (verbose-but-passing candidates). */
async function runAndAssert(runCase: CaseRunner, c: BenchCase, injection: string): Promise<{ pass: boolean; output: string }> {
  const output = await runCase(c, injection);
  return { pass: matchCase(output, c).pass, output };
}

/** Rough token estimate, language-aware: ASCII runs ~4 chars/token, CJK
 * ~1 char/token. A flat chars/4 undercounted Chinese 2-4x, letting verbose
 * zh candidates dodge the cost cap. Used on BOTH sides of every comparison
 * (baseline and candidate), never as the only rejection reason (the
 * pass-rate gate decides; cost-cap only vetoes pass-by-rambling). */
export function estTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

export async function runEvolution(opts: {
  home: string;
  provider: ProviderConfig;
  runCase: CaseRunner;
  maxProposals?: number;
  /** Skip the meta-model call and evaluate these proposals directly (tests / future UIs). */
  presetProposals?: SkillProposal[];
  log?: (line: string) => void;
}): Promise<EvolveReport> {
  const { home, provider, runCase } = opts;
  const maxProposals = opts.maxProposals ?? 2;
  const say = opts.log ?? (() => undefined);
  const report: EvolveReport = {
    time: new Date().toISOString(),
    model: provider.model,
    seededCases: [],
    insightCount: 0,
    noteCount: 0,
    proposals: [],
    outcomes: [],
    memoryDistilled: null,
  };

  // P0 evolution budget gate (AZR "safety alarms" + cost control): a day's
  // cycle count and a token ceiling live in config; overspending skips the
  // cycle instead of burning money unattended. The token gate compares the
  // summed estTokens of today's logged cycles against maxCyclesPerDay *
  // maxTokensPerCycle (the old code read maxTokensPerCycle but never checked
  // anything but cycles - the documented budget was decorative).
  const budget = await readBudget(home);
  const today = new Date().toISOString().slice(0, 10);
  // Skipped cycles ARE data (SELFFEED honesty rule #2: absent/empty days must
  // be visible). The early returns used to bypass the durable log entirely -
  // a day's skips vanished without a trace and "0 skips" was unauditable
  // (caught by the day-16 meta-audit). Persist before returning.
  const persistSkip = async () => {
    report.estTokens = 0;
    const logDir = join(home, 'evolution');
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, 'log.jsonl'), JSON.stringify(report) + '\n', 'utf8');
  };
  if (budget.maxCyclesPerDay && budget.cyclesToday >= budget.maxCyclesPerDay) {
    report.outcomes.push({ name: '(budget)', action: 'error', reason: `daily cycle limit reached (${budget.cyclesToday}/${budget.maxCyclesPerDay} today) - skipped` });
    await persistSkip();
    return report;
  }
  if (budget.maxCyclesPerDay && budget.maxTokensPerCycle) {
    const dailyCap = budget.maxCyclesPerDay * budget.maxTokensPerCycle;
    if ((budget.tokensToday ?? 0) >= dailyCap) {
      report.outcomes.push({ name: '(budget)', action: 'error', reason: `daily token limit reached (~${budget.tokensToday}/${dailyCap} est-tokens today) - skipped` });
      await persistSkip();
      return report;
    }
  }

  // 1. Seed bench cases on a fresh home so the gate always has a signal.
  report.seededCases = await seedCases(home);
  const cases = await listCases(home);
  const train = cases.filter((c) => !c.holdout);
  const holdout = cases.filter((c) => c.holdout);
  if (train.length === 0) {
    report.outcomes.push({ name: '(bench)', action: 'error', reason: 'no train bench cases available' });
    return report;
  }

  // 2. Gather evolution signals.
  const insights = await readInsights(home, 40);
  const notes = await readNotes(home);
  const active = await listSkills(home);
  const drafts = await listDrafts(home);
  const canary = await listCanary(home);
  report.insightCount = insights.length;
  report.noteCount = notes.length;
  const insightIds = insights.map((i) => `${i.time.slice(0, 16)}:${i.session.slice(-6)}`);
  const toolCounts: Record<string, number> = {};
  for (const i of insights) for (const t of i.toolsUsed) toolCounts[t] = (toolCounts[t] ?? 0) + 1;
  // Radar feed (ops keeper): the newest ecosystem brief as context for
  // proposals - toolchain advice must know what shipped recently.
  // Read-only, best-effort; no brief = no signal.
  let radarBrief: string | null = null;
  try {
    const { latestRadarBrief } = await import('./radar.ts');
    radarBrief = await latestRadarBrief(home);
  } catch { /* radar feed absent = no ecosystem signal this cycle */ }
  const signals = {
    sessions: insights.length,
    failures: insights.filter((i) => i.outcome !== 'ok').map((i) => ({ task: i.task, outcome: i.outcome })),
    toolUsage: toolCounts,
    activeSkills: active.map((s) => s.name),
    canarySkills: canary.map((s: { name: string }) => s.name),
    existingDrafts: drafts.map((s) => s.name),
    recentNotes: notes.slice(-10).map((n) => n.text),
    ecosystemNews: radarBrief ?? '(no recent ecosystem brief - run hmh ops scan)',
  };

  // 3. Baseline bench (train gates promotion; holdout re-verifies after).
  // Per-case cost captured too - the dual-metric gate (P0 methodology):
  // a candidate that passes only by RAMBLING (cost > baseline x cost-cap)
  // gets vetoed even at a green pass rate.
  say(`baseline bench: ${train.length} train + ${holdout.length} holdout cases`);
  const baseResults: Array<{ name: string; pass: boolean }> = [];
  const baseCost: Record<string, number> = {};
  for (const c of train) {
    try {
      const r = await runAndAssert(runCase, c, skillsToPrompt(active));
      baseResults.push({ name: c.name, pass: r.pass });
      baseCost[c.name] = estTokens(r.output);
    } catch (err) {
      baseResults.push({ name: c.name, pass: false });
      say(`  case ${c.name} threw: ${String(err).slice(0, 100)}`);
    }
  }
  const baseRate = baseResults.filter((r) => r.pass).length / baseResults.length;
  const holdoutBase: Array<{ name: string; pass: boolean }> = [];
  for (const c of holdout) {
    try {
      holdoutBase.push({ name: c.name, pass: (await runAndAssert(runCase, c, skillsToPrompt(active))).pass });
    } catch {
      holdoutBase.push({ name: c.name, pass: false });
    }
  }
  const holdoutBaseRate = holdoutBase.length === 0 ? 1 : holdoutBase.filter((r) => r.pass).length / holdoutBase.length;
  say(`baseline: train ${(baseRate * 100).toFixed(0)}%, holdout ${(holdoutBaseRate * 100).toFixed(0)}%`);

  // 4. Proposals: preset (tests/UI) or meta-model call. The GEPA population
  // loop: ONE random ancestor from the rejected-candidate pool (Pareto
  // front) feeds the prompt so evolution varies around the archive, not
  // around the single best; a complementary reject gets merged in (cross).
  // AWM adds workflow-level induction from repeated task archetypes - a
  // higher abstraction than per-mistake reflection (paper-verified).
  const pool = await readParetoEntries(home, 60);
  const { ancestor, mergeWith } = sampleAncestor(pool);
  let proposals: SkillProposal[];
  if (opts.presetProposals) {
    proposals = opts.presetProposals;
  } else {
    proposals = await proposeSkills(provider, signals, say, ancestor ?? undefined, mergeWith ?? undefined);
    if (proposals.length === 0) {
      try {
        const { workflowProposals } = await import('./workflows.ts');
        proposals = await workflowProposals(provider, home, say);
      } catch (err) {
        say(`  awm skipped: ${String(err).slice(0, 80)}`);
      }
    }
  }
  report.proposals = proposals;

  // 4b. Promotion quality floor (day-16 meta-audit): "no regression" alone
  // can promote a candidate that is still terrible when the BASELINE itself
  // is weak (baseline 20% -> candidate 25% passes the old gate). An absolute
  // minimum train pass rate closes that hole. Configurable via
  // config.json evolution.minPassRate (default 0.6).
  let minPassRate = 0.6;
  try {
    const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { evolution?: { minPassRate?: number } };
    if (typeof cfg.evolution?.minPassRate === 'number' && cfg.evolution.minPassRate >= 0 && cfg.evolution.minPassRate <= 1) {
      minPassRate = cfg.evolution.minPassRate;
    }
  } catch { /* default floor */ }

  // 5. A/B gate each proposal on the train set.
  for (const p of proposals.slice(0, maxProposals)) {
    say(`candidate "${p.name}": drafting + candidate bench`);
    try {
      // Write-channel anti-poisoning (Misevolve lesson): the behavior gate
      // only sees bench output, so instructions the model merely IGNORES
      // slip through. Screen drafted content for attempts to suppress tool
      // use, rename toolchain identifiers, or bypass the approval gate.
      const poison = screenForPoison(p.skill_md);
      if (poison) {
        report.outcomes.push({ name: p.name, action: 'rejected', reason: `poisoning screen: ${poison}` });
        say(`  rejected by poisoning screen (${poison.slice(0, 60)})`);
        continue;
      }
      await writeDraft(home, p.name, p.skill_md);
      const draftBlock = `## Draft skill under evaluation: ${p.name}\n\n${p.skill_md.slice(0, 4000)}`;
      const candidateInjection = `${skillsToPrompt(active)}\n${draftBlock}`;
      const candResults: Array<{ name: string; pass: boolean }> = [];
      const candCost: Record<string, number> = {};
      for (const c of train) {
        try {
          // two independent samples: a candidate passes only if it passes
          // BOTH runs - a single lucky output must not clear the gate
          const a = await runAndAssert(runCase, c, candidateInjection);
          const b = a.pass ? await runAndAssert(runCase, c, candidateInjection) : { pass: false, output: '' };
          candResults.push({ name: c.name, pass: a.pass && b.pass });
          candCost[c.name] = Math.max(estTokens(a.output), estTokens(b.output));
        } catch {
          candResults.push({ name: c.name, pass: false });
        }
      }
      const candRate = candResults.filter((r) => r.pass).length / candResults.length;
      const regression = baseResults.some((b) => b.pass && !candResults.find((c) => c.name === b.name)?.pass);
      // dual-metric veto: a passing case that costs > cost-cap x its
      // baseline counts as a cost regression (the candidate passed by
      // rambling) - only enforced where the case declares a cost-cap
      const costRegressions = train.filter((c) => {
        const cap = c.costCap ?? 1.3; // default 1.3x for all cases
        const base = baseCost[c.name] ?? 0;
        const cand = candCost[c.name] ?? 0;
        return base > 0 && cand > base * cap;
      }).map((c) => c.name);
      const summary = (rs: Array<{ name: string; pass: boolean }>) => rs.map((r) => `${r.name}:${r.pass ? 'pass' : 'FAIL'}`).join(' ');
      if (regression || candRate < baseRate) {
        await deleteDraft(home, p.name);
        await recordParetoEntry(home, { name: p.name, parentInsights: insightIds, rejectedReason: regression ? 'bench regression' : `pass rate ${candRate.toFixed(2)} < baseline ${baseRate.toFixed(2)}`, scores: { train: candRate }, metaModel: provider.model, at: new Date().toISOString() });
        report.outcomes.push({
          name: p.name,
          action: 'rejected',
          reason: regression ? 'bench regression on a previously passing case' : `pass rate ${candRate} < baseline ${baseRate}`,
          baseline: { passRate: baseRate, cases: summary(baseResults) },
          candidate: { passRate: candRate, cases: summary(candResults) },
          lineage: { parentInsights: insightIds, scores: { train: candRate }, metaModel: provider.model, decidedAt: new Date().toISOString() },
        });
        say(`  rejected (${regression ? 'regression' : 'lower pass rate'})`);
        continue;
      }
      if (candRate < minPassRate) {
        await deleteDraft(home, p.name);
        await recordParetoEntry(home, { name: p.name, parentInsights: insightIds, rejectedReason: `below quality floor (${candRate.toFixed(2)} < ${minPassRate})`, scores: { train: candRate }, metaModel: provider.model, at: new Date().toISOString() });
        report.outcomes.push({
          name: p.name,
          action: 'rejected',
          reason: `below quality floor: pass rate ${candRate} < min ${minPassRate} (non-regression vs a weak baseline ${baseRate} is not good enough)`,
          baseline: { passRate: baseRate, cases: summary(baseResults) },
          candidate: { passRate: candRate, cases: summary(candResults) },
          lineage: { parentInsights: insightIds, scores: { train: candRate }, metaModel: provider.model, decidedAt: new Date().toISOString() },
        });
        say(`  rejected (below quality floor ${minPassRate})`);
        continue;
      }
      if (costRegressions.length > 0) {
        await deleteDraft(home, p.name);
        await recordParetoEntry(home, { name: p.name, parentInsights: insightIds, rejectedReason: `cost regression on ${costRegressions.join(', ')}`, scores: { train: candRate }, metaModel: provider.model, at: new Date().toISOString() });
        report.outcomes.push({
          name: p.name,
          action: 'rejected',
          reason: `passed the bench but by rambling: output cost exceeded the baseline cap on ${costRegressions.join(', ')}`,
          baseline: { passRate: baseRate, cases: summary(baseResults) },
          candidate: { passRate: candRate, cases: summary(candResults) },
          lineage: { parentInsights: insightIds, scores: { train: candRate }, metaModel: provider.model, decidedAt: new Date().toISOString() },
        });
        say(`  rejected (cost regression on ${costRegressions.join(', ')})`);
        continue;
      }
      // P0 canary promotion: passing the train+holdout gates earns a
      // CANARY slot (injected into ~20% of sessions, watermarked as
      // experimental), not immediate full-active. The impact loop
      // (bench --impact) compares canary vs control sessions and promotes
      // to active only on evidence - the objective-hacking defense:
      // never trust only the metric the evolution system can see.
      const { archivedPrevious } = await promoteSkill(home, p.name, { canary: true });
      // Holdout re-verification (GDPevo anti-memorization): the gate saw the
      // train cases; holdout cases check the skill generalizes. Regression
      // here rolls the promotion back.
      let holdoutRate = 1;
      if (holdout.length > 0) {
        const holdoutCand: Array<{ name: string; pass: boolean }> = [];
        for (const c of holdout) {
          try {
            // same double-sample rule as the training gate
            const a = await runAndAssert(runCase, c, candidateInjection);
            const b = a.pass ? await runAndAssert(runCase, c, candidateInjection) : { pass: false, output: '' };
            holdoutCand.push({ name: c.name, pass: a.pass && b.pass });
          } catch {
            holdoutCand.push({ name: c.name, pass: false });
          }
        }
        holdoutRate = holdoutCand.filter((r) => r.pass).length / holdoutCand.length;
        if (holdoutRate < holdoutBaseRate) {
          // Restore the previous version; when there is none (first-time
          // promotion), demote the new skill back out of active and delete.
          const restored = await rollbackSkill(home, p.name);
          if (!restored) {
            await unpromoteSkill(home, p.name);
            await deleteDraft(home, p.name);
          }
          await recordParetoEntry(home, { name: p.name, parentInsights: insightIds, rejectedReason: `holdout regression (${holdoutRate.toFixed(2)} < ${holdoutBaseRate.toFixed(2)})`, scores: { train: candRate, holdout: holdoutRate }, metaModel: provider.model, at: new Date().toISOString() });
          report.outcomes.push({
            name: p.name,
            action: 'rejected',
            reason: `holdout regression after promotion (train ${candRate} vs ${baseRate}, holdout ${holdoutRate} vs ${holdoutBaseRate}) - rolled back`,
            baseline: { passRate: baseRate, cases: summary(baseResults) },
            candidate: { passRate: candRate, cases: summary(candResults) },
            holdout: { baselineRate: holdoutBaseRate, candidateRate: holdoutRate },
            lineage: { parentInsights: insightIds, scores: { train: candRate, holdout: holdoutRate }, metaModel: provider.model, decidedAt: new Date().toISOString() },
          });
          say(`  rolled back (holdout regression: ${(holdoutRate * 100).toFixed(0)}% < ${(holdoutBaseRate * 100).toFixed(0)}%)`);
          continue;
        }
      }
      // A promotion without any holdout case is a WEAK gate (behavior-only
      // signal); surfaced in the log so weakly-gated skills are auditable.
      const weakGate = holdout.length === 0;
      report.outcomes.push({
        name: p.name,
        action: 'promoted',
        reason: `no regression (train ${(candRate * 100).toFixed(0)}% vs ${(baseRate * 100).toFixed(0)}%${holdout.length ? `, holdout ${(holdoutRate * 100).toFixed(0)}%` : ''}; floor ≥${(minPassRate * 100).toFixed(0)}%) - promoted to CANARY (20% sessions, impact-gated full promotion)${archivedPrevious ? '; previous version archived' : ''}${weakGate ? ' [WEAK GATE: no holdout cases defined]' : ''}`,
        baseline: { passRate: baseRate, cases: summary(baseResults) },
        candidate: { passRate: candRate, cases: summary(candResults) },
        ...(holdout.length ? { holdout: { baselineRate: holdoutBaseRate, candidateRate: holdoutRate } } : {}),
        lineage: { parentInsights: insightIds, scores: { train: candRate, holdout: holdout.length ? holdoutRate : undefined }, metaModel: provider.model, decidedAt: new Date().toISOString() },
      });
      say(`  promoted to canary${holdout.length ? ` (holdout ${(holdoutRate * 100).toFixed(0)}%)` : ' [weak gate: no holdout]'}`);
    } catch (err) {
      report.outcomes.push({ name: p.name, action: 'error', reason: String(err).slice(0, 200) });
      say(`  error: ${String(err).slice(0, 120)}`);
    }
  }

  // 6. CODE-LEVEL evolution: propose + sandbox-bench + merge/revert patches.
  // This is the DGM bridge - the agent can now modify its own tool code,
  // gated by the same bench discipline as skill promotion.
  // OFF BY DEFAULT (DGM's own paper calls self-modifying systems "unsafe by
  // default"; AlphaEvolve evolves external programs in isolation, never the
  // live repo). Opt in with evolution.autoPatch=true in config.json - and
  // even then it only ever touches the repo the evolution runs in, with
  // human-reviewed sandbox benches before any merge.
  const cfg = await loadConfig();
  if (cfg.evolution?.autoPatch !== true) {
    if (insights.length > 0 || notes.length > 0) {
      say('  code-evolution: off (set evolution.autoPatch=true in config.json to enable)');
    }
  } else {
  try {
    const { proposePatches, runPatchSandbox } = await import('./patches.ts');
    const repoRoot = process.cwd();
    const patches = await proposePatches(provider, signals, readFile, repoRoot, say);
    if (patches.length > 0) {
      report.codePatches = patches.map((p) => ({ name: p.name, file: p.file, reason: p.reason }));
      for (const patch of patches.slice(0, 1)) { // at most 1 patch per cycle
        const outcome = await runPatchSandbox({
          repoRoot,
          patch,
          baselineRate: baseRate,
          runCase: async (c) => runCase(c, skillsToPrompt(active)),
          benchCases: train,
          log: say,
        });
        report.patchOutcomes = report.patchOutcomes ?? [];
        report.patchOutcomes.push(outcome);
        say(`  code-patch ${outcome.action}: ${outcome.reason}`);
      }
    }
  } catch (err) {
    say(`  code-evolution skipped: ${String(err).slice(0, 120)}`);
  }
  }

  // 7. Append-only memory distillation.
  if (notes.length >= 4) {
    const distilled = await distillMemory(provider, notes.map((n) => n.text).slice(-20), say);
    const distillPoison = distilled ? screenForPoison(distilled) : null;
    if (distillPoison) {
      say(`memory distillation rejected by poisoning screen (${distillPoison})`);
    } else if (distilled) {
      await appendMemory(home, `(distilled) ${distilled}`);
      report.memoryDistilled = distilled;
    }
  }

  // 7.5. P0 impact loop: graduate/retire canaries on evidence; P1 decay:
  //  quiet skills leave the injection set (never deleted). Both are
  //  best-effort - measurement must never fail the cycle.
  try {
    report.budget = { cyclesToday: budget.cyclesToday, maxCyclesPerDay: budget.maxCyclesPerDay };
    const impact = await impactReport(home);
    if (impact.rows.length > 0) {
      report.impact = {
        rows: impact.rows.map((r) => ({ skill: r.skill, exposed: `${r.exposed.sessions}s/${(r.exposed.okRate * 100).toFixed(0)}%`, control: `${r.control.sessions}s/${(r.control.okRate * 100).toFixed(0)}%`, verdict: r.verdict })),
        applied: impact.applied,
      };
      for (const a of impact.applied) say(`  impact: ${a}`);
    }
    const decayed = await decayUnusedSkills(home);
    if (decayed.length) {
      report.decayed = decayed;
      say(`  decayed to dormant: ${decayed.join(', ')}`);
    }
  } catch (err) {
    say(`  impact/decay skipped: ${String(err).slice(0, 100)}`);
  }

  // 7. Durable evolution log. estTokens feeds the daily token budget gate:
  // a chars/4 estimate of this cycle's meta-call traffic (proposals + bench
  // outputs + distilled notes) - coarse on purpose, the gate only needs an
  // order of magnitude to stop unattended spend.
  const estTokensSpent = (proposals ?? []).reduce((n, p) => n + estTokens(p.skill_md ?? '') + estTokens(p.description ?? ''), 0)
    + (report.memoryDistilled ? estTokens(report.memoryDistilled) : 0)
    + (report.patchOutcomes ?? []).length * 4_000;
  report.estTokens = estTokensSpent;
  const logDir = join(home, 'evolution');
  await mkdir(logDir, { recursive: true });
  await appendFile(join(logDir, 'log.jsonl'), JSON.stringify(report) + '\n', 'utf8');
  return report;
}

async function proposeSkills(
  provider: ProviderConfig,
  signals: Record<string, unknown>,
  say: (l: string) => void,
  ancestor?: { name: string; rejectedReason?: string; skillMd?: string; scores: { train: number; holdout?: number } },
  mergeWith?: { name: string; rejectedReason?: string; skillMd?: string } | null,
): Promise<SkillProposal[]> {
  const system = [
    'You are the evolution module of hmharness, a self-evolving agent framework for HarmonyOS development.',
    'Your job: read session signals and decide whether any repeatable procedure is worth crystallizing into a skill.',
    'A skill is a markdown how-to document the agent reads on demand. Topics must be limited to: HarmonyOS toolchain usage (hdc/hvigorw/ohpm/DevEco), this framework\'s tools (list_dir/read_file/write_file/run_command/remember/harmony_*), and reusable task workflows observed in the signals.',
    'Rules: name is kebab-case; description is one line; skill_md is at most 60 lines with concrete steps and example commands; do NOT propose skills about security config, approval policy, or anything outside the topics; if nothing is genuinely reusable, return an empty array.',
    'Respond with ONLY a JSON array: [{"name":"...","description":"...","skill_md":"..."}] - no prose, no code fences.',
  ].join('\n');
  // GEPA ancestor context: vary around a past rejection (its reason is the
  // lesson), optionally crossing with a complementary one - steady-state
  // genetic sampling instead of always restarting from scratch.
  let lineage = '';
  if (ancestor) {
    lineage = `\nPast rejected candidate (sampled from the archive - learn from why it failed, propose a VARIATION that fixes it):\nname: ${ancestor.name}\nrejected because: ${ancestor.rejectedReason ?? 'unknown'}\n${ancestor.skillMd ? `its content (first 1500 chars):\n${ancestor.skillMd.slice(0, 1500)}\n` : ''}`;
    if (mergeWith) {
      lineage += `\nA second rejected candidate with a DIFFERENT failure mode - consider merging their complementary angles:\nname: ${mergeWith.name}\nrejected because: ${mergeWith.rejectedReason ?? 'unknown'}\n${mergeWith.skillMd ? `content (first 1000 chars):\n${mergeWith.skillMd.slice(0, 1000)}\n` : ''}`;
    }
  }
  const user = `Session signals:\n${JSON.stringify(signals, null, 2)}${lineage}\n\nIf signals.ecosystemNews mentions recent OpenHarmony releases, prefer proposals that account for them over stale toolchain advice.\n\nPropose at most 2 skills (or []).`;
  const r = await chat(provider, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  const raw = r.message.content ?? '[]';
  const parsed = parseJsonArray(raw);
  const out: SkillProposal[] = [];
  for (const item of parsed) {
    const o = item as Record<string, unknown>;
    if (typeof o.name === 'string' && typeof o.skill_md === 'string' && o.name && o.skill_md) {
      out.push({ name: o.name, description: typeof o.description === 'string' ? o.description : '', skill_md: o.skill_md });
    }
  }
  say(`proposals: ${out.length ? out.map((p) => p.name).join(', ') : '(none)'}${ancestor ? ` (ancestor: ${ancestor.name})` : ''}`);
  return out;
}

async function distillMemory(provider: ProviderConfig, recentNotes: string[], say: (l: string) => void): Promise<string | null> {
  const system = [
    'You distill long-term memory notes for an agent. Given recent notes, write ONE new note (max 200 chars, Chinese or English matching the notes) that captures a repeated lesson or stable fact not yet obvious from any single note.',
    'If the notes are too scattered to synthesize anything genuinely new, output exactly: NONE',
    'Output only the note text, nothing else.',
  ].join('\n');
  try {
    const r = await chat(provider, [
      { role: 'system', content: system },
      { role: 'user', content: recentNotes.join('\n') },
    ]);
    const text = (r.message.content ?? '').trim();
    if (!text || text === 'NONE' || text.length > 300) {
      say('memory distillation: none');
      return null;
    }
    say(`memory distillation: ${text.slice(0, 80)}`);
    return text;
  } catch {
    return null;
  }
}

/** First balanced JSON array in the text; tolerates fences and prose around it. */
function parseJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('[');
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ']') {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as unknown[];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/**
 * Write-channel poisoning screen. Conservative pattern set; a hit rejects
 * the draft outright (the bench cannot see instructions the model ignores).
 * Deliberately窄: catches suppression/renaming/bypass directives, not
 * ordinary technical content.
 */
const POISON_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /(不要|别|never|don'?t)\s*(调用|使用|执行|call|use|run)[^。\n]{0,20}(工具|tool)/i, why: 'suppresses tool usage' },
  { re: /(凭记忆|from memory|without (calling|using))[^。\n]{0,20}(回答|工具|tool)/i, why: 'answers from memory instead of tools' },
  { re: /(一律|always|永远|never)[^。\n]{0,30}(写成|写作|rename|称作|call it)\s*["'"]?[a-z_]+["'"]?/i, why: 'renames a toolchain identifier' },
  { re: /(跳过|绕过|忽略|bypass|skip|ignore)[^。\n]{0,20}(审批|批准|门禁|approval|confirm|guard|deny)/i, why: 'attempts to bypass the approval gate' },
  { re: /(自动批准|auto[- ]?approve|always approve)/i, why: 'attempts to force auto-approval' },
  { re: /(删除|disable|remove)[^。\n]{0,20}(护栏|防护|safety|deny|guard)/i, why: 'attempts to disable safety guards' },
];

export function screenForPoison(text: string): string | null {
  for (const p of POISON_PATTERNS) {
    if (p.re.test(text)) return p.why;
  }
  return null;
}
