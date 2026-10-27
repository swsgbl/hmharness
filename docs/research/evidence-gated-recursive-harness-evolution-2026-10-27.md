# Evidence-Gated Recursive Harness Evolution (2026-10-27)

> Status: proposed research/engineering plan, documentation only. It does not claim that the implementation described below already exists.
> Baseline inspected: `swsgbl/hmharness` main at `652f54375c7b10b775cd60922dfda6184d24c937`, source version `0.23.42`; `swsgbl/hmh-desktop` release `v0.2.6`. Update this baseline before every experiment or release.
> North star: **deepen proof of improvement, do not expand the feature surface until evidence justifies it.**

## 1. Why this plan exists

The repository has a substantial Cognitive Runtime: action/observation/trajectory protocols, a World Model and prediction calibration, a Cognitive Ledger, learning-target contracts, skill promotion and rollback, transfer instrumentation, multi-environment adapters, long-run instruments and an evidence-oriented release process.

The current evidence does not yet justify a general-AGI claim. The project roadmap reports that the strongest harness-specific signal is prediction calibration/transfer calibration (a reported +0.4166 result), while some Model-only vs Harness vs Cognitive-OS task-success ablations report no net success-rate lift. The README also records zero statistically reliable skill/canary promotions in the first 30-day production sample, while the gates correctly reported insufficient evidence and surfaced production defects. These are useful scientific results, not a failure of the project. They mean the next milestone should be to demonstrate reliable **task-level improvement and transfer** under independent evaluation.

A calibrated predictor is useful, but it is not equivalent to a better acting policy. A model that says "I am 82% likely to succeed" has not improved if the agent still selects the same action, fails at the same rate, or simply describes failure more accurately.

## 2. Baseline facts and evidence boundaries

### 2.1 hmharness source baseline

- Main commit: `652f54375c7b10b775cd60922dfda6184d24c937`.
- Root package version: `0.23.42`.
- Latest main CI at the time of inspection: green.
- The v0.23.42 publish workflows were failing in the publish preflight step after approximately 600 seconds. Job logs show build/typecheck succeeded and the process ended with `preflight failed - publish aborted`. The follow-up main commit `b1bc38f` describes increasing the preflight timeout from 600 seconds to 30 minutes. **A successful main CI run and a corrected timeout do not prove the intended npm artifact has been published or installed.** Verify the registry and fresh package tarballs before declaring the release complete.
- v0.23.40 addressed a real permanently-busy executor: an abort signal did not reach in-flight provider streaming; an abort latch and process-kill fallback were added.
- v0.23.41 addressed stale legacy provider configuration causing `/evolve` and `/bench` calls to use a rotated key and receive 401.
- v0.23.42 addresses cross-package dependency pins that were not bumped with package versions. The changelog says 16/16 fresh-install package consistency checks passed; this must remain reproducible from the exact released artifacts.
- v0.23.36 split 38 of 44 Web routes into route-domain modules. Do not re-introduce a second kernel in the Web or Desktop layer.

Sources: [CHANGELOG](https://github.com/swsgbl/hmharness/blob/main/CHANGELOG.md), [DEVLOG](https://github.com/swsgbl/hmharness/blob/main/docs/DEVLOG.md), [main CI](https://github.com/swsgbl/hmharness/actions/runs/40408409521), [failed v0.23.42 publish run](https://github.com/swsgbl/hmharness/actions/runs/40397099866).

### 2.2 HMH Desktop baseline

- Current released shell: [HMH Desktop v0.2.6](https://github.com/swsgbl/hmh-desktop/releases/tag/v0.2.6), Windows x64 installer plus OpenHarmony/KaihongOS HAP.
- v0.2.6 release notes identify bundled hmharness kernel v0.23.40, behind the current main source v0.23.42. Align the selected kernel and verify its exact bundled artifact on release.
- Main README contains at least one v0.2.5 reference while v0.2.6 is released. The root workspace package version is `0.1.0-alpha.0` while the desktop app package is `0.2.6`. Decide which version is canonical for each package and automate the consistency rule instead of manually assuming these values must all match.
- Existing UI implementation is a three-pane workbench, React renderer, Electron main/preload, a separate native ArkTS application, and shared contracts/host adapter. The renderer's `App.tsx`, CSS and Electron main are large files; make bounded extractions rather than replacing the working bridge.
- An Apple HIG-inspired accessibility foundation already exists in [Draft PR #1](https://github.com/swsgbl/hmh-desktop/pull/1). The PR head CI at [run 40393088151](https://github.com/swsgbl/hmh-desktop/actions/runs/40393088151) passed typecheck, tests and build. Screenshot, UI verifier, packaged security/install and OpenHarmony evidence remain required. Keep the PR draft until these gates are actually observed.

## 3. Research that should shape the next iteration

This is a mechanism-oriented comparison, not a leaderboard. Paper results below are **author-reported** and have not been independently reproduced by this plan.

### 3.1 HarnessPro — performance/cost Pareto evolution

Paper: https://arxiv.org/abs/2610.26770  
Code: https://github.com/pzs19/HarnessPro  
Project page: https://pzs19.github.io/HarnessPro/

Useful mechanisms:
- Diagnose concrete execution traces for failure patterns and waste.
- Propose small harness changes tied to diagnoses.
- Use generated/synthesized tests during optimization without letting the optimizer inspect the official answer/test oracle.
- Preserve multiple operating points on the performance-cost frontier (Lite / Medium / Heavy), rather than forcing one scalar winner.

Transfer to HMH:
- Add cost per successful task, tokens, wall time, tool-call count and recovery cost to the scorecard.
- Keep a small Pareto archive of accepted candidates with ancestry, benchmark version, budgets and rejection reasons.
- Keep the current stable harness available as a baseline; do not automatically replace it with the newest candidate.

Caveat: generated tests are proxies, not an independent final judge. Freeze candidates, then run the official/hidden evaluator separately. Keep benchmark answers/rubrics out of candidate prompts and restrict executor network access.

### 3.2 Harness² — task-level recursion plus across-task learning

Paper: https://arxiv.org/abs/2610.14224  
Code: https://github.com/google-research/harness2

Useful mechanisms:
- Task-level Propose–Probe–Compose (P-P-C): propose a bounded harness edit, run contrasting probes, and compose a better task-specific harness from behavioral evidence.
- A second recursion level stores accepted, evidence-supported lessons for future tasks.
- Parallel or sequential exploration, bounded recursion budgets and reproducible experiment namespaces.

Transfer to HMH:
- Start with the minimal task-level sequential mode (`k=1`) behind a feature flag.
- Keep task-specific edits ephemeral. Only a separately accepted abstract lesson can enter the cross-task library.
- Distinguish “works for this case” from “generalizes to new tasks”; never promote based only on the probe that created the candidate.

Caveat: the public Harness² experiment guide explicitly notes unrestricted executor networking and a disabled Codex sandbox. Do not copy those settings into HMH. Apply network egress restrictions and real containment when evaluating untrusted code or tasks.

### 3.3 Self-Harness / VERSE — failure-linked minimal edits with executable verification

Self-Harness: https://arxiv.org/abs/2606.09498  
VERSE: https://arxiv.org/abs/2610.02616  
HarnessEvolve: https://arxiv.org/abs/2609.00829

Useful mechanisms:
- Mine model-specific failure modes from execution traces.
- Propose diverse but minimal changes tied to a particular diagnosed failure.
- Replay failure cases and perturb suspected steps.
- Track both fixes and regressions across rounds.
- Keep train, validation and hidden test tasks disjoint and select the final harness based on a held-out set.
- Separate execution, evaluation, optimization and gate responsibilities.

Transfer to HMH:
- Every candidate must point to a failure/trajectory cluster, expected mechanism, files changed, cost and falsifiable test.
- Run targeted reproduction tests, regression tests and counterexample tests before general benchmarks.
- Require an evaluator that cannot read the agent's self-reported “success” claim as the only label.

### 3.4 Multi-task self-evolving harness and optimizer recursion

Paper: https://arxiv.org/abs/2609.38372

Useful mechanisms:
- Evolve across a mixture of tasks/benchmarks, not only a single favorite task family.
- Keep held-out and out-of-distribution tests strictly separated.
- Inspect task execution records for repeated infrastructure failures such as output truncation, context growth and missing independent review.

Transfer to HMH:
- Use a small, stratified, cross-environment set as the evolution corpus, but keep a separate sealed evaluation corpus.
- Test whether one learned rule transfers to a new project, environment and tool—not just a similar task string.

### 3.5 False-success measurement

Paper: https://arxiv.org/abs/2606.09863

Use the actual resulting environment state as the pass/fail source. An answer that asserts completion is not evidence of completion. Cheap heuristics may triage suspicious claims; final pass must use a deterministic domain verifier, benchmark state diff, patch/test result, or blinded independent auditor.

## 4. Rewritten objective

Replace “add more AGI features” with:

> **Demonstrate that evidence-gated harness evolution improves held-out real task completion and cross-task transfer at a measured cost, without increasing safety violations, false successes, regressions or long-run instability.**

Sub-goals:
1. Package correctness: users receive the same code that CI tested.
2. Task improvement: accepted changes improve environment-verified outcomes over a frozen baseline.
3. Generalization: gains persist on held-out, temporal and cross-environment tasks.
4. Cost efficiency: the project publishes the performance-cost frontier.
5. Safety: candidate code, memory and skills cannot alter the evaluator, hidden set, approval gates or sandbox policy.
6. Reproducibility: another person can re-run the experiment from the released manifest.
7. Product usability: HMH Desktop makes run state, approvals, verification and results understandable without exposing internal reasoning text as the UI.

## 5. The primary experiment

### 5.1 Pre-register arms

Use the same base model snapshot/provider, environment image, tools, limits and task split for all arms:

- **A — Frozen baseline:** current stable hmharness with evolution disabled.
- **B — Current evolution:** stable current self-evolution/learning path.
- **C — Task recursion only:** bounded sequential P-P-C, no persistent learned library.
- **D — Cross-task archive only:** Pareto/candidate archive, no task-level P-P-C.
- **E — Combined:** task-level recursion plus accepted cross-task learning.

Keep a feature-flagged, bounded rollout. Do not enable E as production default until it beats A on the sealed outcome under the same budget.

### 5.2 Split and leakage control

- Train/evolution set: available for candidate diagnosis and optimization.
- Validation set: visible only to a separate validation runner; use to select a candidate.
- Hidden test set: read-only to the evolution process and written only by the evaluator owner.
- Temporal holdout: tasks created after a frozen cutoff.
- Cross-environment/OOD holdout: tasks from a different environment, repository/project, or tool family.
- Benchmark manifests include task IDs, dataset SHA-256, environment-image digest, and split provenance. Refuse test/evolution overlap.
- Restrict network egress for the agent during benchmark runs; record exact allowlist/denylists. Ensure tasks cannot fetch official rubrics, hidden answers or pre-solved patches.

### 5.3 Outcome and efficiency metrics

Primary outcome (pre-registered): **environment-verified task success rate** on hidden held-out tasks.

Secondary metrics:
- cost per task and cost per successful task (tokens, API spend, wall time);
- Pass@1 and optionally Pass@3, with the same sample budget for all arms;
- tool calls, redundant calls, recovery count and recovery latency;
- false-success rate (agent claims completion but verifier says no);
- regression rate on previously solved tasks;
- unsafe action / policy violation rate;
- ECE/Brier for calibration, reported separately from task completion;
- transfer lift by source→target environment and task family;
- memory/skill retention, contradictory lessons and catastrophic forgetting;
- crash, checkpoint/resume idempotence and completion across 2h/8h/24h soak tests.

Report absolute and paired deltas, 95% confidence intervals, exact McNemar where paired binary labels apply, bootstrap intervals where appropriate, sample size, missing data and every unmeasured metric as `NEEDS-DATA`. Do not fill missing metrics with zero.

### 5.4 Promotion gate

A candidate is promoted only if all gates pass:
1. Code/schema/security checks and targeted reproduction tests pass.
2. It improves the pre-registered primary outcome on validation by a predeclared minimum effect; otherwise status is `insufficient-evidence`.
3. Hidden test shows no unacceptable regression; hidden evaluator output is never exposed to the improver.
4. Safety and false-success rates stay within a predeclared non-inferiority margin.
5. Cost and latency are documented; keep a candidate only if it is Pareto-useful or has a documented operational reason.
6. Two fresh runs from clean installs reproduce the same direction of effect.
7. Canary compares treatment with a contemporaneous control group; rollback is automatic on safety regression or a predeclared task-success drop.
8. Persist full manifest, raw outcomes, candidate patch hash, ancestry, test output, judge identity and promotion/rejection reason.

Do not turn the proposed thresholds into magic truths. Determine practical effect-size and safety margins through a pre-registration step and report the rationale.

## 6. Safety invariants

- No candidate or improver can edit the evaluator, hidden datasets, gate implementation, capability broker, approval rules, provider secrets or runtime security boundary.
- Candidate work occurs in an isolated working tree and resource-limited process/container. Use container or VM boundaries for untrusted code; a worker thread alone is not a security boundary.
- Use deny-by-default capabilities, least-privilege filesystem mounts, egress controls, bounded CPU/memory/time, secret brokering and redaction.
- The execution agent cannot write the final evaluation record; the evaluator is claim-blind to the agent's self-reported success.
- Do not promote a single lucky seed. Preserve candidate diversity, ancestry and rollback paths.
- Retrieved memory/skills are references, not authority. Treat them as untrusted context and defend against poisoned instructions.
- Every benchmark result is labeled author-reported, internal reproduction, independent reproduction, or production observation. Do not conflate these grades.

## 7. Prioritized implementation plan

### P0 — Release and proof integrity (first)

1. Inspect v0.23.42 publish workflow failures. The main CI green state does not clear the publish gate.
2. Verify registry metadata, every published tarball's embedded version and dependency pins, and a fresh isolated install (no npm cache dependency). Compare package output to the source/tag hash.
3. Convert release checks into machine-enforced gates: package versions, all cross-package pins, lockfiles, tarball inspection, install in a new directory, smoke test with a clean config, checksum/SBOM.
4. Verify Desktop's packaged kernel version against the intended hmharness release; update stale release docs and set explicit canonical version rules.
5. Keep the Apple HIG UI PR draft until its visual, accessibility, packaged-install/security and OpenHarmony acceptance evidence is attached.

**Exit criteria:** release pipeline can prove what artifact users install; unresolved publish state is not hidden behind a green source CI badge.

### P1 — Minimal evolution experiment

1. Define a versioned task set and evaluator contract.
2. Implement or isolate a task-recursion adapter behind an off-by-default flag; use a single P-P-C stage first, with hard limits on calls, tokens and elapsed time.
3. Candidate edits are made in a temp branch/dir and cannot be auto-promoted from task probes alone.
4. Add a small Pareto archive: candidate hash, train/validation metrics, cost, safety and ancestry.
5. Run the five pre-registered arms and issue an evidence report. If no significant/minimally meaningful gain appears, retain the baseline and investigate failure mechanism instead of widening scope.

**Exit criteria:** first externally verifiable, cost-accounted task-level improvement—or a documented negative result that narrows the hypothesis.

### P2 — Cross-task transfer and skill quality

1. Explain the reported `0.39 < 0.6` skill-generalization rejection through targeted ablation, not threshold adjustment.
2. Cluster failures by precondition mismatch, variable binding, action sequence, state change, and verification defects.
3. Evaluate each abstraction on temporally new tasks and a different environment/tool.
4. Add explicit counterexamples and negative examples; holdout tasks remain sealed.
5. Add retention tests to detect a new skill breaking old task families.

**Exit criteria:** reusable knowledge works outside its source task and does not cause measurable regression in old tasks.

### P3 — HMH Desktop, Apple HIG-inspired quality

Use the existing [Draft PR #1](https://github.com/swsgbl/hmh-desktop/pull/1), do not start a parallel reimplementation:
- Stage A: system theme default, reduced motion, focus ring, keyboard navigation, quiet chrome and semantic tokens (some groundwork exists in PR #1).
- Stage B: refine information hierarchy—conversation/result first, tool details collapsed, status and verification evidence explicit, inspector supplementary, composer always reachable.
- Stage C: ensure common actions are keyboard/menu accessible, show action affordances on focus/touch, restore focus after dialogs and support undo/confirmation for destructive operations.
- Stage D: test 1280x800, 1440x900, 1920x1080; light/dark/system; forced colors/high contrast; reduced motion; keyboard-only; long paths and 100-session lists.
- Stage E: packaged clean-install, Electron security tests, real runtime end-to-end, and separate OpenHarmony device screenshot/tests.

HIG guidance is a source of interaction principles, not an instruction to copy Apple assets or impose macOS visuals on OpenHarmony. Current Desktop is primarily Windows + OpenHarmony; honor each platform's conventions.

### P4 — Long-running reliability

Reuse the existing soak instruments, but verify from a clean, isolated install:
- 2h, 8h, 24h run where the product target requires it;
- repeated stop/cancel during provider streaming;
- crash/restart/checkpoint/resume without duplicate actions or ledger drift;
- daemon restart and browser bridge recovery;
- memory/heap growth, orphan-process and port-leak monitoring.

## 8. Objective independent checks

Required external instruments:
- GitHub Actions CI as build/test evidence, not task-success proof.
- npm registry/tarball inspection and fresh-install script for artifact integrity.
- clean-room replay on a new machine or container, pinned dependencies and model snapshots where possible.
- benchmark evaluator that verifies actual environment state, generated patch tests, build/test results or application DB state.
- independent reviewer who does not see the agent's claim or optimization hints (claim-blind review).
- paired statistical analysis with raw per-task outcomes, confidence intervals, effect sizes and cost curves.
- Electron security tests, IPC sender validation, CSP/navigation tests and packaged installer validation.
- screenshot diff and keyboard/accessibility checklist for Desktop; device-side test and screenshots for OpenHarmony.
- SBOM, checksums, dependency scanning and reproducibility manifest.

## 9. AGI capability reporting policy

Use the term **AGI capability research** only as a research direction, not as a verified capability label. Report a versioned capability card across:
- task success and difficulty scaling;
- novel-task generalization and OOD transfer;
- long-horizon planning, resumption and recovery;
- learning efficiency and retention;
- calibration/metacognition;
- tool/environment breadth;
- safety, policy compliance and false-success rate;
- efficiency and reproducibility.

Each metric needs: task set/version/hash, sample size, evaluator, baseline, delta, confidence interval, runtime/cost budget, independent reproduction level and limitations. Use `PASS`, `FAIL`, `INSUFFICIENT-EVIDENCE` and `NOT-RUN` explicitly. Never combine these into a single AGI score without a validated construct and prespecified weights.

## 10. Research references

- HarnessPro: https://arxiv.org/abs/2610.26770 · https://github.com/pzs19/HarnessPro
- Harness²: https://arxiv.org/abs/2610.14224 · https://github.com/google-research/harness2
- Self-Harness: https://arxiv.org/abs/2606.09498
- VERSE: https://arxiv.org/abs/2610.02616 · https://github.com/wzekai/VERSE
- Self-Evolving Harness on Multiple Tasks: https://arxiv.org/abs/2609.38372
- HarnessEvolve: https://arxiv.org/abs/2609.00829
- False success evaluation: https://arxiv.org/abs/2606.09863
- Curated discovery index (secondary source; use it to find papers, not to replace the primary paper): https://github.com/sukoji/awesome-self-evolving-agents
- Apple HIG — macOS: https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/
- Apple HIG — Sidebars: https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple HIG — Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars

## 11. Immediate next action

Do not add another feature family yet. First close the release artifact integrity gap and finish the in-progress Desktop HIG evidence gates. In parallel, prepare the preregistered five-arm experiment and the independent verifier. The next version milestone is accepted when it has convincing held-out task improvement or a clear, reproducible negative result—never merely because more code landed.
