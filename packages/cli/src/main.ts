#!/usr/bin/env node
/**
 * @hmh/cli - main (terminal frontend)
 * Usage:
 *   hmh init                 create HMH_HOME skeleton + config
 *   hmh "do something"       one-shot task (full agent loop, streaming)
 *   hmh                      interactive REPL (conversation memory kept)
 *   hmh resume [id-prefix]   continue a past session by id prefix (or latest)
 *   hmh web [--port=7788]    local web frontend (SSE streaming + approvals)
 *   hmh devices|check        direct tool run, no model
 *   hmh tools                list all registered tools (native + MCP)
 *   hmh mcp                  show configured MCP servers and their tools
 *   hmh evolve [--every=N]   self-evolution cycle (or resident loop)
 *   hmh bench                run the evolution bench
 *   hmh skills [--promote|--rollback|--unpromote <name>]
 * Flags: --yes / -y auto-approve gated tools (else they prompt; non-TTY denies).
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  chat,
  homeDir,
  initHome,
  latestSession,
  loadConfig,
  loadTranscript,
  mcpServerTools,
  Registry,
  runLoop,
  type ChatMessage,
  type McpClient,
  type McpServerImport,
  type McpServerConfig,
  type Tool,
} from '@hmh/kernel';
import {
  listSkills,
  listDrafts,
  promoteSkill,
  runBench,
  runEvolution,
  rollbackSkill,
  skillsToPrompt,
  unpromoteSkill,
  type BenchCase,
  type CaseRunner,
} from '@hmh/evolution';
import { harmonyTools } from '@hmh/domain-harmony';
import { baseTools, buildRegistry, buildSystemPrompt, runAgentTask } from '@hmh/agent';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;

interface TaskOptions {
  yes?: boolean;
  sharedRl?: readline.Interface;
  registry?: Registry;
  clients?: McpClient[];
  resumeMessages?: ChatMessage[];
}

async function runTask(task: string, taskOpts: TaskOptions = {}): Promise<{ messages: ChatMessage[]; sessionId: string }> {
  const cfg = await loadConfig();
  const { reg, clients } = taskOpts.registry
    ? { reg: taskOpts.registry, clients: taskOpts.clients ?? [] }
    : await buildRegistry({ announce: false });
  void clients;

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

  const result = await runAgentTask({
    task,
    registry: reg,
    cfg,
    yes: taskOpts.yes,
    resumeMessages: taskOpts.resumeMessages,
    events: {
      onLine: (l) => stdout.write(DIM(`  ${l}\n`)),
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
        stdout.write(DIM(`  [tool] ${name} ${JSON.stringify(args).slice(0, 100)}\n`));
      },
      onToolResult: (name, output, isError) => {
        if (isError) stdout.write(DIM(`  [${name} ERROR] ${output.slice(0, 160)}\n`));
      },
    },
  });

  stdout.write(streamedText ? '\n\n' : '\n' + result.text + '\n\n');
  stdout.write(DIM(`(session ${result.sessionId} · ${result.turns} turns · ${result.toolUses} tool uses)\n`));
  // working transcript minus the system prompt and the task line we appended
  return { messages: result.messages, sessionId: result.sessionId };
}

async function repl(yes: boolean, initialHistory?: ChatMessage[]): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`) + DIM('type a task, or /exit to quit\n\n'));
  const { reg, clients } = await buildRegistry();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  // The REPL keeps conversation memory across its own lines (and any
  // resumed history); each line re-injects fresh memory/skills.
  let history: ChatMessage[] = initialHistory ? [...initialHistory] : [];
  try {
    while (true) {
      const line = (await rl.question(CYAN('hmh> '))).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      try {
        const r = await runTask(line, { yes, sharedRl: rl, registry: reg, clients, resumeMessages: history });
        history = [...history, { role: 'user', content: line }, ...r.messages.slice(2)];
      } catch (err) {
        stdout.write(`error: ${String(err)}\n`);
      }
    }
  } finally {
    rl.close();
    for (const c of clients) c.close();
  }
}

/**
 * Bench case runner shared by `hmh bench` and `hmh evolve`. Tool cases run
 * through the real loop (native tools only - no MCP, no approvals: gated
 * tools deny safely, keeping runs deterministic and side-effect free).
 */
function makeCaseRunner(): CaseRunner {
  return async (c: BenchCase, skillsPrompt: string) => {
    const cfg = await loadConfig();
    if (!c.tools) {
      const r = await chat(cfg.provider, [{ role: 'user', content: c.prompt }]);
      return r.message.content ?? '';
    }
    const reg = new Registry();
    reg.registerAll(baseTools).registerAll(harmonyTools);
    const system = buildSystemPrompt({
      cwd: process.cwd(),
      memory: '',
      skills: skillsPrompt,
      insights: '',
      model: cfg.provider.model,
    });
    const res = await runLoop({
      provider: cfg.provider,
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
}

function printTool(t: Tool): void {
  stdout.write(`  ${t.name}${t.needsApproval ? YELLOW(' [gated]') : ''} — ${t.description.split('\n')[0].slice(0, 100)}\n`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const yes = rawArgs.some((a) => a === '--yes' || a === '-y');
  const args = rawArgs.filter((a) => a !== '--yes' && a !== '-y');
  const [cmd, ...rest] = args;
  const arg = rest.join(' ');

  if (cmd === 'init') {
    const { home, created } = await initHome();
    stdout.write(`home: ${home}\n${created.length ? 'created: ' + created.join(', ') : 'already initialized.'}\n`);
    return;
  }
  if (cmd === 'devices' || cmd === 'check') {
    await initHome();
    const { reg } = await buildRegistry({ mcp: false, announce: false });
    const tool = reg.get(cmd === 'devices' ? 'harmony_devices' : 'harmony_toolchain_check')!;
    const r = await tool.execute({}, { cwd: process.cwd(), home: homeDir() });
    stdout.write(r.output + '\n');
    return;
  }
  if (cmd === 'tools') {
    await initHome();
    const { reg, clients } = await buildRegistry({ announce: false });
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
        const sc: McpServerConfig = raw.type === 'http'
          ? { type: 'http', url: raw.url ?? '', headers: raw.headers, trusted: raw.trusted }
          : { type: 'stdio', command: raw.command ?? '', args: raw.args, env: raw.env, trusted: raw.trusted };
        const { client, tools } = await mcpServerTools(name, sc);
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
    const home = homeDir();
    const flag = rest.find((a) => a.startsWith('--'));
    const skillName = rest.find((a) => !a.startsWith('-') && !a.startsWith('--'));
    if (flag === '--promote' || flag === '--rollback' || flag === '--unpromote') {
      if (!skillName) {
        stdout.write(`usage: hmh skills --promote|--rollback|--unpromote <name>\n`);
        return;
      }
      if (flag === '--promote') {
        const r = await promoteSkill(home, skillName);
        stdout.write(`promoted ${skillName} -> active (${r.file}${r.archivedPrevious ? '; previous archived' : ''})\n`);
      } else if (flag === '--rollback') {
        stdout.write((await rollbackSkill(home, skillName)) ? `rolled back ${skillName} to the previous archived version\n` : `no archived snapshot of ${skillName}\n`);
      } else {
        stdout.write((await unpromoteSkill(home, skillName)) ? `moved ${skillName} back to drafts\n` : `${skillName} is not active\n`);
      }
      return;
    }
    const active = await listSkills(home);
    const drafts = await listDrafts(home);
    stdout.write(CYAN(`active (${active.length})\n`));
    stdout.write(active.length ? active.map((s) => `  ${s.name} — ${s.description}`).join('\n') + '\n' : '  (none)\n');
    stdout.write(CYAN(`drafts (${drafts.length})\n`));
    stdout.write(drafts.length ? drafts.map((s) => `  ${s.name} — ${s.description}`).join('\n') + '\n' : '  (none)\n');
    return;
  }
  if (cmd === 'bench') {
    await initHome();
    const runner = makeCaseRunner();
    const { results, passRate } = await runBench(homeDir(), (c) => runner(c, ''));
    for (const r of results) stdout.write(`${r.pass ? GREEN('PASS') : YELLOW('FAIL')} ${r.name} — ${r.detail}\n`);
    stdout.write(`pass rate: ${(passRate * 100).toFixed(0)}%\n`);
    return;
  }
  if (cmd === 'evolve') {
    await initHome();
    const cfg = await loadConfig();
    const maxN = Number(rest.find((a) => a.startsWith('--max='))?.slice(6) ?? 2);
    const everyMin = Number(rest.find((a) => a.startsWith('--every='))?.slice(8) ?? 0);
    const maxCycles = Number(rest.find((a) => a.startsWith('--cycles='))?.slice(9) ?? 0);
    const runCycle = async (n: number) => {
      stdout.write(CYAN('evolve') + DIM(` · model ${cfg.provider.model} · cycle ${n}${everyMin ? '' : ' (one-shot)'}\n`));
      const report = await runEvolution({
        home: homeDir(),
        provider: cfg.provider,
        runCase: makeCaseRunner(),
        maxProposals: Number.isFinite(maxN) ? Math.min(Math.max(maxN, 0), 4) : 2,
        log: (l) => stdout.write(DIM(`  ${l}\n`)),
      });
      for (const o of report.outcomes) {
        const tag = o.action === 'promoted' ? GREEN('PROMOTED') : o.action === 'rejected' ? YELLOW('REJECTED') : YELLOW('ERROR');
        stdout.write(`${tag} ${o.name} — ${o.reason}\n`);
      }
      if (report.memoryDistilled) stdout.write(DIM(`memory distilled: ${report.memoryDistilled}\n`));
    };
    if (everyMin >= 1) {
      // Scheduled mode: run a cycle, sleep, repeat. Errors don't kill the
      // loop (transient gateway failures are expected); Ctrl-C exits.
      const waitMs = Math.max(everyMin, 5) * 60_000;
      const cap = maxCycles > 0 ? maxCycles : Infinity;
      for (let n = 1; n <= cap; n++) {
        try {
          await runCycle(n);
        } catch (err) {
          stdout.write(YELLOW(`cycle ${n} failed: ${String(err).slice(0, 160)} (continuing)\n`));
        }
        if (n >= cap) break;
        stdout.write(DIM(`next cycle in ${Math.max(everyMin, 5)} min (Ctrl-C to stop)\n`));
        await new Promise((r) => setTimeout(r, waitMs));
      }
      stdout.write(DIM(`log: ${homeDir()}/evolution/log.jsonl\n`));
      return;
    }
    await runCycle(1);
    stdout.write(DIM(`log: ${homeDir()}/evolution/log.jsonl\n`));
    return;
  }
  if (cmd === 'web') {
    await initHome();
    const port = Number(rest.find((a) => a.startsWith('--port='))?.slice(7) ?? 7788);
    const { startServer } = await import('@hmh/web');
    await startServer({ port: Number.isFinite(port) ? port : 7788, host: '127.0.0.1' });
    return; // startServer keeps the process alive
  }
  if (cmd === 'resume') {
    await initHome();
    const file = await latestSession(homeDir(), arg);
    if (!file) {
      stdout.write(arg ? `No session matches prefix "${arg}".\n` : 'No sessions yet.\n');
      return;
    }
    const tr = await loadTranscript(file);
    if (!tr) {
      stdout.write(`Could not parse ${file}\n`);
      return;
    }
    stdout.write(DIM(`resuming ${tr.id} · ${tr.messages.length} messages · model ${tr.model}\n`));
    await repl(yes, tr.messages);
    return;
  }
  if (cmd && !cmd.startsWith('-')) {
    await initHome();
    const { reg, clients } = await buildRegistry({ announce: false });
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
