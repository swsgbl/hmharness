/**
 * @hmharness/agent - runner
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
} from '@hmharness/kernel';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { appendMemory, listSkills, readInsights, readNotes, recentInsights, recordInsight, retrieveMemory, skillsToPrompt, sessionGetsCanary, canaryWatermark, listCanary, workspaceForCwd, type EmbeddingProvider } from '@hmharness/evolution';
import { harmonyTools } from '@hmharness/domain-harmony';
import { opsTools } from '@hmharness/domain-ops';
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

/** Discover AGENTS.md / CLAUDE.md / .cursorrules by walking up from cwd to
 *  the workspace root. Deeper files take precedence (Codex convention). Only
 *  the first hit is returned; null when nothing found. */
async function discoverAgentsMd(cwd: string): Promise<string | null> {
  const NAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];
  let dir = cwd;
  while (true) {
    for (const name of NAMES) {
      try { return await readFile(join(dir, name), 'utf8'); } catch { /* not here */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/** Retrieval-based context pack: task-relevant memories, not the whole file.
 *  P0 canary: ~20% of sessions (deterministic by session id) also receive
 *  the canary skill block, watermarked as experimental references - the
 *  impact loop compares these sessions against the rest. */
/** Trivial-task detection: greetings, identity questions, and short chitchat
 *  don't need memory/skills/insights injection (~4K tokens of overhead the
 *  model ignores anyway). Skipping keeps the prompt lean for 90% of turns. */
export function isTrivialTask(task: string): boolean {
  const t = task.trim();
  if (t.length > 100) return false; // long enough to be substantive
  // note: no \b after CJK chars (they're outside \w so \b never fires there)
  if (/^(你好|hi|hello|hey|嗨|哈喽|在吗|在么)[\s。.!！?？~～]*$/i.test(t)) return true;
  if (/(你是谁|介绍.{0,4}自己|who are you|introduce yourself|what are you|你的名字|你叫什么)/i.test(t)) return true;
  if (/^(谢谢|thanks|thank you|ok|好的|嗯|哦|收到|明白)[\s。.!！]*$/i.test(t)) return true;
  if (/^(再见|bye|goodbye|exit|退出)[\s。.!！]*$/i.test(t)) return true;
  return false;
}

export async function contextPack(task: string, sessionId?: string, opts: { workspace?: string | null; embedding?: EmbeddingProvider } = {}) {
  const home = homeDir();

  // Trivial tasks (greetings, identity questions): skip memory/skills/insights
  // injection entirely — the model doesn't need them for "你好" and they add
  // ~4K tokens of noise that dilutes the identity anchor
  if (isTrivialTask(task)) {
    return { memory: '', skills: '', insights: '', skillsInjected: [] as string[] };
  }

  const [memory, skills, insights] = await Promise.all([
    retrieveMemory(home, task, { workspace: opts.workspace ?? undefined, embedding: opts.embedding }),
    listSkills(home),
    recentInsights(home),
  ]);
  let canaryBlock = '';
  let canaryNames: string[] = [];
  if (sessionId && sessionGetsCanary(sessionId)) {
    const canary = await listCanary(home);
    if (canary.length > 0) {
      canaryNames = canary.map((s) => s.name);
      canaryBlock = canaryWatermark(canaryNames) + '\n' + skillsToPrompt(canary);
    }
  }
  return { memory, skills: skillsToPrompt(skills) + (canaryBlock ? '\n' + canaryBlock : ''), insights, skillsInjected: [...skills.map((s) => s.name), ...canaryNames] };
}

/**
 * Terminal approval gate: auto mode passes everything; a TTY gets a y/N
 * prompt (reusing a caller-provided readline); a pipe gets a safe deny.
 * The kernel loop denies by default when no gate is wired at all.
 *
 * Persistent approval (Codex's .rules pattern): once a user approves a
 * command pattern (e.g. "hdc shell"), it is saved to
 * HMH_HOME/approved-rules.json and auto-approved next time. Rules are
 * matched by the tool name + args prefix. The hard-deny patterns in
 * tools.ts always override rules - dangerous commands are never auto-approved.
 */
export interface ApprovedRule { tool: string; argPrefix: string; time: string }

export function loadApprovedRules(home: string): ApprovedRule[] {
  try { return JSON.parse(readFileSync(join(home, 'approved-rules.json'), 'utf8')); } catch { return []; }
}
function saveApprovedRules(home: string, rules: ApprovedRule[]): void {
  try { writeFileSync(join(home, 'approved-rules.json'), JSON.stringify(rules, null, 2)); } catch { /* best effort */ }
}
/** Structured rule matching (review fix: raw string prefix was exploitable -
 *  `node scripts/` prefix was hit by `node scripts/../../evil.js`). Now:
 *  parses the rule as structured args, string values match by prefix BUT the
 *  extension is checked for path traversal (`..` at the boundary blocks). */
export function matchesRule(rules: ApprovedRule[], toolName: string, args: Record<string, unknown>): boolean {
  return rules.some((r) => {
    if (r.tool !== toolName) return false;
    try {
      const ruleArgs = JSON.parse(r.argPrefix) as Record<string, unknown>;
      for (const [k, rv] of Object.entries(ruleArgs)) {
        const av = args[k];
        if (typeof rv === 'string' && typeof av === 'string') {
          if (!av.startsWith(rv)) return false;
          // path traversal: the extension after the approved prefix must not
          // start with `..` (blocks `node scripts/` → `node scripts/../../x`)
          if (av.slice(rv.length).startsWith('..')) return false;
        } else if (rv !== av) {
          return false;
        }
      }
      return true;
    } catch { return false; }
  });
}

export function makeApproval(cfg: HmhConfig, yes: boolean, sharedRl?: readline.Interface): LoopApproval {
  const t = strings(cfg.locale ?? 'zh');
  const home = homeDir();
  return {
    async ask(toolName, args) {
      if (yes || cfg.approval === 'auto') return true;
      // Persistent rules: patterns the user previously approved are auto-passed
      if (matchesRule(loadApprovedRules(home), toolName, args)) return true;
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
      const granted = answer === 'y' || answer === 'yes';
      // Save approved patterns for future auto-approval (skip simple argless tools)
      if (granted && Object.keys(args).length > 0) {
        const rules = loadApprovedRules(home);
        const argsStr = JSON.stringify(args);
        if (!rules.some((r) => r.tool === toolName && r.argPrefix === argsStr)) {
          rules.push({ tool: toolName, argPrefix: argsStr, time: new Date().toISOString() });
          saveApprovedRules(home, rules);
        }
      }
      return granted;
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
  /** AbortSignal: cancels the agent loop at the next turn boundary. */
  signal?: AbortSignal;
}

/** Run one full agent task end-to-end; audit + insight recording included. */
export async function runAgentTask(opts: AgentTaskOptions): Promise<LoopResult & { sessionId: string; toolsUsed: string[] }> {
  const cfg = opts.cfg ?? (await loadConfig());
  const ctx = opts.ctx ?? { cwd: process.cwd(), home: homeDir() };
  const events = opts.events ?? {};
  const session = new Session(ctx.home, ctx.cwd, cfg.provider.model);
  // workspace scoping + optional embedding hybrid for memory retrieval.
  // Embeddings only when routing.embedding is EXPLICITLY set - an inherited
  // chat route would 404 on /embeddings once per task for nothing.
  const workspace = await workspaceForCwd(ctx.home, ctx.cwd);
  const embeddingRoute = (cfg as { routing?: Record<string, string> }).routing?.['embedding'];
  const embedding = embeddingRoute && cfg.providers?.[embeddingRoute]
    ? cfg.providers[embeddingRoute] as EmbeddingProvider
    : undefined;
  // contextPack needs the session id: canary injection is deterministic
  // per-session (stable attribution), decided before the prompt is built
  const pack = await contextPack(opts.task, session.id, { workspace, embedding });

  const agentsMd = await discoverAgentsMd(ctx.cwd);
  const system = buildSystemPrompt({
    cwd: ctx.cwd,
    home: ctx.home,
    memory: pack.memory,
    skills: pack.skills,
    insights: pack.insights,
    model: cfg.provider.model,
    locale: cfg.locale,
    agentsMd: agentsMd ?? undefined,
  });

  // system prompt token count: the prompt has been quietly growing (Codex 9
  // instructions + AGENTS.md + memory + skills + insights) while no cost gate
  // watches IT - this makes the size visible every run (review finding #5)
  const systemTokens = Math.ceil(system.length / 4);
  events.onLine?.(`  [prompt] system: ${system.length} chars (~${systemTokens} tokens) · ${agentsMd ? 'AGENTS.md: yes' : 'no AGENTS.md'}`);

  await session.user(opts.task);

  // YOLO fix: when yes=true the caller's approvalAsk (TUI dialog, web remote
  // gate) must NOT override the auto-approve gate - it used to take
  // precedence unconditionally, so /yolo was cosmetic (user-reported).
  const approval: LoopApproval = (opts.approvalAsk && !opts.yes)
    ? { ask: opts.approvalAsk }
    : makeApproval(cfg, opts.yes === true);
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
  // rolling digest hook: compaction-evicted tool output is distilled into a
  // persistent summary note by the chat model instead of being dropped
  // (failures degrade silently to the deterministic prune inside the kernel)
  const chatProvider = resolveProvider(cfg, 'chat');
  const { chat: chatFn } = await import('@hmharness/kernel');
  const summarizeContext = async (input: { previousDigest: string | null; evicted: string[] }) => {
    const r = await chatFn(chatProvider, [
      { role: 'system', content: 'You compress evicted agent transcript content into a dense factual digest. Keep: what was done, key results, paths, versions, decisions, errors and their fixes. Drop: raw listings, repetition, fluff. Max 120 words. Plain text bullets, no preamble.' },
      { role: 'user', content: (input.previousDigest ? `PREVIOUS DIGEST (merge, keep still-relevant facts):\n${input.previousDigest}\n\n` : '') + `NEWLY EVICTED CONTENT:\n${input.evicted.join('\n---\n').slice(0, 24_000)}` },
    ]);
    return r.message.content ?? '';
  };
  const result = await runLoop({
    provider: chatProvider,
    registry: opts.registry,
    messages,
    ctx,
    signal: opts.signal,
    maxTurns: cfg.maxTurns,
    maxContextChars: cfg.maxContextChars,
    summarizeContext,
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

  // ---- instant feedback: learn from THIS task's mistakes, not 8 tasks later ----
  // Tier 1 (always, zero cost): raw error pattern → memory self-note. Lowered
  // to 1 failure for system-level patterns (shell incompat, auth, missing
  // binary) - those never self-correct on retry; 2 for generic errors.
  try {
    const SYSTEM_ERR = /not (recognized|found|exist)|ENOENT|EACCES|ECONN|HTTP 4\d\d|authentication|unauthorized|command not found|is not an? (internal|external)/i;
    for (const [name, errs] of toolErrors) {
      const systemLevel = errs.some((e) => SYSTEM_ERR.test(e));
      const threshold = systemLevel ? 1 : 2;
      if (errs.length < threshold) continue;
      const notes = await readNotes(ctx.home);
      const last = notes.slice(-40).map((n) => n.text).join('\n');
      if (last.includes(`[self-note] tool ${name}`)) continue;
      await appendMemory(ctx.home, `[self-note] tool ${name} failed ${errs.length}x in one session; samples: ${[...new Set(errs)].slice(0, 2).join(' | ')}`, workspace ?? undefined);
    }
  } catch {
    /* memory is best-effort; never fail the task on it */
  }

  // Tier 2 (if errors occurred): one quick model call - "what went wrong,
  // what to do differently" - written to memory immediately. This is the
  // per-session reflection the user asked for: mistakes corrected in real
  // time, not batched 8 sessions later.
  if (toolErrors.size > 0) {
    void (async () => {
      try {
        const { chat: chatFn } = await import('@hmharness/kernel');
        const provider = resolveProvider(cfg, 'evolve');
        if (!provider.apiKey) return;
        const errSummary = [...toolErrors.entries()].map(([n, e]) => `${n}: ${[...new Set(e)].slice(0, 2).join('; ')}`).join('\n').slice(0, 600);
        const task = opts.task.slice(0, 150);
        const r = await chatFn(provider, [
          { role: 'system', content: 'You distill agent failure lessons. Given a task and its tool errors, output ONE actionable note (max 180 chars) starting with a verb: what to do differently next time on THIS machine/environment. If the errors are trivial/transient, output exactly NONE.' },
          { role: 'user', content: `Task: ${task}\nTool errors:\n${errSummary}` },
        ]);
        const lesson = (r.message.content ?? '').trim();
        if (lesson && lesson.toUpperCase() !== 'NONE' && lesson.length < 300) {
          await appendMemory(ctx.home, `[lesson] ${lesson}`, workspace ?? undefined);
        }
      } catch {
        /* reflection is best-effort */
      }
    })();
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
    skillsInjected: pack.skillsInjected,
  });
  // daily self-evolution: every N insights, one background cycle fires
  // (default on; autoEvolveEvery: 0 disables). Fire-and-forget - it never
  // blocks the reply, and its own guards (bench gate, holdout, poison
  // screen, skills/+memory/ only) apply unchanged.
  const every = cfg.autoEvolveEvery ?? 3;
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
    const { runEvolution } = await import('@hmharness/evolution');
    const { defaultConfig, loadConfig, resolveProvider, chat } = await import('@hmharness/kernel');
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
