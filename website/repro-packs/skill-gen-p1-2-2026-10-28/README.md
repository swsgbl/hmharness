# Repro pack: skill-gen-p1-2-2026-10-28

External reproduction of the published verdict — from a fresh directory, no hmharness repo, no API keys, no network, deterministic (fixed seeds, zero LLM tokens).

**Published verdict being reproduced:**

```json
{
  "verdict": "WEAK-POSITIVE",
  "secondaryEndpoint": "effective",
  "selectionChanged": 0,
  "llmTokens": 0,
  "perFamily": {
    "terminal": {
      "n": 107,
      "contA": 0.48598130841121495,
      "contB": 0.48598130841121495,
      "m1": 0.3644859813084112,
      "pAtTau": 0.8717948717948718
    },
    "harmonyos": {
      "n": 21,
      "contA": 0.09523809523809523,
      "contB": 0.09523809523809523,
      "m1": 0.19047619047619047,
      "pAtTau": 0.5
    },
    "browser": {
      "n": 10,
      "contA": 0.1,
      "contB": 0.1,
      "m1": 0.4,
      "pAtTau": 0.25
    }
  }
}
```

## One command

```bash
node reproduce.cjs     # Node >= 22.7 (uses native --experimental-transform-types; tsx as fallback)
```

It (1) runs the frozen analyzer byte-identical to the repo's `scripts/skillgen-p1-2-experiment.mts` against the frozen input data inside this pack, (2) regenerates the machine-verdict artifacts, (3) diffs every field against the frozen copies in `published/`, and (4) verifies the pack's own file integrity against the sha256 index in `manifest.json`. Success prints `RESULT: IDENTICAL` (exit 0).

`node compare.cjs` re-runs only step (3)+(4) without re-running the analyzer.

## What is compared

- `website/evidence/experiments/skill-gen-p1-2-2026-10-28/phases/run.json` (json) vs `published/phases/run.json` — volatile fields pruned from both sides: generatedAt
- `website/evidence/experiments/skill-gen-p1-2-2026-10-28/phases/analysis.json` (json) vs `published/phases/analysis.json` — volatile fields pruned from both sides: generatedAt, wallclockMs
- `website/evidence/experiments/skill-gen-p1-2-2026-10-28/machine-verdict.md` (text) vs `published/machine-verdict.md` — byte-identical after EOL normalization


## Layout

- `scripts/skillgen-p1-2-experiment.mts` — the frozen analyzer, byte-identical (it resolves its inputs relative to its own location, which is why the pack mirrors a slice of the repo layout).
- `published/` — frozen copies of the verdict artifacts + the experiment's preregistration manifest.
- `verdict-rules.md` — the pre-registered decision rules (enum-locked), verbatim.
- `env-fingerprint.json` — node version, dataset hash(es), seeds.
- `manifest.json` — sha256 index of every file (CRLF-normalized basis ⇒ verifiable on any checkout EOL policy) + the full recipe record.
- `hmh-home/` — the corpus snapshot; `reproduce.cjs` points `HMH_HOME` here, so the analyzer reads the frozen corpus instead of your home directory.

Deliberately NOT included (analyzer never reads them; honesty list from manifest.json → evidenceExcluded):
  - `REPORT.md` — human execution report — analyzer output, not input (see deviation 6 in it)
  - `machine-verdict.md` — analyzer OUTPUT being reproduced; frozen copy ships as published/
  - `phases/run.json` — analyzer OUTPUT being reproduced; frozen copy ships as published/
  - `phases/analysis.json` — analyzer OUTPUT being reproduced; frozen copy ships as published/
  - `phases/sensitivity-exploratory.txt` — post-hoc exploratory artifact (manifest deviation 2); the preregistered analyzer never reads it

## Verdict rules

See `verdict-rules.md`: the decision enum and every gate were frozen in the experiment manifest BEFORE implementation; the analyzer's verdict language is generated, not hand-worded.

## Corpus snapshot (self-contained — your `~/.hmharness` is NOT used)

- `hmh-home/cognitive/trajectories/corpus.jsonl` — 467 usable trajectories of the 3 frozen families, in the exact loader order the published run saw (single file ⇒ readdir order is deterministic on every OS).
- dataset hash (frozen in the experiment manifest): `a2ac0a292557497fd8ed65911bb12c98cce630d15871c56be46cee816acc666d` — recomputed at pack time and equal.
- The corpus grew after the experiment ran; the packer dropped the 8 newest trajectories (ids in manifest.json → corpus.reconstruction) until the hash matched the freeze-time value, and verified per-family counts (terminal=355, harmonyos=79, browser=33).
- Projection: each trajectory is reduced to the fields the frozen analyzer consumes — `{id, environment.id, goal.description→tokenized, steps[].action.type/outcome, metrics.success}`. `goal.description` is replaced by its tokenize() output (the only form the experiment reads); 89 secret-shaped tokens (41 distinct: ≥12 chars with ≥4 digits) were dropped. The self-test proves the projection + redaction are verdict-neutral by requiring IDENTICAL.

## Honesty clauses

- The comparator prints DIFF and exits non-zero on any field difference — identity is claimed only field-by-field, never "close enough".
- The packager refuses to ship a pack whose self-test does not produce IDENTICAL.
- Corpus/data drift vs the published run is handled by freezing the inputs INSIDE the pack, not by re-running against live data.
