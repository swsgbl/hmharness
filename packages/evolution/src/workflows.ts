/**
 * @hmh/evolution - workflows (AWM: Agent Workflow Memory, arxiv 2409.07429)
 * Verified lesson from the paper: inducing commonly REUSED routines from
 * past task trajectories and injecting them on demand beats stacking raw
 * trajectories or per-mistake notes. Here the "repeated trajectory" signal
 * is insight clustering: the same task archetype occurring 3+ times
 * triggers one meta-model call that distills a PARAMETERIZED workflow
 * template ({{placeholders}}), which then flows through the EXISTING
 * draft -> poison-screen -> bench-gate pipeline. No new gate is opened -
 * a workflow is just a skill with a shape.
 */
import { chat, type ProviderConfig } from '@hmh/kernel';
import { readInsights } from './insights.ts';
import { screenForPoison, type SkillProposal } from './evolve.ts';

/** Cluster insights by task archetype: normalized prefix (first ~24 chars,
 *  alphanumerics lowercased) groups "fix build error in module X" tasks. */
function archetypeKey(task: string): string {
  const norm = task.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return norm.split(' ').slice(0, 6).join(' ').slice(0, 32) || norm.slice(0, 24);
}

export interface WorkflowCluster {
  key: string;
  tasks: string[];
  outcomes: string[];
}

/** Find task archetypes that occurred >= minRepeat times in the recent
 *  insight history - the AWM reuse signal. */
export async function findWorkflowClusters(home: string, minRepeat = 3, lookback = 120): Promise<WorkflowCluster[]> {
  const insights = await readInsights(home, lookback);
  const groups = new Map<string, WorkflowCluster>();
  for (const i of insights) {
    const key = archetypeKey(i.task);
    const g = groups.get(key) ?? { key, tasks: [], outcomes: [] };
    g.tasks.push(i.task.slice(0, 100));
    g.outcomes.push(i.outcome);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.tasks.length >= minRepeat);
}

/** Induce a parameterized workflow proposal from a cluster (one meta-model
 *  call; falls back to null on any refusal/parse failure/poison hit). */
export async function induceWorkflow(provider: ProviderConfig, cluster: WorkflowCluster): Promise<SkillProposal | null> {
  const system = [
    'You induce reusable workflow templates for a coding agent, from repeated task instances (Agent Workflow Memory).',
    'Output ONE skill in the standard format. The body must be a parameterized routine: use {{placeholders}} for the varying parts (module names, error strings, targets) so the agent fills them per task.',
    'Rules: name is kebab-case ending in "-workflow"; description is one line starting with the trigger condition ("when ..."); skill_md max 50 lines, concrete steps with real commands; no security/approval topics.',
    'If the instances do not actually share a reusable routine, output exactly: NONE',
    'Respond with ONLY JSON: {"name":"...","description":"...","skill_md":"..."} - no prose, no fences.',
  ].join('\n');
  const user = `Task archetype "${cluster.key}" occurred ${cluster.tasks.length}x:\n${cluster.tasks.map((t) => `- ${t}`).join('\n')}\n\nInduce the parameterized workflow.`;
  try {
    const r = await chat(provider, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const raw = (r.message.content ?? '').trim();
    if (!raw || raw === 'NONE') return null;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as { name?: string; description?: string; skill_md?: string };
    if (typeof o.name !== 'string' || typeof o.skill_md !== 'string' || !o.name || !o.skill_md) return null;
    if (screenForPoison(o.skill_md)) return null;
    return { name: o.name, description: o.description ?? '', skill_md: o.skill_md };
  } catch {
    return null;
  }
}

/** The full AWM step for one evolution cycle: find fresh clusters and
 *  induce at most one workflow proposal (budget-conscious; the existing
 *  gate pipeline does the actual accept/reject). */
export async function workflowProposals(provider: ProviderConfig, home: string, say: (l: string) => void): Promise<SkillProposal[]> {
  const clusters = await findWorkflowClusters(home, 3, 120);
  if (clusters.length === 0) return [];
  // already-proposed archetypes (by name convention <arch>-workflow) need no re-run
  say(`awm: ${clusters.length} repeated task archetype(s)`);
  const cluster = clusters.sort((a, b) => b.tasks.length - a.tasks.length)[0];
  const p = await induceWorkflow(provider, cluster);
  if (!p) {
    say('awm: no reusable routine induced');
    return [];
  }
  return [p];
}
