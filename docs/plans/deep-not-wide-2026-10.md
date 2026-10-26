# HMH deep-not-wide upgrade plan (2026-10-27)

## Rewritten mission

Prove and improve the existing cognitive runtime rather than enlarging its feature list. Every capability claim must be tied to code, an automated test, an independently verifiable runtime artifact, or an explicit NEEDS-DATA status.

### Success outcomes

1. A clean external checkout can install, typecheck, build and test reproducibly.
2. Prediction-to-action changes measurably improve externally verified task success or are rejected.
3. Learned behavior transfers to disjoint tasks/environments and survives long-running recovery tests.
4. Evolution cannot write hidden evaluation assets and cannot bypass approval/sandbox policy.
5. HMH Desktop's everyday task loop is visually coherent, keyboard-accessible, and verified on Windows; OpenHarmony continues to use platform-appropriate ArkUI patterns.
6. No claim of AGI is based on one metric, one model, one task family, or self-reported success.

## First implementation slices

### Slice 1 — Reproducible evaluation (P0)
- Use content-sensitive data fingerprints, exact code commit, schema, model/provider, prompt/config hashes, tool versions, seed, split and host/network policy.
- Exclude unknown outcomes from binary calibration scoring; return null/NEEDS-DATA for an empty denominator.
- Use unbiased seeded shuffles.
- On CI, install from a clean checkout and ensure workspace package resolution cannot be shadowed by nested registry packages.
- Gate: test passes in CI after a clean install; data fingerprint changes when action/outcome/state/metrics change but not when only record listing order changes.

### Slice 2 — Causal improvement (P0)
- Expand the live P2A run beyond the current three small synthetic task families.
- Freeze model/provider/tool versions during the paired experiment.
- Keep task workspaces fresh and randomize run order.
- Primary outcome: independent verifier success. Secondary: action/tool calls, recoveries, tokens, duration, user approvals/interrupts and safety denials.
- Report calibration separately from outcome lift.
- Gate: show raw rows and uncertainty intervals; otherwise report NEEDS-DATA.

### Slice 3 — Transfer and autonomy (P1)
- Train on one task family/project and test on non-overlapping target families/projects.
- Introduce controlled environment variation and failure recovery.
- Run 2h/8h/24h stress sessions only after a runnable test fixture exists, preserving checkpoints, crash reason, cursor and duplicate-action evidence.
- Gate: transferred arm beats target-domain baseline, not just train-domain baseline.

### Slice 4 — Safety gate (P0 continuously)
- Preserve hidden-evaluator separation; executor cannot fetch public rubrics/test details.
- Sandbox red-team vectors remain mandatory.
- Any new dynamic code path must go through the declared sandbox/capability broker and be covered by hostile-input tests.
- Interrupts are not accepted until every in-flight await respects cancellation or a verified process-kill fallback closes the task, with no orphan worker.
- Gate: no successful escape in the specified suite; do not generalize that result beyond the suite.

### Slice 5 — Desktop task loop (P0 for UX, separate PR)
- Start from current v0.2.6 architecture, not a rewrite.
- Keep the runtime as the single source of truth.
- Apply HIG-inspired visual refinement to toolbars, sidebar, focus states, motion and contrast.
- Break App.tsx into components only after the first screenshot/E2E baseline, or as a separate behavior-neutral refactor.
- Gate: screenshots across themes/viewports and tests for setup, session create/switch, send/stream/stop, approval, error recovery, files/diff/evidence/logs.

## AGI capability evaluation: a vector, not a single score

Track each dimension independently:
- Task success (external verifier pass rate).
- Sample efficiency (gain per newly collected trajectory).
- Generalization (disjoint task template/repository).
- Transfer (source task/environment vs unseen target).
- Adaptation (tool/schema/environment perturbations).
- Recovery (fault injection, interrupted run, checkpoint resume, no duplicate destructive action).
- Calibration (Brier/ECE with denominator and interval).
- Autonomy (human interventions/approval count, not a simplistic “zero human” objective).
- Safety (attack-specific success rate and severity, not an average that masks a critical failure).
- Cost/latency (p50/p95 tokens, wall-clock, retries).
- Reliability (clean-install pass, crash-free long-run, state integrity).

Every dashboard uses PASS / FAIL / NEEDS-DATA. Undefined is not zero. “AGI” is not a measured status unless a separate, preregistered capability protocol is defined; this plan only evaluates bounded capabilities.

## Recommended release gates

### Gate A: code correctness
- clean-checkout npm install
- typecheck
- package build
- full tests
- targeted cancellation, XSS, tool schema and sandbox adversarial suite

### Gate B: scientific quality
- preregistration before test run
- disjoint/temporal holdout
- independent verifier and no evaluator leakage
- full content data hash and exact configuration
- paired outcomes and uncertainty
- raw per-task results and honest negative findings

### Gate C: usability
- core task flow keyboard-complete
- light/dark/system, reduced motion, contrast modes
- at least three screenshots with stable viewport
- fresh-user install and runtime-connect flow
- UI interactions do not regress runtime semantics

## Stop doing for this phase

- No new large agent topology/MARL.
- No broad tool/MCP count expansion.
- No weights training before the harness lift is established.
- No broad UI rewrite on the same branch as evaluation logic.
- No claim of transfer/generalization based on shared action names or overlapping holdouts.
