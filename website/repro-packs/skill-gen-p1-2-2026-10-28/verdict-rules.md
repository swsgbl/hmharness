# Pre-registered verdict rules — skill-gen-p1-2-2026-10-28

Verdict enum and rules, frozen BEFORE implementation (commit 1f606f9). Reproduced verbatim from the experiment manifest.

Extracted from `published/manifest.json` at `preRegistered` (machine copy, no rewording):

```json
{
  "mainEndpoint": "per family: contB vs contA — contiguous-containment rate of the arm's selected skill over ALL holdout successes (same 口径 as the measured 0.39; arm A's trigger is env-only so its matched set IS the full holdout set)",
  "significance": "per family: exact McNemar two-sided over per-trajectory paired containment flags (A vs B), p<0.05; plus seeded task-level bootstrap 95% CI (10k resamples) on the paired rate difference as a check",
  "verdictEnum": [
    "POSITIVE",
    "WEAK-POSITIVE",
    "MIXED",
    "NEGATIVE",
    "NEEDS-DATA"
  ],
  "verdictRule": {
    "POSITIVE": ">=2/3 families contB>=contA AND no family contB < contA-0.05 AND >=1 family with contB>contA and McNemar p<0.05",
    "WEAK-POSITIVE": ">=2/3 families contB>=contA AND no family contB < contA-0.05 AND no significant family",
    "MIXED": "some family improves and some degrades by >0.05 without dominating pattern",
    "NEGATIVE": ">=2/3 families contB<contA (honest negative is a legal deliverable)",
    "NEEDS-DATA": ">=2 families are low-power (holdout successes <10), or a family pool degenerates (no mined candidates) — stated as NEEDS-DATA with what is missing"
  },
  "lowPower": "family with <10 holdout successes is flagged low-power; it still reports numbers but cannot alone drive POSITIVE/NEGATIVE",
  "secondaryEndpoint": {
    "name": "trigger precision (mechanism check: do mined preconditions carry real information?)",
    "definition": "P@tau = |contains AND matched| / |matched| for the B skill per family; baseline is arm A's env-only trigger whose precision IS contA; effective iff >=2/3 families P_B > contA with that family's matchRate M1>=0.2 (a matcher that fires on <20% of cases proves nothing even at precision 1)",
    "alsoReported": [
      "matchRate M1 = matched/holdoutSuccesses",
      "recall R@tau = |contains AND matched| / |contains|",
      "vacuous-skill flag if B skill has zero structured preconditions"
    ]
  },
  "perCase": "every holdout success carries {family, id, containsA, containsB, matchedB, scoreB, satisfiedChecks, totalChecks}",
  "honestyClauses": [
    "negative results reported as negatives (三臂 discipline)",
    "promotion gate 0.6 never lowered, never re-defined",
    "holdout never feeds mining, selection, thresholds, or grammar",
    "degenerate families (empty pool / no-signal pool) recorded, not papered over",
    "all rules frozen HERE before implementation; any deviation logged in REPORT.md as an execution deviation"
  ],
  "cost": {
    "llmTokens": "zero — this is a corpus-replay experiment (mining/scoring are pure local computation), no API calls; wallclock ms per phase recorded on disk",
    "noApiNote": "the 429 phase-boundary rule is structurally inapplicable (no network); recorded here so its absence is a stated fact, not an omission"
  }
}
```
