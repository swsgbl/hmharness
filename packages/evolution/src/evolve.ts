/**
 * @hmh/evolution - evolve
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
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chat, type ProviderConfig } from '@hmh/kernel';
import { listCases, matchExpect, seedCases, type BenchCase } from './bench.ts';
import { deleteDraft, listDrafts, listSkills, promoteSkill, rollbackSkill, skillsToPrompt, unpromoteSkill, writeDraft } from './skills.ts';
import { appendMemory, readNotes } from './memory.ts';
import { readInsights } from './insights.ts';

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
}

/** Runs one bench case with the given skills block injected. */
export type CaseRunner = (c: BenchCase, skillsPrompt: string) => Promise<string>;

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
  report.insightCount = insights.length;
  report.noteCount = notes.length;
  const toolCounts: Record<string, number> = {};
  for (const i of insights) for (const t of i.toolsUsed) toolCounts[t] = (toolCounts[t] ?? 0) + 1;
  const signals = {
    sessions: insights.length,
    failures: insights.filter((i) => i.outcome !== 'ok').map((i) => ({ task: i.task, outcome: i.outcome })),
    toolUsage: toolCounts,
    activeSkills: active.map((s) => s.name),
    existingDrafts: drafts.map((s) => s.name),
    recentNotes: notes.slice(-10).map((n) => n.text),
  };

  // 3. Baseline bench (train gates promotion; holdout re-verifies after).
  say(`baseline bench: ${train.length} train + ${holdout.length} holdout cases`);
  const baseResults: Array<{ name: string; pass: boolean }> = [];
  for (const c of train) {
    try {
      baseResults.push({ name: c.name, pass: matchExpect(await runCase(c, skillsToPrompt(active)), c.expect) });
    } catch (err) {
      baseResults.push({ name: c.name, pass: false });
      say(`  case ${c.name} threw: ${String(err).slice(0, 100)}`);
    }
  }
  const baseRate = baseResults.filter((r) => r.pass).length / baseResults.length;
  const holdoutBase: Array<{ name: string; pass: boolean }> = [];
  for (const c of holdout) {
    try {
      holdoutBase.push({ name: c.name, pass: matchExpect(await runCase(c, skillsToPrompt(active)), c.expect) });
    } catch {
      holdoutBase.push({ name: c.name, pass: false });
    }
  }
  const holdoutBaseRate = holdoutBase.length === 0 ? 1 : holdoutBase.filter((r) => r.pass).length / holdoutBase.length;
  say(`baseline: train ${(baseRate * 100).toFixed(0)}%, holdout ${(holdoutBaseRate * 100).toFixed(0)}%`);

  // 4. Proposals: preset (tests/UI) or meta-model call.
  const proposals = opts.presetProposals ?? (await proposeSkills(provider, signals, say));
  report.proposals = proposals;

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
      for (const c of train) {
        try {
          // two independent samples: a candidate passes only if it passes
          // BOTH runs - a single lucky output must not clear the gate
          const a = matchExpect(await runCase(c, candidateInjection), c.expect);
          const b = a ? matchExpect(await runCase(c, candidateInjection), c.expect) : false;
          candResults.push({ name: c.name, pass: a && b });
        } catch {
          candResults.push({ name: c.name, pass: false });
        }
      }
      const candRate = candResults.filter((r) => r.pass).length / candResults.length;
      const regression = baseResults.some((b) => b.pass && !candResults.find((c) => c.name === b.name)?.pass);
      const summary = (rs: Array<{ name: string; pass: boolean }>) => rs.map((r) => `${r.name}:${r.pass ? 'pass' : 'FAIL'}`).join(' ');
      if (regression || candRate < baseRate) {
        await deleteDraft(home, p.name);
        report.outcomes.push({
          name: p.name,
          action: 'rejected',
          reason: regression ? 'bench regression on a previously passing case' : `pass rate ${candRate} < baseline ${baseRate}`,
          baseline: { passRate: baseRate, cases: summary(baseResults) },
          candidate: { passRate: candRate, cases: summary(candResults) },
        });
        say(`  rejected (${regression ? 'regression' : 'lower pass rate'})`);
        continue;
      }
      const { archivedPrevious } = await promoteSkill(home, p.name);
      // Holdout re-verification (GDPevo anti-memorization): the gate saw the
      // train cases; holdout cases check the skill generalizes. Regression
      // here rolls the promotion back.
      let holdoutRate = 1;
      if (holdout.length > 0) {
        const holdoutCand: Array<{ name: string; pass: boolean }> = [];
        for (const c of holdout) {
          try {
            // same double-sample rule as the training gate
            const a = matchExpect(await runCase(c, candidateInjection), c.expect);
            const b = a ? matchExpect(await runCase(c, candidateInjection), c.expect) : false;
            holdoutCand.push({ name: c.name, pass: a && b });
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
          report.outcomes.push({
            name: p.name,
            action: 'rejected',
            reason: `holdout regression after promotion (train ${candRate} vs ${baseRate}, holdout ${holdoutRate} vs ${holdoutBaseRate}) - rolled back`,
            baseline: { passRate: baseRate, cases: summary(baseResults) },
            candidate: { passRate: candRate, cases: summary(candResults) },
            holdout: { baselineRate: holdoutBaseRate, candidateRate: holdoutRate },
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
        reason: `no regression (train ${(candRate * 100).toFixed(0)}% vs ${(baseRate * 100).toFixed(0)}%${holdout.length ? `, holdout ${(holdoutRate * 100).toFixed(0)}%` : ''})${archivedPrevious ? '; previous version archived' : ''}${weakGate ? ' [WEAK GATE: no holdout cases defined]' : ''}`,
        baseline: { passRate: baseRate, cases: summary(baseResults) },
        candidate: { passRate: candRate, cases: summary(candResults) },
        ...(holdout.length ? { holdout: { baselineRate: holdoutBaseRate, candidateRate: holdoutRate } } : {}),
      });
      say(`  promoted${holdout.length ? ` (holdout ${(holdoutRate * 100).toFixed(0)}%)` : ' [weak gate: no holdout]'}`);
    } catch (err) {
      report.outcomes.push({ name: p.name, action: 'error', reason: String(err).slice(0, 200) });
      say(`  error: ${String(err).slice(0, 120)}`);
    }
  }

  // 6. Append-only memory distillation.
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

  // 7. Durable evolution log.
  const logDir = join(home, 'evolution');
  await mkdir(logDir, { recursive: true });
  await appendFile(join(logDir, 'log.jsonl'), JSON.stringify(report) + '\n', 'utf8');
  return report;
}

async function proposeSkills(
  provider: ProviderConfig,
  signals: Record<string, unknown>,
  say: (l: string) => void,
): Promise<SkillProposal[]> {
  const system = [
    'You are the evolution module of hmharness, a self-evolving agent framework for HarmonyOS development.',
    'Your job: read session signals and decide whether any repeatable procedure is worth crystallizing into a skill.',
    'A skill is a markdown how-to document the agent reads on demand. Topics must be limited to: HarmonyOS toolchain usage (hdc/hvigorw/ohpm/DevEco), this framework\'s tools (list_dir/read_file/write_file/run_command/remember/harmony_*), and reusable task workflows observed in the signals.',
    'Rules: name is kebab-case; description is one line; skill_md is at most 60 lines with concrete steps and example commands; do NOT propose skills about security config, approval policy, or anything outside the topics; if nothing is genuinely reusable, return an empty array.',
    'Respond with ONLY a JSON array: [{"name":"...","description":"...","skill_md":"..."}] - no prose, no code fences.',
  ].join('\n');
  const user = `Session signals:\n${JSON.stringify(signals, null, 2)}\n\nPropose at most 2 skills (or []).`;
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
  say(`proposals: ${out.length ? out.map((p) => p.name).join(', ') : '(none)'}`);
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
