#!/usr/bin/env node
// hmh-codexhost bridge - streaming protocol v2
//
// Protocol (stdout, NDJSON):
//   {"type":"delta","text":"..."}    - final-answer text increment (coalesced, lossless)
//   {"type":"tool","phase":"call"|"done","name":"...","args":"..."} - tool activity
//   {"type":"line","text":"..."}     - agent loop status line
//   {"text":"...","sessionId":...}   - FINAL line (no .type) - authoritative result
//
// The FINAL line is emitted exactly once, then the process exits. Any
// background work inside the agent (self-evolution cycles etc.) must not
// keep this one-shot process alive - we exit hard after the final line.
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const { buildRegistry, runAgentTask } = await import("@hmharness/agent");
const { loadConfig, listProviders, homeDir } = await import("@hmharness/kernel");

function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function chatProvider(config) {
  const name = process.env.HMH_CHAT_PROVIDER;
  if (!name) return config;
  const provider = config.providers?.[name];
  if (!provider) throw new Error(`unknown provider "${name}"`);
  return { ...config, provider, routing: { ...config.routing, chat: name } };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const [command = "run", ...arguments_] = process.argv.slice(2);

try {
  if (command === "--version" || command === "-v") {
    emit({ version });
  } else if (command === "providers") {
    if (arguments_.includes("--json")) {
      const config = await loadConfig();
      emit({
        version,
        chat: config.routing?.chat ?? (config.providers && Object.keys(config.providers).length > 0 ? null : "default"),
        providers: listProviders(config).map(({ name, model, purposes }) => ({ name, model, purposes })),
      });
    } else {
      process.stderr.write("usage: hmh-codexhost providers --json\n");
      process.exitCode = 2;
    }
  } else if (command === "run") {
    const task = (await readStdin()).trim();
    if (!task) throw new Error("task must not be empty");
    const config = chatProvider(await loadConfig());
    const { reg, clients } = await buildRegistry({ mcp: false, announce: false });
    const wantsStream = process.env.HMH_CODEXHOST_STREAM !== "0";
    // Lossless coalescing: deltas buffer and flush on a 40ms cadence; the
    // pending remainder flushes before tool events and the final line, so
    // concatenated delta text === final text (the adapter compares them).
    let pending = "";
    let lastFlush = 0;
    const flush = (force = false) => {
      if (!pending) return;
      const now = Date.now();
      if (!force && now - lastFlush < 40) return;
      lastFlush = now;
      emit({ type: "delta", text: pending });
      pending = "";
    };
    try {
      const result = await runAgentTask({
        task,
        registry: reg,
        cfg: config,
        ctx: { cwd: process.cwd(), home: homeDir() },
        yes: true,
        events: wantsStream
          ? {
              onLine: (line) => {
                flush(true);
                emit({ type: "line", text: String(line).slice(0, 400) });
              },
              onDelta: (kind, chunk) => {
                if (kind === "reasoning" || !chunk) return;
                pending += chunk;
                flush();
              },
              onToolCall: (name, args) => {
                flush(true);
                emit({ type: "tool", phase: "call", name, args: JSON.stringify(args ?? {}).slice(0, 300) });
              },
              onToolResult: (name) => {
                flush(true);
                emit({ type: "tool", phase: "done", name });
              },
            }
          : {},
      });
      flush(true);
      emit({
        text: result.text,
        sessionId: result.sessionId,
        turns: result.turns,
        toolUses: result.toolUses,
        toolsUsed: result.toolsUsed,
      });
    } finally {
      for (const client of clients) client.close();
    }
    // One-shot process: exit right after the final line. Background agent
    // work (fire-and-forget self-evolution) must not pin the event loop -
    // otherwise the host turn never completes and the UI spins forever.
    await new Promise((resolve) => setImmediate(resolve));
    process.exit(0);
  } else {
    process.stderr.write("usage: hmh-codexhost [--version | providers --json | run < stdin]\n");
    process.exitCode = 2;
  }
} catch (error) {
  fail(error);
}
