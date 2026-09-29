/**
 * @hmharness/agent - RLM workspace tool (blueprint M5 / RLM-001..010 live)
 *
 * Gives the LIVE model a persistent, programmable cognitive workspace for
 * the duration of a task: set/get variables, eval sandboxed code against
 * them, checkpoint/restore, fork. The runtime enforces the budget and
 * freezes its governance state — the model composes context, it can never
 * rewrite the meter (no hidden unsafe self-modification, RLM-008).
 *
 * One workspace per session (spawned subagents share the parent's by home
 * key — deliberately: delegation sees the same whiteboard).
 */
import type { Tool, ToolResult, ToolContext } from '@hmharness/kernel';
import { RLMRuntime, type RLMCheckpoint } from '@hmharness/cognitive';

const workspaces = new Map<string, RLMRuntime>();

function wsFor(home: string): RLMRuntime {
  let ws = workspaces.get(home);
  if (!ws) {
    ws = new RLMRuntime({ maxEvals: 200, maxWallMs: 30 * 60_000, maxSubagents: 0 });
    workspaces.set(home, ws);
  }
  return ws;
}

export const rlmWorkspaceTool: Tool = {
  name: 'rlm_workspace',
  description:
    'Persistent structured workspace for THIS task: variables survive between calls (unlike your context window). ' +
    'Actions: set(name,value) / get(name) / list() / eval(code — JS, `ctx.vars` holds the variables, return a value) / ' +
    'checkpoint(label?) / restore(checkpointId) / reset(). Use it to accumulate findings, counts, plans, intermediate ' +
    'results across many tool calls, then eval a composition over them. eval is sandboxed and budget-metered.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'set | get | list | eval | checkpoint | restore | reset' },
      name: { type: 'string', description: 'variable name (set/get)' },
      value: { type: 'string', description: 'value to set (stored as string; eval can JSON.parse)' },
      code: { type: 'string', description: 'eval body: `return ...` over ctx.vars' },
      checkpointId: { type: 'string', description: 'restore target (from checkpoint result)' },
      label: { type: 'string', description: 'checkpoint label' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? '');
    const ws = wsFor(ctx.home);
    try {
      switch (action) {
        case 'set': {
          const name = String(args.name ?? '');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { output: `invalid variable name '${name}'`, isError: true };
          ws.set(name, String(args.value ?? ''));
          return { output: `set ${name} (${String(args.value ?? '').length} chars)` };
        }
        case 'get': {
          const v = ws.get(String(args.name ?? ''));
          if (v === undefined) return { output: `undefined`, isError: true };
          return { output: typeof v === 'string' ? v : JSON.stringify(v) };
        }
        case 'list':
          return { output: ws.names().length ? ws.names().join(', ') : '(empty)' };
        case 'eval': {
          const code = String(args.code ?? '');
          if (!code.trim()) return { output: 'code required', isError: true };
          const r = await ws.eval(code);
          if (!r.ok) return { output: `eval failed [${r.error?.code}]: ${r.error?.message}`, isError: true };
          const text = r.value === undefined ? 'undefined' : typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
          return { output: text.length > 8_000 ? text.slice(0, 8_000) + '…[truncated]' : text };
        }
        case 'checkpoint': {
          const cp: RLMCheckpoint = ws.checkpoint(args.label ? String(args.label) : undefined);
          checkpoints.set(`${ctx.home}::${cp.id}`, cp);
          return { output: `checkpoint ${cp.id}${cp.label ? ` (${cp.label})` : ''} — restore with checkpointId=${cp.id}` };
        }
        case 'restore': {
          const id = String(args.checkpointId ?? '');
          if (!id) return { output: 'checkpointId required', isError: true };
          // restore needs the checkpoint object; keep an id->cp map on the tool side
          const cp = checkpoints.get(`${ctx.home}::${id}`);
          if (!cp) return { output: `unknown checkpoint ${id} (checkpoints live in-process)`, isError: true };
          ws.restore(cp);
          return { output: `restored ${id}` };
        }
        case 'reset': {
          workspaces.delete(ctx.home);
          checkpoints.delete(ctx.home);
          return { output: 'workspace cleared' };
        }
        default:
          return { output: `unknown action '${action}' (set|get|list|eval|checkpoint|restore|reset)`, isError: true };
      }
    } catch (err) {
      return { output: 'rlm_workspace failed: ' + String(err).slice(0, 200), isError: true };
    }
  },
};

const checkpoints = new Map<string, RLMCheckpoint>();
