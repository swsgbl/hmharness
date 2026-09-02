/**
 * @hmh/agent - runner
 * The shared agent-task execution layer. CLI maps its events to terminal
 * output; the web frontend maps them to SSE - one behavior, two frontends.
 * Also owns the native registry factory (spawn_agent recursion) and the
 * approval gate construction.
 */
import {
  homeDir,
  loadConfig,
  resolveProvider,
  mcpServerTools,
  Registry,
  runLoop,
  Session,
  type ChatMessage,
  type DeltaKind,
  type HmhConfig,
  type LoopApproval,
  type LoopResult,
  type McpClient,
  type McpServerConfig,
  type McpServerImport,
  type ToolContext,
} from '@hmh/kernel';
import { appendMemory, listSkills, readInsights, readNotes, recentInsights, recordInsight, retrieveMemory, skillsToPrompt } from '@hmh/evolution';
import { harmonyTools } from '@hmh/domain-harmony';
import { opsTools } from '@hmh/domain-ops';
import * as readline from 'node:readline/promises';
import { stdin } from 'node:process';
import { baseTools } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';
import { strings } from './i18n.ts';
import { makeSpawnTool, MAX_SPAWN_DEPTH, type SpawnBase } from './spawn.ts';

/** Flatten the config.json shape into the runtime discriminated union. */
export function toServerConfig(c: McpServerImport): McpServerConfig {
  if (c.type === 'http') return { type: 'http', url: c.url ?? '', headers: c.headers, trusted: c.trusted };
  return { type: 'stdio', command: c.command ?? '', args: c.args, env: c.env, trusted: c.trusted };
}

/**
 * Current spawn base, set per task so a long-lived registry (REPL, web
 * server) always routes sub-agents to the CURRENT session and gate.
 */
export const spawnBase: { current?: SpawnBase } = {};

export function nativeRegistry(depth: number): Registry {
  const reg = new Registry();
  reg.registerAll(baseTools).registerAll(harmonyTools).registerAll(opsTools);
  if (depth < MAX_SPAWN_DEPTH) {
    reg.register(
      makeSpawnTool({
        depth,
        getBase: () =>
          spawnBase.current ?? {
            provider: { baseUrl: '', apiKey: '', model: '' },
            ctx: { cwd: process.cwd(), home: homeDir() },
          },
        buildChildRegistry: nativeRegistry,
      }),
    );
  }
  return reg;
}

export async function buildRegistry(opts: { mcp?: boolean; announce?: boolean } = {}): Promise<{ reg: Registry; clients: McpClient[] }> {
  const reg = nativeRegistry(0);
  const clients: McpClient[] = [];
  if (opts.mcp !== false) {
    const cfg = await loadConfig();
    const servers = Object.entries(cfg.mcpServers ?? {});
    if (servers.length > 0) {
      await Promise.all(
        servers.map(async ([name, raw]) => {
          try {
            const { client, tools } = await mcpServerTools(name, toServerConfig(raw));
            for (const t of tools) {
              try {
                reg.register(t);
              } catch {
                /* name collision after sanitization - first server wins */
              }
            }
            clients.push(client);
            if (opts.announce !== false) console.log(`  [mcp] ${name}: ${tools.length} tools attached`);
          } catch (err) {
            if (opts.announce !== false) console.log(`  [mcp] ${name}: unavailable (${String(err).slice(0, 140)})`);
          }
        }),
      );
    }
  }
  return { reg, clients };
}

/** Retrieval-based context pack: task-relevant memories, not the whole file. */
export async function contextPack(task: string) {
  const home = homeDir();
  const [memory, skills, insights] = await Promise.all([
    retrieveMemory(home, task),
    listSkills(home),
    recentInsights(home),
  ]);
  return { memory, skills: skillsToPrompt(skills), insights };
}

/**
 * Terminal approval gate: auto mode passes everything; a TTY gets a y/N
 * prompt (reusing a caller-provided readline); a pipe gets a safe deny.
 * The kernel loop denies by default when no gate is wired at all.
 */
export function makeApproval(cfg: HmhConfig, yes: boolean, sharedRl?: readline.Interface): LoopApproval {
  const t = strings(cfg.locale ?? 'zh');
  return {
    async ask(toolName, args) {
      if (yes || cfg.approval === 'auto') return true;
      const brief = JSON.stringify(args).slice(0, 120);
      if (!stdin.isTTY) {
        process.stdout.write(`\x1b[33m${t.approvalDeniedNoTty(toolName, brief)}\x1b[0m\n`);
        return false;
      }
      const rl = sharedRl ?? readline.createInterface({ input: stdin, output: process.stdout });
      let answer: string;
      try {
        answer = (await rl.question(`\x1b[33m${t.approvalPrompt(toolName, brief)}\x1b[0m`)).trim().toLowerCase();
      } finally {
        if (!sharedRl) rl.close();
      }
      return answer === 'y' || answer === 'yes';
    },
  };
}

export interface RunnerEvents {
  onLine?(line: string): void;
  onDelta?(kind: DeltaKind, chunk: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  onApproval?(name: string, args: Record<string, unknown>, granted: boolean): void;
  onFinal?(r: { text: string; turns: number; toolUses: number; sessionId: string; usage?: { promptTokens: number; completionTokens: number } }): void;
}

export interface AgentTaskOptions {
  task: string;
  registry: Registry;
  cfg?: HmhConfig;
  ctx?: ToolContext;
  yes?: boolean;
  /** Overrides the terminal gate (web supplies a remote one). */
  approvalAsk?: LoopApproval['ask'];
  resumeMessages?: ChatMessage[];
  events?: RunnerEvents;
}

/** Run one full agent task end-to-end; audit + insight recording included. */
export async function runAgentTask(opts: AgentTaskOptions): Promise<LoopResult & { sessionId: string; toolsUsed: string[] }> {
  const cfg = opts.cfg ?? (await loadConfig());
  const ctx = opts.ctx ?? { cwd: process.cwd(), home: homeDir() };
  const events = opts.events ?? {};
  const pack = await contextPack(opts.task);

  const system = buildSystemPrompt({
    cwd: ctx.cwd,
    home: ctx.home,
    memory: pack.memory,
    skills: pack.skills,
    insights: pack.insights,
    model: cfg.provider.model,
    locale: cfg.locale,
  });

  const session = new Session(ctx.home, ctx.cwd, cfg.provider.model);
  await session.user(opts.task);

  const approval: LoopApproval = opts.approvalAsk ? { ask: opts.approvalAsk } : makeApproval(cfg, opts.yes === true);
  spawnBase.current = {
    provider: resolveProvider(cfg, 'chat'),
    ctx,
    approval,
    session,
    onLine: (l) => events.onLine?.(l),
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...(opts.resumeMessages ?? []),
    { role: 'user', content: opts.task },
  ];

  const toolsUsed: string[] = [];
  // self-noted failure patterns: 2+ errors from one tool become a memory
  // note, so the NEXT session starts knowing what broke this one (the
  // self-evolution loop's missing per-session feedback channel)
  const toolErrors = new Map<string, string[]>();
  const result = await runLoop({
    provider: resolveProvider(cfg, 'chat'),
    registry: opts.registry,
    messages,
    ctx,
    maxTurns: cfg.maxTurns,
    maxContextChars: cfg.maxContextChars,
    approval: spawnBase.current.approval,
    events: {
      onDelta: (kind, chunk) => events.onDelta?.(kind, chunk),
      onToolCall: (name, args) => {
        toolsUsed.push(name);
        events.onToolCall?.(name, args);
      },
      onToolResult: (name, output, isError) => {
        if (isError) {
          const list = toolErrors.get(name) ?? [];
          list.push(output.split('\n')[0].slice(0, 120));
          toolErrors.set(name, list);
        }
        void session.tool(name, output, isError);
        events.onToolResult?.(name, output, isError);
      },
      onApproval: (name, args, granted) => {
        void session.approval(name, granted);
        events.onApproval?.(name, args, granted);
      },
      onAssistant: async (m) => {
        await session.assistant(m.content ?? null, m.tool_calls);
      },
    },
  });

  // distill repeated tool failures into long-term memory (dedup by tool name)
  try {
    for (const [name, errs] of toolErrors) {
      if (errs.length < 2) continue;
      const notes = await readNotes(ctx.home);
      const last = notes.slice(-40).map((n) => n.text).join('\n');
      if (last.includes(`[self-note] tool ${name}`)) continue;
      await appendMemory(ctx.home, `[self-note] tool ${name} failed ${errs.length}x in one session; samples: ${[...new Set(errs)].slice(0, 2).join(' | ')}`);
    }
  } catch {
    /* memory is best-effort; never fail the task on it */
  }

  await session.final(result.text, result.turns, result.toolUses);
  await recordInsight(ctx.home, {
    time: new Date().toISOString(),
    session: session.id,
    task: opts.task.slice(0, 120),
    outcome: result.turns >= cfg.maxTurns ? 'turn-budget' : 'ok',
    turns: result.turns,
    toolUses: result.toolUses,
    toolsUsed: [...new Set(toolsUsed)],
  });
  // daily self-evolution: every N insights, one background cycle fires
  // (default on; autoEvolveEvery: 0 disables). Fire-and-forget - it never
  // blocks the reply, and its own guards (bench gate, holdout, poison
  // screen, skills/+memory/ only) apply unchanged.
  const every = cfg.autoEvolveEvery ?? 8;
  if (every > 0) {
    try {
      const count = (await readInsights(ctx.home, 10_000)).length;
      if (count > 0 && count % every === 0) void triggerBackgroundEvolve(ctx.home);
    } catch {
      /* insight count is best-effort */
    }
  }
  events.onFinal?.({ text: result.text, turns: result.turns, toolUses: result.toolUses, sessionId: session.id, usage: result.usage });
  return { ...result, sessionId: session.id, toolsUsed: [...new Set(toolsUsed)] };
}

/** One background evolution cycle (auto-triggered). Logs to the evolution
 *  journal only; failures never surface into the user's chat. */
async function triggerBackgroundEvolve(home: string): Promise<void> {
  try {
    const { runEvolution } = await import('@hmh/evolution');
    const { defaultConfig, loadConfig, resolveProvider, chat } = await import('@hmh/kernel');
    const cfg = await loadConfig();
    const provider = resolveProvider(cfg, 'evolve');
    if (!provider.apiKey) return; // no provider configured - stay quiet
    const reg = nativeRegistry(0);
    await runEvolution({
      home,
      provider,
      runCase: async (c) => {
        if (c.tools) {
          const { buildSystemPrompt } = await import('./prompt.ts');
          const res2 = await runLoop({
            provider,
            registry: reg,
            messages: [
              { role: 'system', content: buildSystemPrompt({ cwd: process.cwd(), home, memory: '', skills: '', insights: '', model: provider.model }) },
              { role: 'user', content: c.prompt },
            ],
            ctx: { cwd: process.cwd(), home },
            maxTurns: 6,
          });
          return res2.text;
        }
        const r = await chat(provider, [{ role: 'user', content: c.prompt }]);
        return r.message.content ?? '';
      },
      log: () => undefined,
    });
    void defaultConfig; // referenced for type stability of the dynamic import
  } catch {
    /* background cycle failures are recorded by runEvolution itself or stay silent */
  }
}
