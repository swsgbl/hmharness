# AGENTS.md

Guidance for AI coding agents (and human contributors) working in this repository.

## What this is

hmharness — an open-source (MIT) self-evolving agent framework for HarmonyOS/OpenHarmony development. npm package: `@hmharness/cli`. The repo is a single npm workspace of 16 first-party packages under `packages/`, each with zero third-party runtime dependencies.

## Essential commands

```bash
npm install                # workspace bootstrap
npm run typecheck          # tsc -p tsconfig.json --noEmit
npm test                   # full unit suite (CI gate; 909 tests at time of writing)
npm run build              # topological per-package build; scripts/fix-dts.mjs runs after each package
npm run hmh -- <cmd>       # run CLI from source via tsx
```

Publishing is CI-driven (`publish.yml`), not manual. Version consistency across CHANGELOG / facade / briefing note / website files is machine-checked before publish.

## Repo map

- `packages/kernel` — the agent loop core (tools, approvals, budgets)
- `packages/cli` — `hmh` command line, TUI, web frontend wiring
- `packages/cognitive` — Cognitive OS: world model, five-layer memory, calibration, exploration
- `packages/environments` — environment adapters (terminal / harmonyos via hdc / browser via CDP / desktop / ARC-AGI-3)
- `packages/lsp`, `packages/browser`, `packages/extension` — code intelligence, browser automation, browser-extension bridge
- `packages/sandbox`, `packages/evolution`, `packages/evaluation` — sandbox runtime, self-evolution, benchmarking
- `docs/` — ARCHITECTURE.md, DEVLOG.md (case-by-case build log), SELFFEED.md, KAIHONGOS.md (board install), ROADMAP.md
- `website/` — source of the GitHub Pages site (llms.txt / llms-full.txt / faq.html); gh-pages branch is the deploy target (legacy branch build — Contents API pushes trigger builds)

## Conventions that matter

- **Facts must be traceable.** Numbers quoted anywhere (test counts, symbols indexed, experiment results) must match CHANGELOG / DEVLOG / the evidence site. When in doubt, cite the source file.
- **Honesty over polish.** Unknowns are reported as unknowns ("查不到即诚实拒绝" applies to the codebase too — e.g., the API knowledge graph refuses rather than guesses).
- Node >= 22 required. Windows-first development; CI runs the full matrix.
- Internal cross-package deps use `*` (workspace resolution), not pinned versions.
- Self-evolution artifacts and monthly datasets live under `website/evidence/` — never rewrite history there; append only.

## Where to look for context

- Architecture and package boundaries: `docs/ARCHITECTURE.md`
- Why things are the way they are: `docs/DEVLOG.md` (dated, case-by-case)
- Board / embedded installs: `docs/KAIHONGOS.md`
- Public evidence of self-evolution decisions: `website/evidence/`

## Independence note

This is an independent community project (clean-room). It has no affiliation with Huawei or OpenAtom. Don't add claims to the contrary anywhere.
