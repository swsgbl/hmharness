# hmharness

**A self-evolving agent harness for HarmonyOS/OpenHarmony development.** Zero-dependency kernel + first-class self-evolution + MCP ecosystem borrow — every runtime capability is home-grown or absorbed via standard protocols, never inherited from a parent runtime.

[![ci](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml/badge.svg)](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![deps](https://img.shields.io/badge/runtime%20deps-0-000000)

![hmh CLI demo](docs/assets/hmh-demo.gif)

[中文文档](README.md)

## Feature highlights

| Area | Capability |
|---|---|
| **Agent kernel** | while-loop core, any OpenAI-compatible provider, streaming output with thinking blocks, context budget compression, kernel-level approval gate, append-only session audit |
| **HarmonyOS native domain** | Parameterized project scaffolding (multi-page, multi-module, one sentence → any structure), hvigor build, hdc install/launch/logs/uninstall, Cangjie cjpm build, codelinter. **Full emulator lifecycle management without an IDE** |
| **Self-evolution** | Evolution loop (insight mining → proposals → training/holdout double gate → promotion with snapshots → rollback), three-state skill lifecycle, retrieval-based long-term memory, scheduled evolution, evolution audit log |
| **Ecosystem borrow** | MCP client (stdio + HTTP, 5800+ community servers plug-and-play), `hmh ops` keeper (ecosystem radar; AI only proposes, humans approve before publishing) |
| **Multi-agent** | spawn_agent sub-agents (fresh context, depth limit, shared approvals, audited prefix) |
| **Vision** | see_image (any vision model, multi-provider fallback) |
| **Frontends** | CLI / REPL / fullscreen TUI (slash-command palette) / Web (browser streaming, remote approvals, session replay, workspaces) |
| **i18n** | zh / en bilingual UI and system prompts (`--locale=en`) |
| **Native web** | web_search (zero-key) + web_fetch (URL -> readable text) + browser automation (browser_open + desktop vision chain) |
| **Desktop automation** | desktop_screenshot / desktop_click / desktop_type - the see-act-verify loop, approval-gated |
| **Parallel + instant feedback** | concurrent tools (approvals ordered); 3-tier feedback: errors noted instantly -> per-task reflection into memory -> auto evolution every 3 insights; **code-level self-evolution** (sandbox branch + double-sample gate + git revert, kernel loop untouchable) |
| **Session management** | rename / archive / delete (trash, recoverable) on the sidebar history |

## Quick start

**Option 1: install from npm** (recommended once published, zero build):

```bash
npm install -g @hmh/cli     # Node >= 22
hmh init                    # creates ~/.hmharness (config + state dirs)
```

**Option 2: from source** (development / trying it out):

```bash
git clone https://github.com/swsgbl/hmharness.git
cd hmharness
npm install
npm run build
npm link -w @hmh/cli   # then `hmh ...` works from any directory
hmh init               # creates ~/.hmharness (config + state dirs)
```

Point at any OpenAI-compatible provider (edit `~/.hmharness/config.json` or env vars `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL`):

```json
{
  "provider": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...", "model": "your-model" }
}
```

Multi-provider routing is optional:

```json
{
  "providers": {
    "a": { "baseUrl": "...", "apiKey": "...", "model": "strong-model" },
    "v": { "baseUrl": "...", "apiKey": "...", "model": "vision-model" }
  },
  "routing": { "chat": "a", "vision": "v", "evolve": "a" }
}
```

## Common commands

```bash
hmh "your task"              # one-shot task (full agent loop, streaming)
hmh                          # interactive REPL (cross-line conversation memory)
hmh tui                      # fullscreen TUI (palette: arrows/wheel/click, /model picker, /lang zh|en; also auto-starts the web UI, --no-web skips)
hmh web start               # web UI as a silent background daemon (no window, survives terminals; stop/status)
hmh web [--port=7788]        # web UI in the foreground (debugging)
hmh resume [id-prefix]       # continue a past session
hmh tools | mcp              # tool inventory / MCP server status
hmh check | devices          # toolchain health check / device list
hmh evolve [--every=30]      # self-evolution cycle (one-shot or resident)
hmh bench | skills           # bench / skill library
hmh ops scan|brief|status    # ecosystem radar
```

Any command accepts `--locale=zh|en`. Dangerous operations go through the approval gate by default (y/N on a TTY, denied headless; `--yes` or `"approval":"auto"` to allow; destructive command patterns are hard-denied).

## HarmonyOS flow without an IDE

```text
harmony_project_create(pages+modules) -> harmony_build -> harmony_install
  -> harmony_launch -> harmony_logs                    # device or emulator
harmony_emulator_list|catalog|create|start|stop|delete # full emulator lifecycle
harmony_cjpm_build/test · harmony_lint                 # Cangjie / codelinter
```

Project scaffolding is fully parameterized: one call generates any structure of multi-page + feature HAP + HAR libraries. Emulator management drives the official headless CLI directly — no DevEco Studio required.

## Self-evolution

One `hmh evolve` cycle: read session transcripts → meta-model proposes candidate skills (written to `drafts/`) → **training gate** A/B bench (regression = reject) → promote (auto snapshot) → **holdout gate** re-verifies post-promotion (anti-memorization; regression = instant rollback) → memory distillation (append-only) → everything lands in `evolution/log.jsonl`. Safety constraint: the evolution loop only writes `skills/` and `memory/` — it can never touch configuration or safety settings.

## Repository layout

```
packages/
  kernel/          zero-dependency kernel (registry, loop, provider, chat, config, compression, MCP client)
  evolution/       memory · insights · skill lifecycle · bench (training/holdout) · evolution loop
  domain-harmony/  HarmonyOS domain (devices, toolchain, scaffolding, build, install, run, logs, Cangjie, lint, emulator)
  domain-ops/      ops keeper (ecosystem radar, issue flow)
  agent/           execution layer (base tools, system prompt, spawn, runner)
  cli/  web/       terminal and browser frontends (same event protocol)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/PROVIDERS.md](docs/PROVIDERS.md) (provider presets reference, in Chinese) and [docs/DEVLOG.md](docs/DEVLOG.md) (development log). Settled interaction-design decisions live in [docs/DESIGNS.md](docs/DESIGNS.md) (in Chinese) — check the ledger before changing any UI behavior.

## Contributing

`npm run typecheck && npm test && npm run build` all green, then open a PR (draft mode first). Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
