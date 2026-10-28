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

## 原始树出版脱敏补录（与 v2 同款纪律）

- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-echo-t5-first.task: pre-scrub sha256[:16]=609597ac033e5ce5
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-t10-l4.task: pre-scrub sha256[:16]=e407f7e2dc49d7ca
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-t2-last.task: pre-scrub sha256[:16]=e479b489745838ab
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-t6-l2.task: pre-scrub sha256[:16]=21cc57725491f1f8
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-t6-l5.task: pre-scrub sha256[:16]=4a60d73ff5498c1b
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/beh-t8-n.task: pre-scrub sha256[:16]=b460f6791e57297b
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/behave-echo-count3.task: pre-scrub sha256[:16]=faede0c919831a89
- website/evidence/experiments/three-arm-2026-10-27/gate-home/bench/cases/behave-echo-last.task: pre-scrub sha256[:16]=9d5a9e0f0ac6f7b4
- website/evidence/experiments/three-arm-2026-10-27/gate-home/skills/active/browser-automation-preflight/SKILL.md: pre-scrub sha256[:16]=6a6fd477c0249d7f
- website/evidence/experiments/three-arm-2026-10-27/gate-home/skills/active/harmony-local-ui-baseline-check/SKILL.md: pre-scrub sha256[:16]=064b66a346edc517
- website/evidence/experiments/three-arm-2026-10-27/gate-home/skills/active/hmharness-session-log-search/SKILL.md: pre-scrub sha256[:16]=724ae7bfbaf6ec3f
- website/evidence/experiments/three-arm-2026-10-27/gate-home/skills/active/windows-browser-publish-preflight/SKILL.md: pre-scrub sha256[:16]=7060f637b303ab2c
- website/evidence/experiments/three-arm-2026-10-27/gate-home/skills/active/windows-git-gh-shim-proxy-fix/SKILL.md: pre-scrub sha256[:16]=66dbb04bd32559a1
- website/evidence/experiments/three-arm-2026-10-27/manifest.json: pre-scrub sha256[:16]=f1f5f071d16a4e0a
- website/evidence/experiments/three-arm-2026-10-27/skills-snapshot/browser-automation-preflight/SKILL.md: pre-scrub sha256[:16]=6a6fd477c0249d7f
- website/evidence/experiments/three-arm-2026-10-27/skills-snapshot/harmony-local-ui-baseline-check/SKILL.md: pre-scrub sha256[:16]=064b66a346edc517
- website/evidence/experiments/three-arm-2026-10-27/skills-snapshot/hmharness-session-log-search/SKILL.md: pre-scrub sha256[:16]=724ae7bfbaf6ec3f
- website/evidence/experiments/three-arm-2026-10-27/skills-snapshot/windows-browser-publish-preflight/SKILL.md: pre-scrub sha256[:16]=7060f637b303ab2c
- website/evidence/experiments/three-arm-2026-10-27/skills-snapshot/windows-git-gh-shim-proxy-fix/SKILL.md: pre-scrub sha256[:16]=66dbb04bd32559a1

以上文件中的环境用户名串已原地替换为 `<user>`；替换前内容指纹如上，可对照 git 历史核验唯一改动即该串。任务集与判定数据的指纹不受影响（用户名仅出现于机器技能快照/清单的环境路径字段）。
