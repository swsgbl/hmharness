/**
 * @hmharness/agent - live multi-agent governance (blueprint §11 / MA-001..010)
 *
 * Wraps the REAL spawn_agent tool with blueprint-2.0 governance: every spawn
 * becomes a topology node with a role contract (timeout/budget/heartbeat),
 * spends from the shared blackboard budget, and appends an immutable event
 * to cognitive/multi-agent.jsonl — process-agnostic, so the CLI and web
 * panel can replay any run's team structure long after it finished.
 *
 * v1 heartbeat = start/finish stamps (subagents are short-lived); the
 * watchdog threshold (3x the 30s role interval) only bites on stuck nodes.
 */
import type { Tool, ToolResult } from '@hmharness/kernel';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homeDir } from '@hmharness/kernel';
import { defineTopology, AgentTopology, type AgentRoleName } from '@hmharness/cognitive';

/** map the tool-facing role vocabulary onto blueprint roles */
export function mapRole(raw: string): AgentRoleName {
  const r = raw.toLowerCase();
  if (r.includes('plan')) return 'planner';
  if (r.includes('test') || r.includes('verif') || r.includes('judge')) return 'verifier';
  if (r.includes('review') || r.includes('critic')) return 'critic';
  if (r.includes('research') || r.includes('explore')) return 'researcher';
  if (r.includes('repair')) return 'implementer';
  return 'implementer';
}

interface TopologyState {
  topology: AgentTopology;
  createdAt: string;
  goal: string;
}

/** one live topology per process, seeded from the first governed spawn */
const live: { current?: TopologyState } = {};

export function liveTopologySnapshot(): { goal: string; createdAt: string; nodes: Array<{ id: string; role: string; status: string; startedAt?: string; endedAt?: string; failure?: { code: string; message: string } }> } | null {
  const t = live.current;
  if (!t) return null;
  return {
    goal: t.goal,
    createdAt: t.createdAt,
    nodes: t.topology.view().map((n) => ({ id: n.id, role: n.contract.role, status: n.status, startedAt: n.startedAt, endedAt: n.endedAt, failure: n.failure })),
  };
}

async function auditTeam(event: Record<string, unknown>): Promise<void> {
  try {
    const home = homeDir();
    const dir = join(home, 'cognitive');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'multi-agent.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
  } catch { /* governance audit is best-effort, never blocks the spawn */ }
}

export async function teamLog(limit = 30): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(join(homeDir(), 'cognitive', 'multi-agent.jsonl'), 'utf8');
    return text.split('\n').filter((l) => l.trim()).slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Wrap a spawn-like tool with topology governance. Non-fatal by contract:
 *  governance failures never break the underlying spawn. */
export function withTopologyGovernance(tool: Tool, opts: { task?: () => string } = {}): Tool {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(args: Record<string, unknown>, ctx: Parameters<Tool['execute']>[1]): Promise<ToolResult> {
      const task = String(args.task ?? '').slice(0, 120);
      const role = String(args.role ?? '');
      const maxTurns = Math.min(Math.max(Number(args.max_turns ?? 8), 1), 12);
      const blueprintRole = mapRole(role || 'implementer');
      try {
        if (!live.current) {
          const spec = defineTopology([blueprintRole, 'supervisor']);
          live.current = {
            topology: new AgentTopology(spec, {
              goalGraph: { nodes: [], edges: [] },
              worldDigest: { beliefs: [], uncertainty: {} },
              evidence: [],
              budget: { totalCostUnits: 400, spent: 0 },
              approvals: [],
              artifacts: [],
            }),
            createdAt: new Date().toISOString(),
            goal: opts.task?.() ?? task,
          };
          await auditTeam({ event: 'team.created', goal: live.current.goal.slice(0, 200) });
        }
        const t = live.current;
        // a fresh node of this role per spawn (the topology grows with use)
        const node = t.topology.addNode(blueprintRole);
        // shared budget: each turn ~1 cost unit; over-budget spawns are denied
        const spend = t.topology.trySpend(maxTurns);
        if (!spend.ok) {
          return { output: `team budget exhausted (${spend.spent}/${spend.total} cost units) - do the work directly instead`, isError: true };
        }
        t.topology.start(node.id);
        await auditTeam({ event: 'spawn.started', nodeId: node.id, role: blueprintRole, roleLabel: role, task, budgetUnits: maxTurns });
        const started = Date.now();
        try {
          const result = await original(args, ctx);
          const failed = Boolean(result.isError);
          if (failed) t.topology.fail(node.id, { code: 'E_SUBAGENT', message: String(result.output).slice(0, 200) });
          else t.topology.finish(node.id, { text: String(result.output).slice(0, 400) });
          await auditTeam({ event: failed ? 'spawn.failed' : 'spawn.done', nodeId: node.id, role: blueprintRole, turnsBudget: maxTurns, durationMs: Date.now() - started });
          return result;
        } catch (err) {
          t.topology.fail(node.id, { code: 'E_SUBAGENT_THREW', message: String(err).slice(0, 200) });
          await auditTeam({ event: 'spawn.failed', nodeId: node.id, role: blueprintRole, durationMs: Date.now() - started, error: String(err).slice(0, 200) });
          throw err;
        }
      } catch {
        // governance itself must never break the spawn — run it bare
        return original(args, ctx);
      }
    },
  };
}
