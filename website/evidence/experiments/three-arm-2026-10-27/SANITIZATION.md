# SANITIZATION — clean re-export of frozen evidence

Generated: 2026-10-27T23:49:56.470Z by `scripts/sanitize-evidence.mts` (repo commit below).

## Why

The publish hook blocks any pushed content containing the local Windows username.
The frozen originals in this directory predate the export-time sanitization fix and
carry the username inside absolute paths (`C:\Users\<name>\` etc.) and bare mentions.
Per the append-only evidence rule the frozen data is NOT rewritten; instead this
script emits side-car `*-sanitized` copies with every username occurrence replaced
by the `<user>` placeholder (case-insensitive, covers all path spellings).
Byte-level fidelity of everything EXCEPT the username token is preserved.

## What was produced

| kind | sanitized copy | files with replacements |
|---|---|---|
| dir | gate-home-sanitized | 13 |
| file | manifest.sanitized.json | 1 |
| dir | skills-snapshot-sanitized | 5 |

## Verification

Re-run `npx tsx scripts/sanitize-evidence.mts <thisDir>` from the repo root:
it is idempotent (side-cars are rebuilt, originals untouched), and after it runs
a case-insensitive scan for the username over the `*-sanitized` outputs finds nothing.

## Originals

The frozen originals are unchanged — datasetHash / fingerprints recorded in
`manifest.json` and the reports still verify against them, not against these copies.
