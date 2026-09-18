# ADR-0010: Reward Model & Preference-Pair Export (V3 RL Phase)

## Context

The M11 RL readiness gate is fully open (6/6, 2026-09-18): 1103 trajectories,
116 bench cases, 146 human star labels, 11 promoted workflows. The roadmap
(`二十五、Agent RL 路线`) is explicit: do NOT train an own LLM now; the order
is Harness → Trajectory → Evaluation → Dataset → Skill/Policy Evolution →
**Reward → RL** → Fine-tuning, referencing Microsoft Agent Lightning
(GRPO over existing harnesses; "the app defines the task and the reward").

Everything before Reward is done. The reward-calibration report
(`scripts/reward-correlation.cjs`) proved the outcome-based reward ranks
sessions at Spearman 0.981 vs human judgment - but 144/145 labeled sessions
sit in the ok bucket where humans still distinguish 4 vs 5 stars, which the
outcome signal cannot see.

## Decision

1. **Learned reward model** (`packages/evolution/src/reward-model.ts`):
   a zero-dependency logistic regressor over harness-measured features
   (outcome bucket, tool-failure rate, log-turns, log-tool-uses), fit on
   the human labels (deterministic gradient descent, 80/20 holdout split
   by index). Persisted to `HMH_HOME/evolution/reward-model.json`;
   refit as labels accumulate (`hmh reward fit`). First real fit:
   n=145, train RMSE 0.0407, holdout RMSE 0.0245 - the model reproduces
   human scores almost exactly on current data.

2. **Preference-pair export** (`hmh reward export-dpo`): DPO pairs in two
   classes - (a) IN-BUCKET gold: same outcome, >=2-star gap (the signal the
   outcome reward is blind to); (b) CROSS-BUCKET classic: ok-vs-degraded
   completions of the SAME task template (60-char prefix match). Current
   real-data yield is honestly 0 (all joined labels are ok-bucket, max gap
   0.2) - the export is ready and the label queue now surfaces degraded
   (turn-budget) sessions first so the material accumulates.

3. **Label queue prioritization**: `/api/label/list` digs through 400
   insight lines to prepend up to 6 unlabeled degraded sessions - the ok
   batch runs dominate 10:1 and a pure-ok queue starves both the reward
   model's variance and the DPO export.

## What this is NOT

Not model fine-tuning. The blueprint defers it; when a fine-tunable
endpoint appears, `dpo-pairs.jsonl` is the input format.

## Consequences

- RL at the harness level = the evolution loop, now with a learned reward
  available for candidate scoring (`scoreFeatures`).
- Human labels gained a second consumer beyond the gate count; labeling
  degraded runs is now measurably valuable.
- All zero-dependency; deterministic fits; auditable artifacts
  (`reward-model.json`, `dpo-pairs.jsonl`, `ops/reward-calibration.json`).
