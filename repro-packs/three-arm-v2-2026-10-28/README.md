# Repro pack: three-arm-v2-2026-10-28

External reproduction of the published verdict — from a fresh directory, no hmharness repo, no API keys, no network, deterministic (fixed seeds, zero LLM tokens).

**Published verdict being reproduced:**

```json
{
  "gate": {
    "verdict": "NEEDS-DATA",
    "gates": [],
    "reason": "C arm not deployable: the evolution gate rejected the ENTIRE candidate population (v2 GEPA-style population rule — the honest outcome of the persistent-evolution path)"
  },
  "mainEndpoint": {
    "comparison": "C-vs-A",
    "split": "protect",
    "diff": 0,
    "significant": false,
    "needsData": [
      "only 0 paired tasks (<15)",
      "only 0 discordant cells (<8) — exact test underpowered"
    ]
  },
  "cDeployable": false,
  "datasetHash": "cd45058a6cc825492127a16eff3697aba6480fe49bb4291048790876aaf495ed"
}
```

## One command

```bash
node reproduce.cjs     # Node >= 22.7 (uses native --experimental-transform-types; tsx as fallback)
```

It (1) runs the frozen analyzer byte-identical to the repo's `scripts/three-arm-v2-analyze.mts` against the frozen input data inside this pack, (2) regenerates the machine-verdict artifacts, (3) diffs every field against the frozen copies in `published/`, and (4) verifies the pack's own file integrity against the sha256 index in `manifest.json`. Success prints `RESULT: IDENTICAL` (exit 0).

`node compare.cjs` re-runs only step (3)+(4) without re-running the analyzer.

## What is compared

- `website/evidence/experiments/three-arm-v2-2026-10-28/analysis.json` (json) vs `published/analysis.json` — volatile fields pruned from both sides: generatedAt

Regenerated but not byte-compared (see manifest.json → extraOutputs):
- `website/evidence/experiments/three-arm-v2-2026-10-28/report.md` — regenerated machine report (human-readable rendering of analysis.json); its published twin was clobbered by REPORT.md on NTFS, so no byte-compare target exists — every number in it is diffed via analysis.json

## Layout

- `scripts/three-arm-v2-analyze.mts` — the frozen analyzer, byte-identical (it resolves its inputs relative to its own location, which is why the pack mirrors a slice of the repo layout).
- `published/` — frozen copies of the verdict artifacts + the experiment's preregistration manifest.
- `verdict-rules.md` — the pre-registered decision rules (enum-locked), verbatim.
- `env-fingerprint.json` — node version, dataset hash(es), seeds.
- `manifest.json` — sha256 index of every file (CRLF-normalized basis ⇒ verifiable on any checkout EOL policy) + the full recipe record.
- `website/evidence/experiments/three-arm-v2-2026-10-28/` — frozen analyzer inputs mirrored from the published evidence (reads only).

Deliberately NOT included (analyzer never reads them; honesty list from manifest.json → evidenceExcluded):
  - `phases/0-outputs/` — raw per-run model outputs; the analyzer never reads this directory (report text references it by name only)
  - `phases/3-outputs/` — same — raw outputs, not an analyzer input
  - `gate-home/` — isolated gate-home copy used by the experiment DRIVER (phase 2); the offline analyzer never touches it
  - `skills-snapshot/` — frozen skill-library snapshot injected into the arms; driver input, not analyzer input
  - `REPORT.md` — human execution report (it also clobbered the machine report.md on case-insensitive NTFS — on-record deviation); analysis.json is the machine-verdict superset being reproduced

## Verdict rules

See `verdict-rules.md`: the decision enum and every gate were frozen in the experiment manifest BEFORE implementation; the analyzer's verdict language is generated, not hand-worded.

## Honesty clauses

- The comparator prints DIFF and exits non-zero on any field difference — identity is claimed only field-by-field, never "close enough".
- The packager refuses to ship a pack whose self-test does not produce IDENTICAL.
- Corpus/data drift vs the published run is handled by freezing the inputs INSIDE the pack, not by re-running against live data.
