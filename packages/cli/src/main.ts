#!/usr/bin/env node
/**
 * @hmharness/cli - main (terminal frontend)
 * Usage:
 *   hmh init                 create HMH_HOME skeleton + config
 *   hmh "do something"       one-shot task (full agent loop, streaming)
 *   hmh                      interactive REPL (conversation memory kept)
 *   hmh resume [id-prefix|--last] continue a past session (bare: codex-style picker)
 *   hmh web [--port=7788]    local web frontend (SSE streaming + approvals)
 *   hmh tui                  lite terminal UI (status header + slash commands)
 *   hmh ops [scan|brief|stats|status]  ops keeper: radar / npm download stats
 *   hmh devices|check        direct tool run, no model
 *   hmh tools                list all registered tools (native + MCP)
 *   hmh mcp                  show configured MCP servers and their tools
 *   hmh evolve [--every=N]   self-evolution cycle (or resident loop)
 *   hmh bench                run the evolution bench
 *   hmh skills [--promote|--rollback|--unpromote <name>]
  hmh skills add <git-url-or-local-dir>   install skills (multi-skill packs supported)
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
  listSessions,
  loadConfig,
  loadTranscript,
  mcpServerTools,
  Registry,
  runLoop,
  setChatRoute,
  setLocale,
  type ChatMessage,
  type McpClient,
  type McpServerImport,
  type McpServerConfig,
  type Tool,
} from '@hmharness/kernel';
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
} from '@hmharness/evolution';
import { harmonyTools } from '@hmharness/domain-harmony';
import { baseTools, buildRegistry, buildSystemPrompt, runAgentTask, strings, type Locale } from '@hmharness/agent';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

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
  /** append to this rollout instead of starting a new one (codex Resume) */
  sessionId?: string;
}

async function runTask(task: string, taskOpts: TaskOptions = {}): Promise<{ messages: ChatMessage[]; sessionId: string }> {
  const cfg = await loadConfig();
  const { reg, clients } = taskOpts.registry
    ? { reg: taskOpts.registry, clients: taskOpts.clients ?? [] }
    : await buildRegistry({ announce: false });
  void clients;

  // Live output state: reasoning arrives dimmed and prefixed, final text plain.
  const zt = strings((cfg.locale ?? 'zh') as Locale);
  let displayMode: 'none' | 'reasoning' | 'text' = 'none';
  let streamedText = false;
  const openMode = (m: 'reasoning' | 'text') => {
    if (displayMode !== m) {
      if (displayMode === 'reasoning') stdout.write('\n');
      if (m === 'reasoning') stdout.write(DIM('\n' + zt.thinkingLabel));
      displayMode = m;
    }
  };

  const result = await runAgentTask({
    task,
    registry: reg,
    cfg,
    yes: taskOpts.yes,
    resumeMessages: taskOpts.resumeMessages,
    sessionId: taskOpts.sessionId,
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

async function repl(yes: boolean, initialHistory?: ChatMessage[], initialSessionId?: string): Promise<void> {
  const home = homeDir();
  let cfg = await loadConfig();
  let autoApprove = yes;
  let t = strings((cfg.locale ?? 'zh') as Locale);
  const header = () => stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`));
  stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`) + DIM(`${t.replHint} · /help ${String(t.cmdHelp)}\n\n`));
  // npm is pull-based; the update reminder is a cached (1/day) registry
  // check printed when resolved - never blocks, never nags offline
  const { notifyUpdate } = await import('./update-check.ts');
  const { createRequire } = await import('node:module');
  const CURRENT_VERSION = createRequire(import.meta.url)('../package.json').version as string;
  void notifyUpdate(home, CURRENT_VERSION, (latest) => {
    stdout.write(DIM(`↑ ${t.updateHint(latest)}\n\n`));
  });
  const { reg, clients } = await buildRegistry();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  // stdin EOF (piped input, closed terminal) must exit the loop - a bare
  // rl.question() promise never settles after close, which would hang
  const closed = new Promise<never>((_, reject) => rl.on('close', () => reject(new Error('stdin closed'))));
  // The REPL keeps conversation memory across its own lines (and any
  // resumed history); each line re-injects fresh memory/skills.
  let history: ChatMessage[] = initialHistory ? [...initialHistory] : [];
  // one rollout per conversation: the first task creates it, later lines and
  // `hmh resume` sessions append to it (codex thread semantics)
  let currentSessionId: string | undefined = initialSessionId;
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
        if (line === '/yolo' || line === '/yolo on' || line === '/yolo off') {
          const turnOn = line === '/yolo' ? !autoApprove : line === '/yolo on';
          autoApprove = turnOn;
          stdout.write((turnOn ? YELLOW(t.yoloOn) : DIM(t.yoloOff)) + '\n');
          continue;
        }
        if (line === '/lang' || line.startsWith('/lang ')) {
          const { nextLocale } = await import('./tui.ts');
          const target = nextLocale(cfg.locale ?? 'zh', line.slice(5));
          cfg = await setLocale(target);
          t = strings(target);
          stdout.write(GREEN('✓') + ' ' + t.langSwitched(target) + '\n');
          continue;
        }
        if (line === '/help' || line === '?') {
          const { COMMANDS } = await import('./tui.ts');
          stdout.write(COMMANDS.map((c) => '  ' + c.name.padEnd(11) + ' ' + String(t[c.key as keyof typeof t])).join('\n') + '\n');
          continue;
        }
        if (line === '/model' || line.startsWith('/model ')) {
          const mArg = line.slice(7).trim();
          if (!mArg) {
            // line-mode REPL has no live palette: the list IS the menu,
            // the hint tells how to act on it (i18n, was hardcoded zh)
            const rows = listProviders(cfg).map((v) => `  ${v.purposes.includes('chat') ? GREEN('●') : DIM('○')} ${v.name} — ${v.model}${v.purposes.length ? DIM(` (${v.purposes.join('/')})`) : ''}`);
            stdout.write(rows.join('\n') + '\n' + DIM(t.cmdModelHint) + '\n');
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
        if (line === '/providers' || line === '/providers scan') {
          // same capability as the TUI: probe local keys, optionally write
          // them in (was REPL-missing -> 'unknown command' while /help
          // advertised it, a scan-D gap)
          const { readFile } = await import('node:fs/promises');
          const { detectLocalProviders, addProviders } = await import('@hmharness/kernel');
          const found = await detectLocalProviders(cfg, readFile);
          if (line === '/providers') {
            stdout.write(found.length
              ? found.map((p) => `  ${YELLOW('+')} ${p.name} — ${p.model} (${p.envVar})`).join('\n') + '\n' + DIM(t.cmdProvidersScanHint) + '\n'
              : DIM(t.cmdProvidersListed) + '\n');
          } else if (!found.length) {
            stdout.write(DIM(t.cmdProvidersNone) + Object.keys(cfg.providers ?? {}).join(', ') + '\n');
          } else {
            const r = await addProviders(found.map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })));
            cfg = r.cfg;
            stdout.write(GREEN('✓') + ' ' + t.cmdProvidersAdded(r.added.length, r.added.join(', ')) + '\n');
          }
          continue;
        }
        if (line === '/clear') {
          // line-mode twin of the TUI /clear: clear the conversation so the
          // next task starts fresh (REPL counterpart was missing)
          history = [];
          currentSessionId = undefined;
          stdout.write(DIM(t.cmdClearDone) + '\n');
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
          const { harmonyOpsStatus, harmonyOpsRadarScan } = await import('@hmharness/domain-ops');
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
        stdout.write(YELLOW(t.unknownCommand(line) + '\n'));
        continue;
      }
      try {
        const r = await runTask(line, { yes: autoApprove, sharedRl: rl, registry: reg, clients, resumeMessages: history, sessionId: currentSessionId });
        // working transcript = [system, ...resumeMessages, user, ...new turns];
        // only the NEW turns (past the replayed prefix) extend history.
        history = [...history, { role: 'user', content: line }, ...r.messages.slice(history.length + 2)];
        // one rollout per REPL conversation (codex thread semantics)
        currentSessionId = r.sessionId;
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
  hmh resume [id-prefix|--last]   continue a past session (bare = full-screen picker,
                             --last = newest session in this directory)
  hmh project [status|checkpoint <label>|restore <id>|pause|resume|complete|
               archive|release <ver>]   project runtime: git-plumbing
                             checkpoints (your tree untouched), sandbox
                             materialization, run continuation (V2 M8)
  hmh experiment [list|show <id>|run <id> [--cases=N]|promote <id> [--human]|
               rollback <target>]   evolution candidates: control/treatment
                             bench arms + statistical promotion gate (V2 M9)
  hmh dataset [list|build [ver]|show <ver> [--train|--eval]]
                             trajectory -> versioned, redacted, split dataset (V2 M10)
  hmh route                  shadow-router stats: agreement rate + outcome split (V2 M10)
  hmh readiness              the RL gate: six conditions measured from real evidence (V2 M11)
  hmh pipeline "<task>"      role pipeline: plan→code→test→review→judge (+repair loop,
                             VERDICT gate) - V3 first slice (ADR-0006)
  hmh web start|stop|status   web UI as a silent background daemon (no window,
                             survives closing everything; log ~/.hmharness/web.log)
  hmh web [--port=7788]       web UI in the foreground (debugging)
  hmh tui [--no-web]      fullscreen terminal UI (slash palette, mouse wheel);
                           also starts the web UI in the background (--no-web skips)
  hmh ops [scan|brief|stats|status]  ops keeper: radar / npm download stats
  hmh mcp-serve        run as an MCP stdio SERVER: expose harmony_* tools to
                        Claude Code / Codex / any MCP host
                        (host config: npx -y @hmharness/cli mcp-serve)
  hmh devices|check        direct tool run, no model
  hmh tools                list all registered tools (native + MCP)
  hmh mcp                  show configured MCP servers and their tools
  hmh evolve [--every=N]   self-evolution cycle (or resident loop)
  hmh bench [--impact]     run the evolution bench / canary A/B report
  hmh skills [--promote|--rollback|--unpromote <name>]
  hmh skills add <git-url-or-local-dir>   install skills (multi-skill packs supported)
  hmh state backup [--full] | restore [id] | remove <id|--all> | list
                           snapshot / recover the evolution state (skills,
                           memory, insights, logs); restore parks current
                           state in a .pre-restore copy first

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
  if (cmd === 'mcp-serve') {
    // SERVER mode: expose the harmony_* tool surface over stdio MCP so
    // Claude Code / Codex / any MCP host calls them natively. stdout is the
    // protocol - run this exactly as the host's server command.
    const { serveMcp } = await import('./mcp-server.ts');
    await serveMcp();
    return; // serveMcp exits when stdin closes
  }
  if (cmd === 'skills') {
    const home = homeDir();
    const flag = rest.find((a) => a.startsWith('--'));
    const skillName = rest.find((a) => !a.startsWith('-') && !a.startsWith('--') && a !== 'add');
    if (rest[0] === 'add' || flag === '--add') {
      // install from a git URL or local dir (multi-skill packs supported)
      if (!skillName) {
        stdout.write(`usage: hmh skills add <git-url-or-local-dir>\n`);
        return;
      }
      const { installSkills } = await import('@hmharness/evolution');
      try {
        const r = await installSkills(skillName, home);
        stdout.write(r.installed.length
          ? GREEN('✓') + ` installed ${r.installed.length} skill(s): ${r.installed.join(', ')}\n` + DIM(`verify: hmh skills\n`)
          : DIM('no installable skills found (looked for SKILL.md at root, skills/*/, or */SKILL.md)\n'));
        if (r.skipped.length) stdout.write(DIM(`skipped (already present): ${r.skipped.join(', ')}\n`));
      } catch (err) {
        stdout.write(YELLOW(`install failed: ${String(err).slice(0, 300)}\n`));
      }
      return;
    }
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
    // `hmh bench --impact`: the canary A/B report - which experimental
    // skills earned full activation on evidence, which retired, which
    // need more data. The observability half of self-evolution (P0).
    if (rest.includes('--impact')) {
      const { impactReport } = await import('@hmharness/evolution');
      const { rows, applied } = await impactReport(homeDir());
      if (rows.length === 0) {
        stdout.write(DIM('no canary skills under evaluation\n'));
        return;
      }
      for (const r of rows) {
        const badge = r.verdict === 'promote' ? GREEN('PROMOTE') : r.verdict === 'retire' ? YELLOW('RETIRE') : r.verdict === 'keep' ? GREEN('KEEP') : DIM('needs data');
        stdout.write(`${badge.padEnd(10)} ${r.skill} — exposed ${r.exposed.sessions}s/${(r.exposed.okRate * 100).toFixed(0)}% vs control ${r.control.sessions}s/${(r.control.okRate * 100).toFixed(0)}%\n`);
      }
      if (applied.length) stdout.write('\n' + applied.map((a) => CYAN('✓ ') + a).join('\n') + '\n');
      else stdout.write(DIM('\n(no verdicts strong enough to act on - honesty over noise)\n'));
      return;
    }
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
    const { detectLocalProviders, listProviders, PROVIDER_PRESETS, addProviders } = await import('@hmharness/kernel');
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
    const { harmonyOpsRadarScan, harmonyOpsRadarBrief, harmonyOpsStatus } = await import('@hmharness/domain-ops');
    const sub = rest[0] ?? 'status';
    const ctx = { cwd: process.cwd(), home: homeDir() };
    if (sub === 'scan') {
      const r = await harmonyOpsRadarScan.execute({}, ctx);
      stdout.write(r.output + '\n');
    } else if (sub === 'brief') {
      const r = await harmonyOpsRadarBrief.execute({}, ctx);
      stdout.write(r.output + '\n');
    } else if (sub === 'stats') {
      // npm download counts for the seven packages (public API, no auth).
      const { fetchNpmStats, renderStats } = await import('./npm-stats.ts');
      try {
        stdout.write(renderStats(await fetchNpmStats()) + '\n');
      } catch {
        stdout.write('npm downloads API unreachable right now - try again later\n');
      }
    } else {
      const r = await harmonyOpsStatus.execute({}, ctx);
      stdout.write(r.output + '\n');
    }
    return;
  }
  if (cmd === 'state') {
    // The evolution state (skills+memory+insights+logs) is a single-point
    // asset; backup/restore/list keeps one bad JSONL from erasing the
    // agent's whole learning history. Restore always parks the current
    // state in a .pre-restore copy first (undoable by construction).
    await initHome();
    const { backupState, listBackups, restoreState, removeBackup } = await import('./state.ts');
    const sub = rest[0] ?? 'list';
    if (sub === 'backup') {
      const full = rest.includes('--full');
      const r = await backupState(homeDir(), { full });
      stdout.write(GREEN('✓') + ` backup ${r.id} (${r.items.length} items${full ? ', incl. sessions' : ''}) -> ${r.dir}\n`
        + DIM('restore with: hmh state restore ' + r.id + '\n'));
      return;
    }
    if (sub === 'restore') {
      const id = rest.find((a) => !a.startsWith('-') && a !== 'restore');
      const r = await restoreState(homeDir(), id);
      stdout.write(GREEN('✓') + ` restored ${r.id} (${r.restored.length} items)\n`
        + DIM(`current state parked at ${r.parked} (delete it if unwanted)\n`));
      return;
    }
    if (sub === 'remove') {
      const id = rest.find((a) => !a.startsWith('-') && a !== 'remove');
      if (!id && !rest.includes('--all')) { stdout.write('usage: hmh state remove <id | --all>\n'); return; }
      const removed = await removeBackup(homeDir(), id ?? '', { all: rest.includes('--all') });
      stdout.write(`removed ${removed.length} backup(s)\n`);
      return;
    }
    const list = await listBackups(homeDir());
    stdout.write(list.length
      ? list.map((b) => `  ${b.id}  ${b.items.length} items${b.full ? ' (full)' : ''}  ${b.time}`).join('\n') + '\n'
      : DIM('  no backups yet - run "hmh state backup"\n'));
    return;
  }
  if (cmd === 'replay') {
    // V2 M1: typed trajectory replay. Bare `hmh replay` lists recent runs;
    // `hmh replay <run-id>` renders the event timeline; --json dumps raw.
    await initHome();
    const { jsonlTrajectoryStore } = await import('@hmharness/observability');
    const store = jsonlTrajectoryStore(homeDir());
    const id = rest.find((a) => !a.startsWith('-'));
    if (!id) {
      const runs = await store.listRuns(20);
      stdout.write(runs.length
        ? runs.map((r) => {
            const okc = r.outcome ? (r.outcome.success ? GREEN('✓') : RED('✗')) : YELLOW('…');
            const m = r.metrics ? ` · ${r.metrics.turns ?? '?'}t/${r.metrics.toolUses ?? '?'}x` : '';
            return `  ${okc} ${r.runId}  ${DIM(r.task.slice(0, 52))}${m}`;
          }).join('\n') + '\n'
        : DIM('  no runs yet - every task now records a trajectory automatically\n'));
      return;
    }
    if (rest.includes('--json')) {
      stdout.write(await store.exportRun(id, 'json'));
      return;
    }
    const t = await store.getRun(id);
    if (t.events.length === 0) { stdout.write(DIM(`no trajectory found for ${id}\n`)); return; }
    const t0 = Date.parse(t.events[0].ts);
    stdout.write(`run ${id} · ${t.model ?? '?'} · ${t.task.slice(0, 80)}\n`);
    for (const e of t.events) {
      const off = String(Math.max(0, Date.parse(e.ts) - t0)).padStart(7);
      const icon = e.type.startsWith('tool.') ? CYAN('⚙') : e.type.startsWith('run.') ? (e.type === 'run.completed' ? GREEN('✓') : e.type === 'run.failed' ? RED('✗') : '▶') : e.type === 'error.observed' ? RED('!') : '·';
      stdout.write(`  +${off}ms ${icon} ${e.type.padEnd(20)} ${DIM(JSON.stringify(e.payload).slice(0, 110))}\n`);
    }
    if (t.outcome) {
      stdout.write(`  ${t.outcome.success ? GREEN('outcome: success') : RED('outcome: failed')} (${t.outcome.reason ?? '?'})`
        + (t.metrics ? ` · ${t.metrics.turns ?? '?'} turns · ${t.metrics.toolUses ?? '?'} tools · ↑${t.metrics.promptTokens ?? '?'} ↓${t.metrics.completionTokens ?? '?'} tok` : '') + '\n');
    }
    return;
  }

  if (cmd === 'eval') {
    // V2 M2: the Evaluator surface - hard evidence outranks LLM judgment.
    await initHome();
    const { allEvaluators } = await import('@hmharness/evaluation');
    const { listCases } = await import('@hmharness/evolution');
    const cases = await listCases(homeDir());
    stdout.write('evaluators:\n' + allEvaluators.map((e) => '  ' + e.id.padEnd(16) + DIM('rank ' + e.evidenceKind) + '  ' + e.description.slice(0, 70)).join('\n') + '\n');
    stdout.write('bench cases: ' + cases.length + ' (train ' + cases.filter((c) => !c.holdout).length + ' / holdout ' + cases.filter((c) => c.holdout).length + ')\n');
    return;
  }
  if (cmd === 'capability') {
    // V2 M4: capability manifests - declared risk/permissions per tool.
    await initHome();
    const { capabilityReport, authorize, buildRegistry } = await import('@hmharness/agent');
    const { reg } = await buildRegistry({ announce: false });
    const mode = rest.includes('--lockdown') ? 'lockdown' : 'standard';
    for (const m of capabilityReport(reg)) {
      const d = authorize(m, mode);
      stdout.write('  ' + (d.allow ? GREEN('allow') : RED('DENY ')) + '  ' + m.risk.padEnd(8) + m.id.padEnd(22) + DIM(m.permissions.join(',')) + '\n');
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
      // stale-daemon warning: the daemon is a code snapshot from spawn time;
      // after an upgrade it keeps serving old code until restarted
      const { webDaemonStale } = await import('./web-daemon.ts');
      const v = webDaemonStale();
      if (up && v.stale) {
        stdout.write(YELLOW(`⚠ daemon is running v${v.daemon} but CLI is v${v.cli} — stale code (new features missing). Run: hmh web stop && hmh web start\n`));
      } else if (up && v.daemon) {
        stdout.write(DIM(`daemon v${v.daemon}\n`));
      }
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
    const { startServer } = await import('@hmharness/web');
    await startServer({ port: Number.isFinite(port) ? port : 7788, host: '127.0.0.1' });
    return; // startServer keeps the process alive
  }
  if (cmd === 'pipeline') {
    // V3 first slice (ADR-0006): plan -> code -> test -> review -> judge with
    // a bounded repair loop; the judge's VERDICT line is the only stage gate.
    const task = rest.join(' ').trim();
    if (!task) { stdout.write('usage: hmh pipeline "<task>" [--repairs=N] [--turns=N]\n'); return; }
    await initHome();
    const home = homeDir();
    const cfg2 = await loadConfig();
    const { reg: preg, clients: preClients } = await buildRegistry({ announce: false });
    const A = await import('@hmharness/agent');
    stdout.write(DIM(`pipeline: plan → code → test → review → judge (route ${cfg2.provider.model})\n`));
    try {
      const r = await A.runPipeline({
        task,
        provider: resolveProvider(cfg2, 'chat'),
        registry: preg,
        ctx: { cwd: process.cwd(), home },
        model: cfg2.provider.model,
        home,
        locale: cfg2.locale,
        maxRepairs: Number((rest.find((a) => a.startsWith('--repairs=')) ?? '').slice(10)) || 2,
        maxTurnsPerStage: Number((rest.find((a) => a.startsWith('--turns=')) ?? '').slice(8)) || 6,
      });
      for (const s of r.stages) {
        const mark = s.verdict === 'PASS' ? GREEN('PASS') : s.verdict === 'FAIL' ? RED('FAIL') : DIM('····');
        stdout.write(`  ${mark} ${YELLOW(s.stage.padEnd(9))} #${s.attempt} ${DIM(`${s.turns}t ${s.toolUses}tools`)}\n`);
      }
      const verdict = r.finalVerdict === 'PASS' ? GREEN('VERDICT: PASS') : RED(`VERDICT: ${r.finalVerdict}`);
      stdout.write(`${verdict} ${DIM(`· status ${r.status} · repairs ${r.repairsUsed} · report ${home}\\pipelines\\${r.pipelineId}`)}\n`);
    } catch (err) {
      stdout.write(RED(String(err)) + '\n');
    } finally {
      for (const c of preClients) c.close();
    }
    return;
  }
  if (cmd === 'dataset') {
    // V2 M10: trajectory -> versioned dataset (filter/dedupe/reward/split)
    await initHome();
    const home = homeDir();
    const E = await import('@hmharness/evolution');
    const sub = rest[0] ?? 'list';
    if (sub === 'build') {
      const version = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      stdout.write(DIM('building dataset from runs/ …\n'));
      const r = await E.buildDataset(home, { version });
      const c = r.manifest.counts;
      stdout.write(GREEN('✓') + ` ${r.manifest.version}: scanned ${c.scanned} → kept ${c.kept} (dropped ${c.dropped}, dupes ${c.duplicates})\n`);
      stdout.write(`  train ${c.train} / eval ${c.eval} (seed ${r.manifest.splitSeed}) · filter ${r.manifest.filterFingerprint}\n`);
      stdout.write(`  dir: ${r.dir}\n`);
      return;
    }
    if (sub === 'list') {
      const all = await E.listDatasets(home);
      if (all.length === 0) { stdout.write('no dataset versions (hmh dataset build)\n'); return; }
      for (const m of all) stdout.write(`${CYAN(m.version)} ${DIM(m.createdAt)} · kept ${m.counts.kept} (train ${m.counts.train}/eval ${m.counts.eval}) · filter ${m.filterFingerprint}\n`);
      return;
    }
    if (sub === 'show') {
      const version = rest[1] ?? '';
      const split = rest.includes('--eval') ? 'eval' as const : rest.includes('--train') ? 'train' as const : undefined;
      const samples = await E.loadDataset(home, version, split);
      if (samples.length === 0) { stdout.write('no such dataset version or empty split\n'); return; }
      for (const s of samples.slice(0, 30)) {
        stdout.write(`${s.reward.toFixed(1)} ${s.outcome.padEnd(12)} ${YELLOW(`t${s.turns}`)} ${DIM(s.runId.slice(0, 22))} ${s.task.slice(0, 56).replace(/\s+/g, ' ')}\n`);
      }
      if (samples.length > 30) stdout.write(DIM(`… ${samples.length - 30} more\n`));
      return;
    }
    stdout.write('usage: hmh dataset [list|build [version]|show <version> [--train|--eval]]\n');
    return;
  }
  if (cmd === 'route') {
    // V2 M10 shadow router stats: how often the adaptive suggestion disagrees
    // with the live route, and whether disagreement correlates with outcomes
    await initHome();
    const home = homeDir();
    const { routingStats } = await import('@hmharness/kernel');
    const s = await routingStats(home);
    stdout.write(`routing outcomes: ${s.total} · shadow agreed ${s.agreed} (disagreement ${(s.disagreementRate * 100).toFixed(0)}%)\n`);
    for (const [reason, n] of Object.entries(s.byReason)) stdout.write(`  ${DIM(reason)}: ${n}\n`);
    if (s.successAgree !== null) stdout.write(`success when agreed: ${(s.successAgree * 100).toFixed(0)}%${s.successDisagree !== null ? ` · when disagreed: ${(s.successDisagree * 100).toFixed(0)}%` : ''}\n`);
    else stdout.write(DIM('agreement/success split needs >=8 labeled rows per side\n'));
    return;
  }
  if (cmd === 'readiness') {
    // V2 M11: the RL gate. All six conditions measured from real evidence;
    // closed gate names the optimization to do instead. No bypass exists.
    await initHome();
    const home = homeDir();
    const { rlReadiness } = await import('@hmharness/evolution');
    const r = await rlReadiness(home);
    stdout.write(BOLD(r.verdict === 'rl-eligible' ? GREEN('RL-ELIGIBLE') : YELLOW('OPTIMIZE-FIRST')) + '\n');
    for (const c of r.conditions) {
      const mark = c.met ? GREEN('✓') : RED('✗');
      stdout.write(`  ${mark} ${c.id.padEnd(28)} ${String(c.current).slice(0, 40)} (need: ${String(c.threshold).slice(0, 44)})\n`);
    }
    if (r.recommendedLever) stdout.write(DIM(`\nrecommended lever: ${r.recommendedLever} (skill/prompt/router optimization first - blueprint M11)\n`));
    return;
  }
  if (cmd === 'project') {
    // V2 M8 project runtime (ADR-0002): checkpoints are plumbing snapshots -
    // the user's index/refs/worktree are never touched; restore materializes
    // a sandbox copy. `hmh project` alone = status of the current workspace.
    await initHome();
    const home = homeDir();
    const A = await import('@hmharness/agent');
    const sub = rest[0] ?? 'status';
    if (sub === 'status') {
      const rec = await A.findProject(home, process.cwd());
      if (!rec) {
        stdout.write(`no project bound to ${process.cwd()}\n(hmh project checkpoint "<label>" starts one and snapshots it)\n`);
        return;
      }
      stdout.write(CYAN(`project ${rec.projectId}`) + DIM(` · ${rec.state} · ${rec.workspace}\n`));
      stdout.write(`  checkpoints: ${rec.checkpoints.length}${rec.checkpoints.length ? ' (latest ' + rec.checkpoints[rec.checkpoints.length - 1].id + ')' : ''}\n`);
      stdout.write(`  runs: ${rec.runs.length} · decisions: ${rec.decisions.length} · releases: ${rec.releases.length}\n`);
      for (const r of rec.releases) stdout.write(`  release ${GREEN(r.version)}${r.checkpointId ? DIM(' @' + r.checkpointId) : ''}\n`);
      return;
    }
    if (sub === 'checkpoint') {
      const label = rest.slice(1).join(' ').trim() || undefined;
      const rec = await A.projectFor(home, process.cwd());
      const cp = await A.checkpointProject(home, rec, label);
      stdout.write(GREEN('✓') + ` checkpoint ${cp.id} · ${cp.files} files${label ? ` · ${label}` : ''} (git objects only - your tree is untouched)\n`);
      return;
    }
    if (sub === 'restore') {
      const id = rest[1] ?? '';
      const rec = await A.findProject(home, process.cwd());
      if (!rec || !id) { stdout.write('usage: hmh project restore <checkpoint-id>\n'); return; }
      try {
        const session = await A.restoreCheckpoint(home, rec, id);
        stdout.write(GREEN('✓') + ` checkpoint ${id} materialized to sandbox copy:\n  ${session.dir}\n(inspect or run there - your workspace is untouched)\n`);
      } catch (err) {
        stdout.write(RED(String(err)) + '\n');
      }
      return;
    }
    if (sub === 'pause' || sub === 'resume' || sub === 'complete' || sub === 'archive') {
      const rec = await A.findProject(home, process.cwd());
      if (!rec) { stdout.write('no project bound to this directory\n'); return; }
      const next = sub === 'pause' ? 'paused' : sub === 'resume' ? 'active' : sub === 'complete' ? 'completed' : 'archived';
      try {
        const out = await A.transitionProject(home, rec, next as 'paused');
        stdout.write(GREEN('✓') + ` ${out.projectId} → ${out.state}\n`);
      } catch (err) {
        stdout.write(RED(String(err)) + '\n');
      }
      return;
    }
    if (sub === 'release') {
      const version = rest[1] ?? '';
      if (!version) { stdout.write('usage: hmh project release <version> [notes]\n'); return; }
      const rec = await A.findProject(home, process.cwd());
      if (!rec) { stdout.write('no project bound to this directory\n'); return; }
      await A.releaseProject(home, rec, version, rest.slice(2).join(' ') || undefined);
      stdout.write(GREEN('✓') + ` release ${version} pinned to latest checkpoint\n`);
      return;
    }
    stdout.write('usage: hmh project [status|checkpoint <label>|restore <id>|pause|resume|complete|archive|release <ver>]\n');
    return;
  }
  if (cmd === 'experiment') {
    // V2 M9 candidate experiments (ADR-0003): Control/Treatment bench arms +
    // two-proportion gate + promoted/rollback state. Agents never shortcut
    // the gate - promoteCandidate enforces the report.
    await initHome();
    const home = homeDir();
    const E = await import('@hmharness/evolution');
    const sub = rest[0] ?? 'list';
    if (sub === 'list') {
      const list = await E.listCandidates(home);
      const act = await E.activeVersions(home);
      if (list.length === 0) { stdout.write('no candidates registered\n'); return; }
      for (const c of list) {
        const rep = await E.latestExperiment(home, c.id);
        stdout.write(`${YELLOW(c.target.padEnd(12))} ${c.id} ${DIM(c.baseVersion + ' → ' + c.candidateVersion)}`
          + (rep ? ` · ${rep.verdict === 'promote-eligible' ? GREEN(rep.verdict) : rep.verdict === 'reject' ? RED(rep.verdict) : DIM(rep.verdict)}` : DIM(' · untested'))
          + (act[c.target] ? DIM(` · active: ${act[c.target].version}`) : '') + '\n');
      }
      return;
    }
    if (sub === 'show') {
      const c = await E.getCandidate(home, rest[1] ?? '');
      if (!c) { stdout.write('no such candidate\n'); return; }
      stdout.write(CYAN(`${c.target} ${c.id}`) + DIM(` ${c.baseVersion} → ${c.candidateVersion}\n`));
      stdout.write(`  hypothesis: ${c.hypothesis}\n  metric: ${c.expectedMetric} · origin: ${c.origin ?? '-'}\n`);
      const rep = await E.latestExperiment(home, c.id);
      if (rep) {
        stdout.write(`  latest: control ${rep.control.pass}/${rep.control.n} vs treatment ${rep.treatment.pass}/${rep.treatment.n}`
          + ` · diff ${(rep.diff * 100).toFixed(1)}% · p=${rep.p.toFixed(4)}\n`
          + `  verdict: ${rep.verdict} (${rep.reason})\n`);
      }
      return;
    }
    if (sub === 'run') {
      const id = rest[1] ?? '';
      const cand = await E.getCandidate(home, id);
      if (!cand) { stdout.write('no such candidate\n'); return; }
      const maxCases = Number((rest.find((a) => a.startsWith('--cases=')) ?? '').slice(9)) || 12;
      const cases = (await E.listCases(home)).filter((c) => !c.holdout);
      if (cases.length === 0) { stdout.write('no bench cases - run scripts/bench-cases-v2.cjs or seed first\n'); return; }
      stdout.write(DIM(`running ${Math.min(maxCases, cases.length)} gate cases x2 arms (bench route)…\n`));
      const armRun = async (c: BenchCase, arm: 'control' | 'treatment'): Promise<{ pass: boolean; tokens: number }> => {
        const runner = makeCaseRunner();
        const out = await runner(c, arm === 'treatment' ? (cand.payload ?? '') : '');
        return { pass: E.matchCase(out, c).pass, tokens: E.estTokens(c.prompt + out) };
      };
      const rep = await E.runCandidateExperiment(home, cand.id, { runCase: armRun, cases, maxCases });
      stdout.write(`control ${rep.control.pass}/${rep.control.n} · treatment ${rep.treatment.pass}/${rep.treatment.n}`
        + ` · diff ${(rep.diff * 100).toFixed(1)}% · p=${rep.p.toFixed(4)} · tokens ${rep.control.tokens}→${rep.treatment.tokens}\n`);
      stdout.write(rep.verdict === 'promote-eligible' ? GREEN(`verdict: ${rep.verdict} (${rep.reason})`) : rep.verdict === 'reject' ? RED(`verdict: ${rep.verdict} (${rep.reason})`) : DIM(`verdict: ${rep.verdict} (${rep.reason})`) + '\n');
      return;
    }
    if (sub === 'promote') {
      const id = rest[1] ?? '';
      const human = rest.includes('--human');
      const r = await E.promoteCandidate(home, id, { approvedByHuman: human });
      if (!r.ok) { stdout.write(RED('✗ ') + (r.error ?? '') + '\n'); return; }
      stdout.write(GREEN('✓') + ` ${r.active!.target} active → ${r.active!.version} (previous pointer saved; hmh experiment rollback <target>)\n`);
      return;
    }
    if (sub === 'rollback') {
      const target = rest[1] ?? '';
      const r = await E.rollbackCandidate(home, target as never);
      if (!r.ok) { stdout.write(RED('✗ ') + (r.error ?? '') + '\n'); return; }
      stdout.write(GREEN('✓') + ` ${target} rolled back to previous active version\n`);
      return;
    }
    stdout.write('usage: hmh experiment [list|show <id>|run <id> [--cases=N]|promote <id> [--human]|rollback <target>]\n');
    return;
  }
  if (cmd === 'resume') {    await initHome();
    const home = homeDir();
    // bare `hmh resume` on a TTY = codex `codex resume`: the TUI comes up
    // with the full-frame picker already open (typeahead, cwd filter, sort)
    if (!arg && !rest.includes('--last') && stdin.isTTY) {
      const { tui } = await import('./tui.ts');
      await tui(yes, false, { resumeAtStart: true });
      return;
    }
    // `--last`: newest rollout in THIS cwd (codex resume --last)
    let file: string | null = null;
    if (rest.includes('--last')) {
      const page = await listSessions(home, { cwd: process.cwd(), limit: 1 });
      file = page.items[0]?.file ?? null;
    } else {
      file = await latestSession(home, arg);
    }
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
    // repl keeps appending to THIS rollout for the whole conversation
    await repl(yes, tr.messages, tr.id);
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
