/**
 * @hmh/cli - tui (lite)
* A zero-dependency terminal UI: persistent status header (model · locale ·
 * skills · busy), colored streaming output, and slash commands that act in
 * place (/tools /skills /ops /bench /status). The full alt-screen TUI was
 * deliberately traded away - the web frontend covers that experience; this
 * keeps the terminal path rich without a single dependency.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, homeDir, resolveProvider, type ChatMessage } from '@hmh/kernel';
import { listDrafts, listSkills, runBench, runEvolution } from '@hmh/evolution';
import { buildRegistry, runAgentTask, strings, type Locale } from '@hmh/agent';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;

export async function tui(yes: boolean): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  const t = strings((cfg.locale ?? 'zh') as Locale);
  const { reg, clients } = await buildRegistry({ announce: false });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const header = async (busy = false) => {
    const skills = await listSkills(home);
    const line = `${BOLD('hmh tui')} ${DIM('·')} ${CYAN(cfg.provider.model)} ${DIM('· ' + (cfg.locale ?? 'zh'))} ${DIM('· ' + skills.length + ' skills')} ${busy ? YELLOW('● ' + t.running) : GREEN('○ ' + t.idle)}`;
    stdout.write(`\x1b[s\x1b[1G\x1b[K${line}\x1b[u`);
  };

  await header();
  stdout.write(DIM(t.replHint + ' · /help 查看命令\n\n'));

  let history: ChatMessage[] = [];
  try {
    while (true) {
      let line: string;
      try {
        // dsh-style one-line status above the prompt each turn
        stdout.write(DIM(`  ${cfg.provider.model} · ${(cfg.locale ?? 'zh')} · ? help · /exit\n`));
        line = (await rl.question(CYAN('\u276F '))).trim();
      } catch {
        break; // stdin closed (EOF / Ctrl-D) - exit cleanly
      }
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      if (line === '?' || line === '/help') {
        stdout.write([
          '  /tools    list registered tools (gated marked)',
          '  /skills   skill library (active + drafts)',
          '  /ops      ops keeper status · /ops scan  ecosystem radar',
          '  /bench    quick bench (non-loop cases)',
          '  /evolve   one evolution cycle',
          '  /mcp      configured MCP servers',
          '  /status   refresh header · /clear empty the screen',
          '  /web      hint: launch the browser UI (hmh web --port=7788)',
          '  /exit     quit',
        ].join('\n') + '\n');
        continue;
      }
      if (line === '/clear') {
        stdout.write('\x1b[2J\x1b[H');
        await header();
        continue;
      }
      if (line === '/mcp') {
        const cfg = await loadConfig();
        const servers = Object.entries(cfg.mcpServers ?? {});
        if (servers.length === 0) stdout.write('  (no MCP servers configured)\n');
        for (const [name, c] of servers) stdout.write(`  ${name} — ${c.type}${c.trusted ? ' · trusted' : ' · gated'}\n`);
        continue;
      }
      if (line === '/evolve') {
        await header(true);
        try {
          const cfg = await loadConfig();
          const report = await runEvolution({
            home,
            provider: resolveProvider(cfg, 'evolve'),
            runCase: async (c) => {
              if (!c.tools) {
                const { chat } = await import('@hmh/kernel');
                const r = await chat(resolveProvider(cfg, 'bench'), [{ role: 'user', content: c.prompt }]);
                return r.message.content ?? '';
              }
              return `(skipped in tui; run 'hmh evolve')`;
            },
            log: (l) => stdout.write(DIM(`  ${l}\n`)),
          });
          for (const o of report.outcomes) stdout.write(`  ${o.action === 'promoted' ? GREEN(t.promoted) : YELLOW(o.action === 'rejected' ? t.rejected : t.errorLabel)} ${o.name} — ${o.reason}\n`);
        } catch (err) {
          stdout.write(YELLOW(`evolve failed: ${String(err).slice(0, 140)}\n`));
        }
        await header();
        continue;
      }
      if (line === '/ops scan') {
        const { harmonyOpsRadarScan } = await import('@hmh/domain-ops');
        await header(true);
        const r = await harmonyOpsRadarScan.execute({}, { cwd: process.cwd(), home });
        stdout.write(r.output.split('\n').slice(0, 12).join('\n') + '\n');
        await header();
        continue;
      }
      if (line === '/tools') {
        for (const tool of reg.list()) {
          stdout.write(`  ${tool.name}${tool.needsApproval ? YELLOW(' [gated]') : ''} — ${tool.description.split('\n')[0].slice(0, 90)}\n`);
        }
        continue;
      }
      if (line === '/skills') {
        const active = await listSkills(home);
        const drafts = await listDrafts(home);
        for (const s of active) stdout.write(`  ${GREEN('+')} ${s.name} — ${s.description}\n`);
        for (const s of drafts) stdout.write(`  ${YELLOW('~')} ${s.name} — ${s.description}\n`);
        if (active.length + drafts.length === 0) stdout.write(`  ${t.none}\n`);
        continue;
      }
      if (line === '/ops') {
        const { harmonyOpsStatus } = await import('@hmh/domain-ops');
        const r = await harmonyOpsStatus.execute({}, { cwd: process.cwd(), home });
        stdout.write(r.output + '\n');
        continue;
      }
      if (line === '/status') {
        await header();
        continue;
      }
      if (line === '/bench') {
        await header(true);
        const { results, passRate } = await runBench(home, async (c) => {
          // plain model call keeps the TUI bench fast; loop cases fall back
          // to the dedicated `hmh bench` command
          const { chat } = await import('@hmh/kernel');
          if (c.tools) return `(skipped in tui; run 'hmh bench')`;
          const r = await chat(cfg.provider, [{ role: 'user', content: c.prompt }]);
          return r.message.content ?? '';
        });
        for (const r of results) stdout.write(`${r.pass ? GREEN(t.pass) : YELLOW(t.fail)} ${r.name} — ${r.detail}\n`);
        stdout.write(`pass rate: ${(passRate * 100).toFixed(0)}%\n`);
        await header();
        continue;
      }

      // ---- a real task ----
      await header(true);
      let displayMode: 'none' | 'reasoning' | 'text' = 'none';
      let streamed = false;
      // dsh-tui style line types: user bubble / thinking / tool cards with gutter
      const openMode = (m: 'reasoning' | 'text') => {
        if (displayMode !== m) {
          if (displayMode === 'reasoning') stdout.write('\n');
          if (m === 'reasoning') stdout.write(DIM('\u2234 Thinking\u2026 '));
          displayMode = m;
        }
      };
      stdout.write(`\x1b[48;5;236m \x1b[0m ${BOLD('\u276F')} ${line}\n`);
      let tokIn = 0;
      let tokOut = 0;
      try {
        const result = await runAgentTask({
          task: line,
          registry: reg,
          cfg,
          yes,
          resumeMessages: history,
          events: {
            onLine: (l) => stdout.write(DIM(`  ${l}\n`)),
            onDelta: (kind, chunk) => {
              if (kind === 'reasoning') {
                openMode('reasoning');
                stdout.write(DIM(chunk));
              } else {
                openMode('text');
                streamed = true;
                stdout.write(chunk);
              }
            },
            onToolCall: (name, args) => {
              if (displayMode !== 'none') {
                stdout.write('\n');
                displayMode = 'none';
              }
              stdout.write(`${YELLOW('\u25CF')} ${CYAN(BOLD(name))} ${DIM(JSON.stringify(args).slice(0, 90))}\n`);
            },
            onToolResult: (name, output, isError) => {
              const dot = isError ? YELLOW('\u2717') : GREEN('\u2022');
              stdout.write(`  ${dot} ${DIM('\u23BF ' + output.split('\n').slice(0, 3).join(' ').slice(0, 120))}\n`);
            },
          },
        });
        tokIn += result.usage.promptTokens;
        tokOut += result.usage.completionTokens;
        stdout.write(streamed ? '\n\n' : '\n' + result.text + '\n\n');
        stdout.write(DIM(t.sessionFooter(result.sessionId, result.turns, result.toolUses) + '\n'));
        if (tokIn + tokOut > 0) {
          stdout.write(DIM('\u2191' + tokIn + ' \u2193' + tokOut + ' tok\n'));
        }
        // only the NEW turns (past the replayed prefix) extend history
        history = [...history, { role: 'user', content: line }, ...result.messages.slice(history.length + 2)];
      } catch (err) {
        stdout.write(YELLOW(`error: ${String(err)}\n`));
      }
      await header();
    }
  } finally {
    rl.close();
    for (const c of clients) c.close();
    stdout.write('\n');
  }
}
