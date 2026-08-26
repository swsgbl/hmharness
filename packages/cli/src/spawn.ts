/**
 * @hmh/cli - spawn
 * The sub-agent tool: run a nested agent loop with a FRESH context on a
 * self-contained subtask and return its final answer. Children share the
 * tool registry (minus MCP - children stay fast and deterministic) and the
 * approval gate, but never the parent's conversation - context isolation
 * is the point. Depth-capped so a confused model can't fork-bomb itself.
 */
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
      const childDepth = deps.depth + 1;
      const tag = `sub${childDepth}`;
      const maxTurns = Math.min(Math.max(Number(args.max_turns ?? 8), 1), 12);
      const registry = deps.buildChildRegistry(childDepth);
      const system = [
        `You are a hmh sub-agent (depth ${childDepth}). You have no conversation history beyond this task.`,
        'Do exactly what the task asks, use tools as needed, verify before answering, and reply with a concise result (the caller only sees your final answer).',
      ].join('\n');
      base.onLine?.(`[${tag}] start: ${task.slice(0, 80)}`);
      const result = await runLoop({
        provider: base.provider,
        registry,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: task },
        ],
        ctx: base.ctx,
        maxTurns,
        approval: base.approval,
        events: {
          onToolCall: (name, a) => base.onLine?.(`[${tag}] ${name} ${JSON.stringify(a).slice(0, 80)}`),
          onToolResult: (name, output, isError) => {
            void base.session?.tool(`${tag}>${name}`, output, isError);
            if (isError) base.onLine?.(`[${tag}] ${name} ERROR: ${output.slice(0, 100)}`);
          },
        },
      });
      const text = result.text || '(sub-agent returned empty output)';
      base.onLine?.(`[${tag}] done (${result.turns} turns, ${result.toolUses} tool uses)`);
      return { output: text.length > 20_000 ? text.slice(0, 20_000) + '\n...[truncated]' : text };
    },
  };
}
