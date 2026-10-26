# HMHarness reproducibility and prediction-to-action — AI Master Prompt

Act as a senior research engineer and verification-first agent-systems engineer. The task is to establish whether HMH's existing learning machinery improves real, unseen task outcomes. Do not add a new subsystem unless a concrete experiment cannot be run without it.

## Source-of-truth rules

1. Inspect the current branch, release, CHANGELOG, tests and the current source files before editing.
2. Read docs/plans/deep-not-wide-2026-10.md and docs/research/2026-10-agent-self-improvement-primary-source-review.md.
3. Respect the runtime's safety and approval contracts. Evaluation code must not create a bypass.
4. Treat HarnessPro, Harness², Self-HPO and other papers as research evidence, not guaranteed implementations or promised outcomes. State which pieces are adopted, adapted or deferred.
5. No result may be called AGI, generalization or transfer without disjoint, external task evidence.

## Required implementation tasks

### 1. Reproducible research primitives
- Use canonical JSON with recursively sorted object keys while preserving meaningful array order.
- Fingerprint complete trajectory contents using full SHA-256; include actions, outcomes, state/observation references, metrics and environment versions.
- The dataset fingerprint must be invariant to trajectory listing order and change when any scored trajectory content changes.
- Use seeded Fisher-Yates for randomized splits; record the seed and algorithm.
- Record code commit, package version, dataset schema, dataset fingerprint, split, seeds, provider/model, exact config and verifier revision.
- Outcomes marked unknown are not failures. Exclude them from binary calibration denominators and report null/NEEDS-DATA when no valid samples remain.

### 2. Prediction-to-action experiment
- Preregister hypotheses, primary outcome, exclusions, seeds, sample-size plan and stopping rule before evaluating the candidate.
- Run at least a baseline and an intervention arm in fresh isolated workspaces with the same provider/model, prompt, tool set and approval policy. Add an extra frozen-model measurement arm only when it answers a distinct question.
- Primary outcome: independent deterministic verifier task success.
- Secondary outcomes: recovery count, action/tool calls, tokens, latency, human approval/interruption count and safety denials.
- Calibration scores are reported separately from task outcome lift.
- Randomize run order with an unbiased seeded method.
- Publish raw per-task outcomes, not only means. Include an uncertainty interval and paired discordance summary.
- If the gate increases refusals or tokens without improving verified success, label the result negative or inconclusive. Do not change thresholds after seeing the test set.

### 3. Holdout integrity and transfer
- The proposer and evolving runtime must not see hidden evaluator files, rubrics or expected outputs.
- Enforce network policy outside the prompt, at host/container/firewall level.
- Split by task template, project or time when possible; random trajectory splits alone are not sufficient for generalization claims.
- Evaluate transfer against a target-domain baseline using the same target tasks.
- Mark sample overlap and dependency; overlapping random splits cannot be presented as independent replications.

### 4. Self-evolution promotion
- Candidate metadata must include parent lineage, generated diff, code/harness version, metric deltas, cost, safety test outcome and rollback handle.
- Keep rejected candidates as useful negative evidence, but do not inject rejected/canary skills as authoritative rules.
- Candidate promotion requires a held-out, external-verifier result and safety non-regression; the system must not write hidden evaluation data.
- Missing evidence must yield NEEDS-DATA, never a default zero or silent pass.

## Verification

Run the targeted evaluation unit tests, typecheck and complete test suite. If tools, provider credentials or network access are not available, document exactly what was not run. Do not fabricate output. Store per-case results, source commit, content fingerprint and command logs in the reproducibility artifact.

## Definition of done

- Tests prove content-order invariance and content-change sensitivity of the fingerprint.
- Tests prove seeded shuffle determinism and permutation preservation.
- Unknown outcomes do not enter a binary calibration denominator.
- Empty or invalid data yields NEEDS-DATA.
- A clean CI run compiles and tests the exact branch.
- Any task-success/generalization claim uses fresh external verification data and discloses limitations.
