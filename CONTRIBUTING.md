# Contributing

- Node >= 22, zero runtime dependencies in `@hmh/kernel` - keep it that way.
- Before opening a PR: `npm run typecheck && npm test && npm run build` must be green (CI enforces it).
- PRs open as **draft** with a plan card (what / why / how to test).
- Red lines (see docs/ROADMAP.md): kernel stays dependency-free; HMH_HOME isolation; evolution changes must pass the bench gate; the evolution loop writes `skills/`, `memory/`, and may propose **code patches** that (1) only modify `packages/*/src/*.ts` (never kernel loop/provider/config/security), (2) run on an isolated git branch (sandbox), (3) must pass the bench double-sample gate, and (4) are reverted via `git checkout main + branch delete` on regression.
- No secrets in the repo - keys live only in `~/.hmharness/config.json`.
