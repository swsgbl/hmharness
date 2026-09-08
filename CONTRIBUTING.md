# Contributing

- Node >= 22, zero runtime dependencies in `@hmharness/kernel` - keep it that way.
- Before opening a PR: `npm run typecheck && npm test && npm run build` must be green (CI enforces it).
- PRs open as **draft** with a plan card (what / why / how to test).
- Red lines (see docs/ROADMAP.md): kernel stays dependency-free; HMH_HOME isolation; evolution changes must pass the bench gate; the evolution loop writes `skills/`, `memory/`, and may propose **code patches** that (1) only modify `packages/*/src/*.ts` (never kernel loop/provider/config/security), (2) run on an isolated git branch (sandbox), (3) must pass the bench double-sample gate, and (4) are reverted via `git checkout main + branch delete` on regression.
- No secrets in the repo - keys live only in `~/.hmharness/config.json`.

## Releasing to npm

Published under the **@hmharness** org (npmjs.com/org/hmharness). The seven
packages are an **ordered set** - each installs its workspace deps on publish:
kernel -> evolution -> domain-harmony -> domain-ops -> agent -> web -> cli.

1. Bump `version` in the changed packages (`packages/*/package.json`).
2. Add a `CHANGELOG.md` entry for the new version.
3. `npm install --package-lock-only` to sync the lockfile.
4. `npm run build` (all seven, in order) - `scripts/publish-preflight.cjs`
   fails the release on stale dist, missing shebangs, undeclared `@hmharness/*`
   imports in dist, or a broken `npm pack`.
5. Publish with a granular token (All packages + Read and write + bypass 2FA;
   the machine's `~/.npmrc` carries `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`
   so the token is passed via env and never written to disk):

   ```
   NODE_AUTH_TOKEN=npm_xxx node scripts/publish.cjs
   ```

   It runs preflight -> `npm whoami` fail-fast -> the ordered publish
   (`--access public`, registry pinned to npmjs.org).
6. Brand-new packages/versions may take a few minutes to appear in `npm view`
   (registry propagation pipeline). The org's package list on npmjs.com is the
   immediate source of truth - do not re-publish on a transient 404.

## Remotes: GitHub (origin) + AtomGit mirror

`origin` is GitHub (swsgbl/hmharness); `atomgit` is the AtomGit mirror
(hongfu/hmharness, SSH key `~/.ssh/atomgit_key`). After pushes that matter
(releases, evidence updates), sync both:

```
git push origin main && git push atomgit main
```
