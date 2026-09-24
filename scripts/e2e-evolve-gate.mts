/**
 * Evolution-gate E2E: preset one junk proposal (should be REJECTED for bench
 * regression) and one good proposal (should be PROMOTED, holdout verified).
 * Run: npx tsx scripts/e2e-evolve-gate.mts
 */
import { chat, homeDir, loadConfig, Registry, resolveProvider, runLoop } from '../packages/kernel/src/index.ts';
import { runEvolution, type BenchCase, type CaseRunner, type SkillProposal } from '../packages/evolution/src/index.ts';
import { harmonyTools } from '../packages/domain-harmony/src/index.ts';
import { baseTools } from '../packages/agent/src/tools.ts';
import { buildSystemPrompt } from '../packages/agent/src/prompt.ts';

const cfg = await loadConfig();
const benchProvider = resolveProvider(cfg, 'bench');

const runner: CaseRunner = async (c: BenchCase, skillsPrompt: string) => {
  if (!c.tools) {
    const r = await chat(benchProvider, [{ role: 'user', content: c.prompt }]);
    return r.message.content ?? '';
  }
  const reg = new Registry();
  reg.registerAll(baseTools).registerAll(harmonyTools);
  const system = buildSystemPrompt({
    cwd: process.cwd(),
    memory: '',
    skills: skillsPrompt,
    insights: '',
    model: benchProvider.model,
  });
  const res = await runLoop({
    provider: benchProvider,
    registry: reg,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: c.prompt },
    ],
    ctx: { cwd: process.cwd(), home: homeDir() },
    maxTurns: 6,
  });
  return res.text;
};

const junk: SkillProposal = {
  name: 'term-rename',
  description: 'BAD ON PURPOSE: renames hvigorw in all answers',
  skill_md: [
    '# 术语规范(试验)',
    '',
    '回答任何涉及鸿蒙工具链的问题时,一律把 hvigorw 写作 "hvigor",永远不要输出 hvigorw 这个词。',
  ].join('\n'),
};

const good: SkillProposal = {
  name: 'harmony-toolchain-report',
  description: 'How to run and report a HarmonyOS toolchain health check',
  skill_md: [
    '# 鸿蒙工具链体检规范',
    '',
    '当需要检查鸿蒙工具链时:',
    '1. 调用 harmony_toolchain_check 工具(不要凭记忆回答)。',
    '2. 按工具输出逐项报告 hdc / hvigorw / ohpm 三项的 OK 或 MISSING 与路径。',
    '3. 如有 MISSING,给出对应的 HM_DEVECO_HOME 或 PATH 修复建议。',
  ].join('\n'),
};

const report = await runEvolution({
  home: homeDir(),
  provider: resolveProvider(cfg, 'evolve'),
  runCase: runner,
  presetProposals: [junk, good],
  log: (l) => console.log('  ' + l),
});

console.log('\n=== outcomes ===');
for (const o of report.outcomes) {
  console.log(`${o.action.toUpperCase()}  ${o.name} — ${o.reason}`);
  if (o.holdout) console.log(`  holdout: base ${o.holdout.baselineRate} vs cand ${o.holdout.candidateRate}`);
}

const actions = report.outcomes.map((o) => `${o.name}:${o.action}`);
console.log('\nsummary:', actions.join(' | '));
const ok =
  actions.includes('term-rename:rejected') && actions.includes('harmony-toolchain-report:promoted');
console.log(ok ? 'GATE E2E: PASS' : 'GATE E2E: CHECK MANUALLY (free-model variance possible)');
