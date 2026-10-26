# Self-evolving Agent research review: primary-source comparison

**Audit date:** 2026-10-27  
**Purpose:** choose the smallest research upgrades that can falsify HMH's capability claims, not expand the feature surface.

## Executive finding

The most important research lesson is that harness evolution is an empirical search problem, not a self-improvement claim. Every variant needs an independently checked outcome, a cost measure, a held-out split, and a rollback path. HMH already has many governance mechanisms; the deficit is whether those mechanisms yield reliable, out-of-sample task-success gains.

The immediate priority is not RL training or a larger multi-agent society. It is to make the existing evaluation trail content-addressed and reproducible, run genuinely paired interventions, and retain negative results.

## Primary sources checked

### HarnessPro — arXiv:2610.26770

Paper: https://arxiv.org/abs/2610.26770  
Code: https://github.com/pzs19/HarnessPro

The paper describes label-free recursive harness optimization. LLM-generated tests are used without giving the optimizer ground-truth solutions or official tests. Trajectory-diagnosis agents propose harness updates; the selection rule preserves performance-cost alternatives (lite, medium, heavy) instead of a single winner. The abstract reports, against RHO, a 2.0 percentage-point average pass-rate increase and 26.1% lower average per-task cost for the heavy configuration across Terminal-Bench 2, SWE-Bench Pro and ProgramBench under its GPT-5.5/Codex setting.

**Useful for HMH:** keep a Pareto set across success, cost, latency and safety. Do not optimize cost only after success is already low; define a feasibility floor first. Run generated tests in addition to hidden deterministic tests, not instead of them.

**Caveat:** generated tests are not an independent oracle by themselves. They can be incomplete or reward a proxy. Pin the model, benchmark revisions, tools, environment and network policy; keep official/hidden acceptance tests inaccessible to the proposer.

### Harness² — arXiv:2610.14224

Paper: https://arxiv.org/abs/2610.14224  
Code: https://github.com/google-research/harness2

Harness² uses two recursion levels: task-level propose–probe–compose edits based on behavior contrast without ground-truth verifiers, and harness-level accumulation of evidence-supported experience to improve the persistent improvement process. Its stated motivation is open-world adaptation where task distributions and ground-truth verifiers are unavailable.

**Useful for HMH:** contrast good and bad behaviors in a scratch workspace; write down the mechanism that explains the difference; compose only the smallest supported edit; retain lineage so later cycles can learn from both adoption and rejection.

**Caveat:** “no ground-truth verifier” changes the kind of evidence; it does not remove the need for external checks. Public benchmarks can leak rubrics through network access. For hidden evaluation, block outbound network at the host/container boundary, not only in the prompt.

### Self-HPO — arXiv:2610.22791

Paper: https://arxiv.org/abs/2610.22791

Self-HPO alternates harness optimization with policy-weight optimization. The paper reports joint gains beyond harness-only or policy-only in its tested coding benchmarks.

**Useful for HMH later:** treat model/policy and harness as separable experimental factors. Compare base model + base harness, base model + evolved harness, adapted model + base harness, adapted model + evolved harness.

**Not an immediate HMH task:** do not add weight-training infrastructure before HMH can demonstrate reliable task-level lift from its existing harness/world-model changes. Training requires data governance, compute, rollback and policy-specific reproducibility.

### Mixture of Self-Improving Branches — arXiv:2609.37834

Paper: https://arxiv.org/abs/2609.37834

The work maintains complementary optimization branches with evolving development subsets and proposal policies, then routes inputs to a branch head selected using development data. It targets local-optimum risks from a single trajectory through harness search.

**Useful for HMH later:** a small, diversity-preserving Pareto archive and a simple development-only router may help after there is enough disjoint evaluation data to show complementarity.

**Not an immediate HMH task:** multi-branch search increases evaluation cost and overfitting risk. First make the single-branch experiment trustworthy.

### Earlier foundations already represented in HMH research ledger

- GEPA, arXiv:2507.19457: steady-state Pareto harness optimization; one sampled ancestor and a variant, not a large k-candidate tournament.
- DGM, arXiv:2505.22954: objective hacking is a central risk; one optimized score is not enough.
- Misevolve, arXiv:2509.26354: memory/tool evolution can harm safety; experimental content should be treated as unverified reference, not authority.
- ACE, arXiv:2510.04618: incremental playbook updates and context control; do not falsely attribute benchmark-gated versioning to the paper.
- Voyager, arXiv:2305.16291: iterative skill-library growth; lifecycle control is an HMH extension, not a Voyager mechanism.
- Self-Refine, arXiv:2303.17651; Reflexion, arXiv:2303.11366; ReasoningBank, arXiv:2509.25140.

See the in-repository research ledger for more detailed source-by-source corrections:
https://github.com/swsgbl/hmharness/blob/main/docs/research/self-evolution-upgrade.md

## HMH findings that change the priority

1. The repository's published September evidence and 30-day review did not demonstrate statistically reliable canary promotions; results were NEEDS-DATA. A prior review had around 49 trajectories, far below the evidence needed to establish reliable cross-task learning. Later work expanded the corpus (the v0.23.37 changelog reports 111 trajectories / 1,582 steps), but a bigger corpus is not, by itself, proof of net task-success improvement.
2. The observational prediction-to-action analysis reported weak or negative task-level correlations in at least one experiment. HMH has since added a live intervention script with external deterministic verifiers. That script is the correct next instrument, but its three current arms and small synthetic task families are a pilot, not an AGI/generalization result.
3. The research packer previously hashed trajectory IDs only. A change to action/outcome/state/metrics under the same IDs could retain the same fingerprint. The patch in this branch changes this to a content-sensitive canonical SHA-256 digest.
4. The experiment script previously shuffled with a random comparator, which is biased and hard to reason about. The patch uses seeded Fisher–Yates with a tested helper.
5. Outcome “unknown” is a first-class protocol value. It must not be silently relabeled as a failure when calculating binary Brier scores.
6. Random holdouts reused across seeds are overlapping, not independent replications. A sign test across such seeds must be labeled descriptive. Confirmatory claims need disjoint task families, project holdouts, or temporally later data.

## Recommended implementation order

### P0 — trustworthy evidence
- Content-sensitive data fingerprint (implemented in branch).
- Seeded unbiased shuffle (implemented in branch).
- Unknown outcome exclusion and NEEDS-DATA when no score is possible (implemented in branch).
- Record exact commit, schema, split, provider/model, benchmark revision, environment and network policy.
- A clean-checkout CI run after npm ci/install; do not trust only a developer workspace.

### P1 — causal task outcomes
Use paired tasks and fresh workspaces:
- A: no learned gate / baseline harness.
- B: frozen model/prompt baseline with the same policy and tools.
- C: trained world-model prediction used only for measurement.
- D: learned prediction actively changes gate/planning policy.
Where a four-arm design adds no scientific distinction, justify dropping an arm before looking at outcomes.

Primary metric: externally verified task success. Secondary: exact verifier details, recovery, tool calls, tokens, wall-clock latency, human interventions and safety denials. Calibration (Brier/ECE) is reported separately.

Run multiple task families and 3+ seeds for screening; use a predeclared power calculation and a larger, disjoint holdout for confirmatory claims. Publish per-case raw outcomes. No manual promotion of an experimental skill.

### P2 — generalization and transfer
- Train on task/project A, validate on different tasks from A, test on task/project B.
- Run cross-environment transfer as a paired baseline-vs-transferred experiment. Action-string overlap is not transfer evidence.
- Introduce controlled perturbations: file layout variation, tool schema drift, flaky operation, interrupted process, stale memory, and adversarial instructions in tool output.
- Keep the hidden holdout evaluator-only-write. Prevent execution network access from fetching rubrics.
- Promote only when task outcomes improve and safety/cost bounds do not regress.

### P3 — only after evidence is robust
- Pareto branch archive with explicit diversity.
- Router trained on development data only.
- Optional model-weight co-optimization if the business and compute budget justify it.
- No MARL or broad agent-society expansion in this phase.

## Public/primary reference links

- HarnessPro: https://arxiv.org/abs/2610.26770
- HarnessPro code: https://github.com/pzs19/HarnessPro
- Harness²: https://arxiv.org/abs/2610.14224
- Harness² code: https://github.com/google-research/harness2
- Self-HPO: https://arxiv.org/abs/2610.22791
- Mixture of Self-Improving Branches: https://arxiv.org/abs/2609.37834
- Apple HIG: https://developer.apple.com/design/human-interface-guidelines
