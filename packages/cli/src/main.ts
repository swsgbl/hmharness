#!/usr/bin/env node
/**
 * @hmh/cli - main
 * Usage:
 *   hmh init                 create HMH_HOME skeleton + config
 *   hmh "do something"       one-shot task (full agent loop)
 *   hmh                      interactive REPL
 *   hmh devices|check        direct tool run, no model
 *   hmh bench                run the evolution bench
 *   hmh skills               list the skill library
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homeDir, initHome, loadConfig, Registry, runLoop, Session, type ChatMessage } from '@hmh/kernel';
import { listSkills, loadMemory, recentInsights, recordInsight, skillsToPrompt, runBench } from '@hmh/evolution';
import { harmonyTools } from '@hmh/domain-harmony';
import { baseTools } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

async function buildRegistry(): Promise<Registry> {
  const reg = new Registry();
  reg.registerAll(baseTools).registerAll(harmonyTools);
  // MCP client tools attach here in Phase 1 (same registration surface).
  return reg;
}

async function contextPack() {
  const home = homeDir();
  const [memory, skills, insights] = await Promise.all([loadMemory(home), listSkills(home), recentInsights(home)]);
  return { memory, skills: skillsToPrompt(skills), insights };
}

async function runTask(task: string): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  const reg = await buildRegistry();
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

  const toolsUsed: string[] = [];
  const result = await runLoop({
    provider: cfg.provider,
    registry: reg,
    messages,
    ctx,
    maxTurns: cfg.maxTurns,
    events: {
      onToolCall: (name, args) => {
        toolsUsed.push(name);
        const brief = JSON.stringify(args).slice(0, 100);
        stdout.write(DIM(`  [tool] ${name} ${brief}\n`));
      },
      onToolResult: (name, output, isError) => {
        if (isError) stdout.write(DIM(`  [${name} ERROR] ${output.slice(0, 160)}\n`));
      },
      onAssistant: async (m) => {
        await session.assistant(m.content ?? null, m.tool_calls);
      },
    },
  });

  stdout.write('\n' + result.text + '\n\n');
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

async function repl(): Promise<void> {
  const home = homeDir();
  const cfg = await loadConfig();
  stdout.write(CYAN('hmh') + DIM(` · ${cfg.provider.model} · ${home}\n`) + DIM('type a task, or /exit to quit\n\n'));
  const rl = readline.createInterface({ input: stdin, output: stdout });
  while (true) {
    const line = (await rl.question(CYAN('hmh> '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    try {
      await runTask(line);
    } catch (err) {
      stdout.write(`error: ${String(err)}\n`);
    }
  }
  rl.close();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');

  if (cmd === 'init') {
    const { home, created } = await initHome();
    stdout.write(`home: ${home}\n${created.length ? 'created: ' + created.join(', ') : 'already initialized.'}\n`);
    return;
  }
  if (cmd === 'devices' || cmd === 'check') {
    await initHome();
    const tool = (await buildRegistry()).get(cmd === 'devices' ? 'harmony_devices' : 'harmony_toolchain_check')!;
    const r = await tool.execute({}, { cwd: process.cwd(), home: homeDir() });
    stdout.write(r.output + '\n');
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
    await runTask([cmd, ...rest].join(' '));
    return;
  }
  await initHome();
  await repl();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
