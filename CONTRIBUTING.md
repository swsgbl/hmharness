# Contributing

- Node >= 22, zero runtime dependencies in `@hmh/kernel` - keep it that way.
- Before opening a PR: `npm run typecheck && npm test && npm run build` must be green (CI enforces it).
- PRs open as **draft** with a plan card (what / why / how to test).
- Red lines (see docs/ROADMAP.md): kernel stays dependency-free; HMH_HOME isolation; evolution changes must pass the bench gate; the evolution loop only writes `skills/` and `memory/`.
- No secrets in the repo - keys live only in `~/.hmharness/config.json`.
