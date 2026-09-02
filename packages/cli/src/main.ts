#!/usr/bin/env node
/**
 * @hmh/cli - main (terminal frontend)
 * Usage:
 *   hmh init                 create HMH_HOME skeleton + config
 *   hmh "do something"       one-shot task (full agent loop, streaming)
 *   hmh                      interactive REPL (conversation memory kept)
 *   hmh resume [id-prefix]   continue a past session by id prefix (or latest)
 *   hmh web [--port=7788]    local web frontend (SSE streaming + approvals)
 *   hmh tui                  lite terminal UI (status header + slash commands)
 *   hmh ops [scan|brief|status]  ops keeper: ecosystem radar
 *   hmh devices|check        direct tool run, no model
 *   hmh tools                list all registered tools (native + MCP)
 *   hmh mcp                  show configured MCP servers and their tools
 *   hmh evolve [--every=N]   self-evolution cycle (or resident loop)
 *   hmh bench                run the evolution bench
 *   hmh skills [--promote|--rollback|--unpromote <name>]
 * Flags: --yes / -y / --yolo   auto-approve gated tools (Claude-Code-style alias;
 *        --locale=zh|en override the UI locale for this run.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { stopWebDaemon, startWebDaemon, hmhWebUp, readWebPid } from './web-daemon.ts';
import {
  chat,
  homeDir,
  resolveProvider,
  initHome,
  latestSession,
  listProviders,
  loadConfig,
  loadTranscript,
  mcpServerTools,
  Registry,
  runLoop,
  setChatRoute,
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
import { baseTools, buildRegistry, buildSystemPrompt, runAgentTask, strings, type Locale } from '@hmh/agent';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function uiStrings(): Promise<ReturnType<typeof strings>> {
  const cfg = await loadConfig();
  return strings((cfg.locale ?? 'zh') as Locale);
}

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
  let cfg = await loadConfig();
  const t = strings((cfg.locale ?? 'zh') as Locale);
  const header = () => stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`));
  stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`) + DIM(`${t.replHint} · /help ${String(t.cmdHelp)}\n\n`));
  const { reg, clients } = await buildRegistry();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  // stdin EOF (piped input, closed terminal) must exit the loop - a bare
  // rl.question() promise never settles after close, which would hang
  const closed = new Promise<never>((_, reject) => rl.on('close', () => reject(new Error('stdin closed'))));
  // The REPL keeps conversation memory across its own lines (and any
  // resumed history); each line re-injects fresh memory/skills.
  let history: ChatMessage[] = initialHistory ? [...initialHistory] : [];
  try {
    while (true) {
      let line: string;
      try {
        line = await Promise.race([rl.question(CYAN('hmh> ')), closed]);
      } catch {
        break;
      }
      line = line.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line.startsWith('/')) {
        // same command set as the TUI palette, line-mode
        if (line === '/help' || line === '?') {
          const { COMMANDS } = await import('./tui.ts');
          stdout.write(COMMANDS.map((c) => '  ' + c.name.padEnd(11) + ' ' + String(t[c.key as keyof typeof t])).join('\n') + '\n');
          continue;
        }
        if (line === '/model' || line.startsWith('/model ')) {
          const mArg = line.slice(7).trim();
          if (!mArg) {
            const rows = listProviders(cfg).map((v) => `  ${v.purposes.includes('chat') ? GREEN('●') : DIM('○')} ${v.name} — ${v.model}${v.purposes.length ? DIM(` (${v.purposes.join('/')})`) : ''}`);
            stdout.write(rows.join('\n') + '\n' + DIM('  /model <name> 切换 chat 路由') + '\n');
            continue;
          }
          try {
            cfg = await setChatRoute(mArg);
            stdout.write(GREEN('✓') + ` chat → ${mArg} · ${resolveProvider(cfg, 'chat').model}\n`);
          } catch (err) {
            stdout.write(YELLOW(`${String(err)}\n`));
          }
          continue;
        }
        if (line === '/tools') {
          for (const tool of reg.list()) printTool(tool);
          continue;
        }
        if (line === '/skills') {
          const active = await listSkills(home);
          const drafts = await listDrafts(home);
          stdout.write(CYAN(`${t.active} (${active.length})\n`));
          stdout.write(active.length ? active.map((s) => `  ${s.name} — ${s.description}`).join('\n') + '\n' : DIM(`  ${t.none}\n`));
          stdout.write(CYAN(`${t.drafts} (${drafts.length})\n`));
          stdout.write(drafts.length ? drafts.map((s) => `  ${s.name} — ${s.description}`).join('\n') + '\n' : DIM(`  ${t.none}\n`));
          continue;
        }
        if (line === '/mcp') {
          for (const [name, c] of Object.entries(cfg.mcpServers ?? {})) {
            stdout.write(`  ${name} — ${c.type}${c.trusted ? ' · trusted' : ' · gated'}\n`);
          }
          continue;
        }
        if (line === '/status') {
          header();
          continue;
        }
        if (line === '/web') {
          stdout.write(DIM(t.tuiWebHint + '\n'));
          continue;
        }
        if (line === '/ops' || line === '/ops scan') {
          const { harmonyOpsStatus, harmonyOpsRadarScan } = await import('@hmh/domain-ops');
          const r = line === '/ops'
            ? await harmonyOpsStatus.execute({}, { cwd: process.cwd(), home })
            : await harmonyOpsRadarScan.execute({}, { cwd: process.cwd(), home });
          stdout.write(r.output + '\n');
          continue;
        }
        if (line === '/bench') {
          const { results, passRate } = await runBench(home, (c) => makeCaseRunner()(c, ''));
          for (const r of results) stdout.write(`${r.pass ? GREEN(t.pass) : YELLOW(t.fail)} ${r.name} — ${r.detail}\n`);
          stdout.write(`pass rate: ${(passRate * 100).toFixed(0)}%\n`);
          continue;
        }
        if (line === '/evolve') {
          const report = await runEvolution({
            home,
            provider: resolveProvider(cfg, 'evolve'),
            runCase: makeCaseRunner(),
            log: (l) => stdout.write(DIM(`  ${l}\n`)),
          });
          stdout.write(t.tuiEvolveDone(report.proposals.length, report.insightCount, report.noteCount) + '\n');
          continue;
        }
        stdout.write(YELLOW(`unknown command: ${line} (/help)\n`));
        continue;
      }
      try {
        const r = await runTask(line, { yes, sharedRl: rl, registry: reg, clients, resumeMessages: history });
        // working transcript = [system, ...resumeMessages, user, ...new turns];
        // only the NEW turns (past the replayed prefix) extend history.
        history = [...history, { role: 'user', content: line }, ...r.messages.slice(history.length + 2)];
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
      const r = await chat(resolveProvider(cfg, 'bench'), [{ role: 'user', content: c.prompt }]);
      return r.message.content ?? '';
    }
    const reg = new Registry();
    reg.registerAll(baseTools).registerAll(harmonyTools);
    const system = buildSystemPrompt({
      cwd: process.cwd(),
      home: homeDir(),
      memory: '',
      skills: skillsPrompt,
      insights: '',
      model: cfg.provider.model,
    });
    const res = await runLoop({
      provider: resolveProvider(cfg, 'bench'),
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
  // --yolo is the Claude-Code-style alias of --yes (auto-approve gates;
  // the kernel's destructive-command hard-deny always stays on)
  const yes = rawArgs.some((a) => a === '--yes' || a === '-y' || a === '--yolo');
  // --locale=zh|en overrides the configured locale for this run (kernel's
  // loadConfig honours HMH_LOCALE), so every command - task, REPL, TUI, web -
  // picks it up without touching config.json
  const localeArg = rawArgs.find((a) => a.startsWith('--locale=') && a.length > 9);
  if (localeArg === '--locale=zh' || localeArg === '--locale=en') process.env.HMH_LOCALE = localeArg.slice(9);
  const args = rawArgs.filter((a) => a !== '--yes' && a !== '-y' && a !== '--yolo' && !a.startsWith('--locale='));
  const [cmd, ...rest] = args;
  const arg = rest.join(' ');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    stdout.write(`hmh - self-evolving agent harness for HarmonyOS development

usage:
  hmh "do something"       one-shot task (full agent loop, streaming)
  hmh                      interactive REPL (conversation memory kept, /help for commands)
  hmh resume [id-prefix]   continue a past session by id prefix (or latest)
  hmh web start|stop|status   web UI as a silent background daemon (no window,
                             survives closing everything; log ~/.hmharness/web.log)
  hmh web [--port=7788]       web UI in the foreground (debugging)
  hmh tui [--no-web]      fullscreen terminal UI (slash palette, mouse wheel);
                           also starts the web UI in the background (--no-web skips)
  hmh ops [scan|brief|status]  ops keeper: ecosystem radar
  hmh devices|check        direct tool run, no model
  hmh tools                list all registered tools (native + MCP)
  hmh mcp                  show configured MCP servers and their tools
  hmh evolve [--every=N]   self-evolution cycle (or resident loop)
  hmh bench                run the evolution bench
  hmh skills [--promote|--rollback|--unpromote <name>]

flags:
  --yes / -y          auto-approve gated tools (else they prompt; non-TTY denies)
  --locale=zh|en      override the UI locale for this run
  --help | -h         this help
`);
    return;
  }
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
    const t = await uiStrings();
    const runCycle = async (n: number) => {
      stdout.write(CYAN('evolve') + DIM(` · ${t.evolveCycle(cfg.provider.model, n)}${everyMin ? '' : ' (one-shot)'}\n`));
      const report = await runEvolution({
        home: homeDir(),
        provider: resolveProvider(cfg, 'evolve'),
        runCase: makeCaseRunner(),
        maxProposals: Number.isFinite(maxN) ? Math.min(Math.max(maxN, 0), 4) : 2,
        log: (l) => stdout.write(DIM(`  ${l}\n`)),
      });
      for (const o of report.outcomes) {
        const tag = o.action === 'promoted' ? GREEN(t.promoted) : o.action === 'rejected' ? YELLOW(t.rejected) : YELLOW(t.errorLabel);
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
  if (cmd === 'providers') {
    await initHome();
    const cfg = await loadConfig();
    const { readFile } = await import('node:fs/promises');
    const { detectLocalProviders, listProviders, PROVIDER_PRESETS, addProviders } = await import('@hmh/kernel');
    stdout.write(CYAN(`configured (${listProviders(cfg).length})\n`));
    for (const v of listProviders(cfg)) {
      stdout.write(`  ${v.purposes.includes('chat') ? GREEN('●') : DIM('○')} ${v.name} — ${v.model}${v.purposes.length ? DIM(` (${v.purposes.join('/')})`) : ''}\n`);
    }
    const found = await detectLocalProviders(cfg, readFile);
    if (!found.length) {
      stdout.write(DIM('no new local providers detected (env vars / opencode config)\n'));
      return;
    }
    stdout.write(CYAN(`detected locally (${found.length})\n`));
    for (const p of found) stdout.write(`  ${YELLOW('+')} ${p.name} — ${p.model} (${p.envVar})\n`);
    if (rest.includes('--scan')) {
      const r = await addProviders(found.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })));
      stdout.write(GREEN('✓') + ` added ${r.added.length}: ${r.added.join(', ')} — hmh /model or hmh tui "/model <name>" to use\n`);
    } else {
      stdout.write(DIM('run "hmh providers --scan" to add them to config.json\n'));
    }
    void PROVIDER_PRESETS;
    return;
  }
  if (cmd === 'ops') {
    await initHome();
    const { harmonyOpsRadarScan, harmonyOpsRadarBrief, harmonyOpsStatus } = await import('@hmh/domain-ops');
    const sub = rest[0] ?? 'status';
    const ctx = { cwd: process.cwd(), home: homeDir() };
    if (sub === 'scan') {
      const r = await harmonyOpsRadarScan.execute({}, ctx);
      stdout.write(r.output + '\n');
    } else if (sub === 'brief') {
      const r = await harmonyOpsRadarBrief.execute({}, ctx);
      stdout.write(r.output + '\n');
    } else {
      const r = await harmonyOpsStatus.execute({}, ctx);
      stdout.write(r.output + '\n');
    }
    return;
  }
  if (cmd === 'tui') {
    await initHome();
    // tui(yes, noWeb): inside the TTY check the TUI auto-links the web UI
    const { tui } = await import('./tui.ts');
    await tui(yes, rest.includes('--no-web'));
    return;
  }
  if (cmd === 'web') {
    await initHome();
    const port = Number(rest.find((a) => a.startsWith('--port='))?.slice(7) ?? 7788);
    const t = await uiStrings();
    const sub = rest.find((a) => !a.startsWith('-'));
    if (sub === 'stop') {
      stdout.write(stopWebDaemon() ? t.webStopped + '\n' : t.webNotRunning + '\n');
      return;
    }
    if (sub === 'status') {
      const up = await hmhWebUp(Number.isFinite(port) ? port : 7788);
      stdout.write(up ? t.webRunning(readWebPid() || 0, port) + '\n' : t.webNotRunning + '\n');
      return;
    }
    if (sub === 'start') {
      const r = startWebDaemon(Number.isFinite(port) ? port : 7788);
      if (r.already) {
        stdout.write(t.webRunning(r.pid, port) + '\n');
      } else {
        stdout.write(t.webStarted(Number.isFinite(port) ? port : 7788, join(homeDir(), 'web.log')) + '\n');
      }
      return;
    }
    // default: foreground server (handy for debugging)
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
