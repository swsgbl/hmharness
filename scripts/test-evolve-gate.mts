/**
 * Deterministic evolution-gate test (no model - the fitness signal is a
 * stub, which is exactly what the gate consumes):
 *   - junk proposal (breaks a TRAIN case)  -> REJECTED before promotion
 *   - holdout-killer (train fine, HOLDOUT regresses) -> promoted then ROLLED BACK
 *   - good proposal                        -> PROMOTED
 * Run: npx tsx scripts/test-evolve-gate.mts
 */
import { runEvolution, type BenchCase, type CaseRunner, type SkillProposal } from '../packages/evolution/src/index.ts';
import { deleteDraft, listSkills, unpromoteSkill } from '../packages/evolution/src/skills.ts';
import { rmSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Isolated fake home so this test never touches the real HMH_HOME.
const home = join(process.cwd(), '.tmp-gate-home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

/** Pass/fail driven by markers the gate can only see via skillsPrompt. */
const runner: CaseRunner = async (c: BenchCase, skillsPrompt: string) => {
  if (skillsPrompt.includes('BAD-TRAIN') && c.prompt.includes('三个工具')) return 'I refuse to name them';
  if (skillsPrompt.includes('HOLDOUT-KILL') && c.holdout) return 'unknown';
  return `ok ${c.expect.join(' ')}`;
};

const junk: SkillProposal = {
  name: 'junk-skill',
  description: 'breaks the toolchain train case',
  skill_md: 'BAD-TRAIN present',
};
const holdoutKiller: SkillProposal = {
  name: 'holdout-killer',
  description: 'train fine, holdout regresses',
  skill_md: 'HOLDOUT-KILL present',
};
const good: SkillProposal = {
  name: 'good-skill',
  description: 'harmless helper',
  skill_md: '# a genuinely useful doc\nbe precise',
};

const report = await runEvolution({
  home,
  provider: { baseUrl: 'http://stub', apiKey: 'x', model: 'stub' },
  runCase: runner,
  presetProposals: [junk, holdoutKiller, good],
  maxProposals: 3,
  log: (l) => console.log('  ' + l),
});

console.log('\n=== outcomes ===');
for (const o of report.outcomes) console.log(`${o.action.toUpperCase()}  ${o.name} — ${o.reason}`);

const by = (n: string) => report.outcomes.find((o) => o.name === n)?.action;
const activeAfter = (await listSkills(home)).map((s) => s.name);
const pass =
  by('junk-skill') === 'rejected' &&
  by('holdout-killer') === 'rejected' &&
  by('good-skill') === 'promoted' &&
  activeAfter.includes('good-skill') &&
  !activeAfter.includes('junk-skill') &&
  !activeAfter.includes('holdout-killer');
console.log('active after:', activeAfter.join(', ') || '(none)');
console.log(pass ? 'GATE TEST: PASS' : 'GATE TEST: FAIL');

// leave no trace in the repo
rmSync(home, { recursive: true, force: true });
void deleteDraft;
void unpromoteSkill;
void cpSync;
process.exit(pass ? 0 : 1);
