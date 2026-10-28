# Pre-registered verdict rules — three-arm-v2-2026-10-28

Promotion gate + verdict semantics, frozen before any run. Reproduced verbatim from the experiment manifest.

Extracted from `published/manifest.json` at `preRegistered` (machine copy, no rewording):

```json
{
  "mainEndpoint": "protect split, C-vs-A, task-level paired difference",
  "significance": "bootstrap 95% CI (task-level paired diff, 10k resamples, seeded) excludes 0 OR any per-seed exact McNemar p < 0.05",
  "exploratory": [
    "protect B-vs-A",
    "train C-vs-A",
    "train B-vs-A"
  ],
  "promotionGate": {
    "maxProtectFallback": 0.03,
    "maxCostGrowth": 0.1,
    "minTasksPerSplit": 15,
    "minDiscordantCells": 8
  },
  "cArmRule": "inherited from v1 verbatim + population clause: C runs ONLY with a gate-promoted candidate; if the whole population is rejected => C reported as not deployable (NEEDS-DATA on the main endpoint) — the honest outcome",
  "crashRule": "crashed runs count as task failure in the primary analysis AND are reported separately (crash rate per arm)",
  "knownBehaviors": [
    "runEvolution seedCases(home) will seed 3 starter cases (toolchain-report / reply-determinism / toolchain-ohpm-status) into gate-home on first gate run — same as v1 deviation #2; symmetric for baseline and candidates, direction conservative",
    "gate-home beh-* task files are sanitized copies: their prompts reference <user> paths, so read_file cannot resolve them inside the gate — both sides of the gate fail these symmetrically (recorded; main-experiment train tasks keep original prompts and DO resolve)",
    "phase0 B-arm lessons and phase1 population input come from TRAIN-class null failures only (protect never feeds candidate generation)"
  ]
}
```
