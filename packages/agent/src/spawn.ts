/**
 * @hmh/cli - spawn
 * The sub-agent tool: run a nested agent loop with a FRESH context on a
 * self-contained subtask and return its final answer. Children share the
 * tool registry (minus MCP - children stay fast and deterministic) and the
 * approval gate, but never the parent's conversation - context isolation
 * is the point. Depth-capped so a confused model can't fork-bomb itself.
 *
 * P3 role records: an optional `role` labels the sub-agent (e.g.
 * "explorer", "reviewer"); outcome stats accumulate in HMH_HOME and are
 * surfaced in the parent's next spawn - the honest minimal version of
 * agent-topology evolution: no MARL, just per-role success rates the
 * model can read before delegating. Weak roles get called out; the
 * model (or user) stops asking them for that kind of work.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLoop, type Session, type LoopApproval, type Registry, type Tool } from '@hmh/kernel';

export const MAX_SPAWN_DEPTH = 2;

export interface SpawnBase {
  provider: import('@hmh/kernel').ProviderConfig;
  ctx: import('@hmh/kernel').ToolContext;
  approval?: LoopApproval;
  session?: Session;
  /** Bubbled tool traffic for display: `[sub1] list_dir {...}`. */
  onLine?(line: string): void;
}

/** Aggregated per-role outcomes from the spawn journal (HMH_HOME). */
export interface RoleStat {
  role: string;
  spawns: number;
  /** ok = finished within its turn budget without tool errors */
  ok: number;
}

export async function recordRole(home: string, role: string, ok: boolean): Promise<void> {
  try {
    const dir = join(home, 'evolution');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'spawn-roles.jsonl'), JSON.stringify({ time: new Date().toISOString(), role, ok }) + '\n', 'utf8');
  } catch { /* stats are best-effort */ }
}

export async function roleStats(home: string, limit = 200): Promise<RoleStat[]> {
  try {
    const text = await readFile(join(home, 'evolution', 'spawn-roles.jsonl'), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).slice(-limit);
    const by = new Map<string, RoleStat>();
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as { role: string; ok: boolean };
        const s = by.get(r.role) ?? { role: r.role, spawns: 0, ok: 0 };
        s.spawns++;
        if (r.ok) s.ok++;
        by.set(r.role, s);
      } catch { /* skip corrupt */ }
    }
    return [...by.values()].sort((a, b) => (b.ok / b.spawns) - (a.ok / a.spawns));
  } catch {
    return [];
  }
}

/** One-line leaderboard the parent sees before it delegates (>=3 samples). */
export function roleStatsLine(stats: RoleStat[]): string {
  const shown = stats.filter((s) => s.spawns >= 3).slice(0, 5);
  if (shown.length === 0) return '';
  return `Role track record (prefer roles with high ok-rates for similar work): ${shown.map((s) => `${s.role} ${(100 * s.ok / s.spawns).toFixed(0)}% (${s.spawns}x)`).join(', ')}.`;
}

/**
 * Resolved lazily at each spawn so a long-lived REPL registry always sees the
 * CURRENT task's session/approval, not the one from when it was built.
 */
export interface SpawnDeps {
  depth: number; // 0 = the loop the user talks to
  getBase(): SpawnBase;
  /** Build the registry for a child at the given depth (no spawn at the cap). */
  buildChildRegistry(depth: number): Registry;
}

export function makeSpawnTool(deps: SpawnDeps): Tool {
  return {
    name: 'spawn_agent',
    description:
      'Run a sub-agent with a fresh context on a self-contained subtask (e.g. "explore the project layout and report module names", "find which file defines X"). Returns the sub-agent\'s final answer. The sub-agent has the same tools but NO conversation history and no MCP tools - include every detail it needs in the task. Use it to keep this conversation small: delegate exploration and focused lookups.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'complete, self-contained instructions for the sub-agent' },
        role: { type: 'string', description: 'optional label for this delegation, e.g. "explorer", "reviewer", "build-fixer" - roles accumulate success rates you will see next time' },
        max_turns: { type: 'number', description: 'turn budget for the sub-agent (default 8, max 12)' },
      },
      required: ['task'],
    },
    async execute(args) {
      const base = deps.getBase();
      if (deps.depth >= MAX_SPAWN_DEPTH) {
        return { output: `spawn depth cap (${MAX_SPAWN_DEPTH}) reached. Do the work directly instead.`, isError: true };
      }
      const task = String(args.task ?? '').trim();
      if (!task) return { output: 'spawn_agent requires a non-empty task.', isError: true };
      const role = String(args.role ?? '').trim().toLowerCase().slice(0, 24);
      const childDepth = deps.depth + 1;
      const tag = role || `sub${childDepth}`;
      const maxTurns = Math.min(Math.max(Number(args.max_turns ?? 8), 1), 12);
      const registry = deps.buildChildRegistry(childDepth);
      // P3 tournament signal: show the role leaderboard (if any) to the
      // parent model in the delegation prompt when the child runs with a role
      let roleLine = '';
      if (role) {
        try {
          const stats = await roleStats(base.ctx.home, 200);
          roleLine = roleStatsLine(stats) + '\n';
        } catch { /* best-effort */ }
      }
      const system = [
        `You are a hmh sub-agent (depth ${childDepth}${role ? `, role: ${role}` : ''}). You have no conversation history beyond this task.`,
        role ? `Perform the ${role} duty with that specialty's discipline.` : '',
        'Do exactly what the task asks, use tools as needed, verify before answering, and reply with a concise result (the caller only sees your final answer).',
      ].filter(Boolean).join('\n');
      base.onLine?.(`[${tag}] start: ${task.slice(0, 80)}`);
      let sawError = false;
      const result = await runLoop({
        provider: base.provider,
        registry,
        messages: [
          { role: 'system', content: roleLine + system },
          { role: 'user', content: task },
        ],
        ctx: base.ctx,
        maxTurns,
        approval: base.approval,
        events: {
          onToolCall: (name, a) => base.onLine?.(`[${tag}] ${name} ${JSON.stringify(a).slice(0, 80)}`),
          onToolResult: (name, output, isError) => {
            if (isError) {
              sawError = true;
              base.onLine?.(`[${tag}] ${name} ERROR: ${output.slice(0, 100)}`);
            }
            void base.session?.tool(`${tag}>${name}`, output, isError);
          },
        },
      });
      const text = result.text || '(sub-agent returned empty output)';
      // P3 record: ok = answered within budget and no tool errored
      if (role) await recordRole(base.ctx.home, role, result.turns < maxTurns && !sawError);
      base.onLine?.(`[${tag}] done (${result.turns} turns, ${result.toolUses} tool uses)`);
      return { output: text.length > 20_000 ? text.slice(0, 20_000) + '\n...[truncated]' : text };
    },
  };
}
