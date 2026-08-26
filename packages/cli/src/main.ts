#!/usr/bin/env node
/**
 * @hmh/cli - main
 * Usage:
 *   hmh init                 create HMH_HOME skeleton + config
 *   hmh "do something"       one-shot task (full agent loop, streaming)
 *   hmh                      interactive REPL
 *   hmh devices|check        direct tool run, no model
 *   hmh tools                list all registered tools (native + MCP)
 *   hmh mcp                  show configured MCP servers and their tools
 *   hmh bench                run the evolution bench
 *   hmh skills               list the skill library
 * Flags: --yes / -y auto-approve gated tools (else they prompt; non-TTY denies).
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  homeDir,
  initHome,
  loadConfig,
  mcpServerTools,
  Registry,
  runLoop,
  Session,
  type ChatMessage,
  type HmhConfig,
  type LoopApproval,
  type McpClient,
  type McpServerConfig,
  type McpServerImport,
  type Tool,
} from '@hmh/kernel';
import { listSkills, loadMemory, recentInsights, recordInsight, skillsToPrompt, runBench } from '@hmh/evolution';
import { harmonyTools } from '@hmh/domain-harmony';
import { baseTools } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Flatten the config.json shape into the runtime discriminated union. */
function toServerConfig(c: McpServerImport): McpServerConfig {
  if (c.type === 'http') return { type: 'http', url: c.url ?? '', headers: c.headers, trusted: c.trusted };
  return { type: 'stdio', command: c.command ?? '', args: c.args, env: c.env, trusted: c.trusted };
}

async function buildRegistry(opts: { mcp?: boolean } = {}): Promise<{ reg: Registry; clients: McpClient[] }> {
  const reg = new Registry();
  reg.registerAll(baseTools).registerAll(harmonyTools);
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
            stdout.write(DIM(`  [mcp] ${name}: ${tools.length} tools attached\n`));
          } catch (err) {
            stdout.write(YELLOW(`  [mcp] ${name}: unavailable (${String(err).slice(0, 140)})\n`));
          }
        }),
      );
    }
  }
  return { reg, clients };
}

async function contextPack() {
  const home = homeDir();
  const [memory, skills, insights] = await Promise.all([loadMemory(home), listSkills(home), recentInsights(home)]);
  return { memory, skills: skillsToPrompt(skills), insights };
}

/**
 * The approval gate: --yes or approval:'auto' passes everything; a TTY gets
 * a y/N prompt (reusing the REPL readline when we're inside one); a pipe
 * gets a safe deny. The kernel loop enforces the safe default without this.
 */
function makeApproval(cfg: HmhConfig, yes: boolean, sharedRl?: readline.Interface): LoopApproval {
  return {
    async ask(toolName, args) {
      if (yes || cfg.approval === 'auto') return true;
      const brief = JSON.stringify(args).slice(0, 120);
      if (!stdin.isTTY) {
        stdout.write(YELLOW(`  [approval] ${toolName} ${brief} — denied (no TTY; use --yes to allow)\n`));
        return false;
      }
      const rl = sharedRl ?? readline.createInterface({ input: stdin, output: stdout });
      let answer: string;
      try {
        answer = (await rl.question(YELLOW(`  [approval] ${toolName} ${brief} — run it? [y/N] `))).trim().toLowerCase();
      } finally {
        if (!sharedRl) rl.close();
      }
      return answer === 'y' || answer === 'yes';
    },
  };
}

interface TaskOptions {
  yes?: boolean;
  sharedRl?: readline.Interface;
  registry?: Registry;
  clients?: McpClient[];
}

async function runTask(task: string, taskOpts: TaskOptions = {}): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  const { reg, clients } = taskOpts.registry
    ? { reg: taskOpts.registry, clients: taskOpts.clients ?? [] }
    : await buildRegistry();
  const ctx = { cwd: process.cwd(), home };
  const pack = await contextPack();

  const system = buildSystemPrompt({
    cwd: ctx.cwd,
    memory: pack.memory,
    skills: pack.skills,
    insights: pack.insights,
    model: cfg.provider.model,
  });

  const session = new Session(home, ctx.cwd, cfg.provider.model);
  await session.user(task);

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ];

  // Live output state: reasoning arrives dimmed and prefixed, final text plain.
  let displayMode: 'none' | 'reasoning' | 'text' = 'none';
  let streamedText = false;
  const openMode = (m: 'reasoning' | 'text') => {
    if (displayMode !== m) {
      if (displayMode === 'reasoning') stdout.write('\n');
      if (m === 'reasoning') stdout.write(DIM('\n[thinking] '));
      displayMode = m;
    }
  };

  const toolsUsed: string[] = [];
  const result = await runLoop({
    provider: cfg.provider,
    registry: reg,
    messages,
    ctx,
    maxTurns: cfg.maxTurns,
    maxContextChars: cfg.maxContextChars,
    approval: makeApproval(cfg, taskOpts.yes === true, taskOpts.sharedRl),
    events: {
      onDelta: (kind, chunk) => {
        if (kind === 'reasoning') {
          openMode('reasoning');
          stdout.write(DIM(chunk));
        } else {
          openMode('text');
          streamedText = true;
          stdout.write(chunk);
        }
      },
      onToolCall: (name, args) => {
        if (displayMode !== 'none') {
          stdout.write('\n');
          displayMode = 'none';
        }
        toolsUsed.push(name);
        const brief = JSON.stringify(args).slice(0, 100);
        stdout.write(DIM(`  [tool] ${name} ${brief}\n`));
      },
      onToolResult: (name, output, isError) => {
        if (isError) stdout.write(DIM(`  [${name} ERROR] ${output.slice(0, 160)}\n`));
      },
      onApproval: (name, _args, granted) => {
        void session.approval(name, granted);
      },
      onAssistant: async (m) => {
        await session.assistant(m.content ?? null, m.tool_calls);
      },
    },
  });

  stdout.write(streamedText ? '\n\n' : '\n' + result.text + '\n\n');
  await session.final(result.text, result.turns, result.toolUses);
  await recordInsight(home, {
    time: new Date().toISOString(),
    session: session.id,
    task: task.slice(0, 120),
    outcome: result.turns >= cfg.maxTurns ? 'turn-budget' : 'ok',
    turns: result.turns,
    toolUses: result.toolUses,
    toolsUsed: [...new Set(toolsUsed)],
  });
  stdout.write(DIM(`(session ${session.id} · ${result.turns} turns · ${result.toolUses} tool uses)\n`));
}

async function repl(yes: boolean): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`) + DIM('type a task, or /exit to quit\n\n'));
  const { reg, clients } = await buildRegistry();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = (await rl.question(CYAN('hmh> '))).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      try {
        await runTask(line, { yes, sharedRl: rl, registry: reg, clients });
      } catch (err) {
        stdout.write(`error: ${String(err)}\n`);
      }
    }
  } finally {
    rl.close();
    for (const c of clients) c.close();
  }
}

function printTool(t: Tool): void {
  stdout.write(`  ${t.name}${t.needsApproval ? YELLOW(' [gated]') : ''} — ${t.description.split('\n')[0].slice(0, 100)}\n`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const yes = rawArgs.some((a) => a === '--yes' || a === '-y');
  const args = rawArgs.filter((a) => a !== '--yes' && a !== '-y');
  const [cmd, ...rest] = args;

  if (cmd === 'init') {
    const { home, created } = await initHome();
    stdout.write(`home: ${home}\n${created.length ? 'created: ' + created.join(', ') : 'already initialized.'}\n`);
    return;
  }
  if (cmd === 'devices' || cmd === 'check') {
    await initHome();
    const { reg } = await buildRegistry({ mcp: false });
    const tool = reg.get(cmd === 'devices' ? 'harmony_devices' : 'harmony_toolchain_check')!;
    const r = await tool.execute({}, { cwd: process.cwd(), home: homeDir() });
    stdout.write(r.output + '\n');
    return;
  }
  if (cmd === 'tools') {
    await initHome();
    const { reg, clients } = await buildRegistry();
    stdout.write(CYAN('native tools\n'));
    for (const t of reg.list()) if (!t.name.startsWith('mcp_')) printTool(t);
    const mcp = reg.list().filter((t) => t.name.startsWith('mcp_'));
    if (mcp.length > 0) {
      stdout.write(CYAN('mcp tools\n'));
      for (const t of mcp) printTool(t);
    }
    for (const c of clients) c.close();
    return;
  }
  if (cmd === 'mcp') {
    await initHome();
    const cfg = await loadConfig();
    const servers = Object.entries(cfg.mcpServers ?? {});
    if (servers.length === 0) {
      stdout.write('No MCP servers configured. Add them to HMH_HOME/config.json, e.g.\n'
        + '{ "mcpServers": { "fetch": { "type": "stdio", "command": "npx", "args": ["-y", "mcp-server-fetch"] } } }\n');
      return;
    }
    for (const [name, raw] of servers) {
      try {
        const { client, tools } = await mcpServerTools(name, toServerConfig(raw));
        stdout.write(CYAN(`${name}`) + DIM(` (${raw.type}${raw.trusted ? ', trusted' : ''}) — ${tools.length} tools\n`));
        for (const t of tools) printTool(t);
        client.close();
      } catch (err) {
        stdout.write(YELLOW(`${name}: unavailable (${String(err).slice(0, 160)})\n`));
      }
    }
    return;
  }
  if (cmd === 'skills') {
    const skills = await listSkills(homeDir());
    stdout.write(skills.length ? skills.map((s) => `${s.name} — ${s.description}`).join('\n') : '(no skills yet — add one under HMH_HOME/skills/<name>/SKILL.md)\n');
    return;
  }
  if (cmd === 'bench') {
    await initHome();
    const { results, passRate } = await runBench(homeDir(), async (prompt) => {
      // bench runs through a plain model call (no tools) for determinism
      const { chat } = await import('@hmh/kernel');
      const cfg = await loadConfig();
      const r = await chat(cfg.provider, [{ role: 'user', content: prompt }]);
      return r.message.content ?? '';
    });
    for (const r of results) stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}\n`);
    stdout.write(`pass rate: ${(passRate * 100).toFixed(0)}%\n`);
    return;
  }
  if (cmd && !cmd.startsWith('-')) {
    await initHome();
    const { reg, clients } = await buildRegistry();
    try {
      await runTask([cmd, ...rest].join(' '), { yes, registry: reg, clients });
    } finally {
      for (const c of clients) c.close();
    }
    return;
  }
  await initHome();
  await repl(yes);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
