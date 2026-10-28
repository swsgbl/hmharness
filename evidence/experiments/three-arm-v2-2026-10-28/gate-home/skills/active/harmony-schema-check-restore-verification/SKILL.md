# HarmonyOS: harmony_schema_check restore verification

Use `harmony_schema_check` as a cheap pre-build config gate and verify non-git restores byte-for-byte on Windows.

## When to use
- After editing `module.json5` or `build-profile.json5`
- Before `hvigorw assembleHap` in a project that is NOT a git repo, so `git status` cannot prove a clean restore

## Workflow
1. Run from the project root, not from `entry/build/default/intermediates/hap_metadata` or other subdirs:
   cd /d G:\hmharness-selffeed\SelfFeedN
   harmony_schema_check
2. Read errors as `absolute file path + dotted JSON path + remedy`:
   - `module.json5 :: module.mainElement - entry modules must name a mainElement (the launch ability)`
   - `module.json5 :: module.deviceTypes - entry modules need a non-empty deviceTypes array`
3. Fix and re-run until green; these are caught by the cheap pre-build check instead of a 3-minute hvigor failure.

## Restore verification when NOT a git repo
1. Keep a backup before editing:
   copy G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5 G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5.bak
2. Restore:
   copy /Y G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5.bak G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5
3. Verify byte-for-byte:
   fc /b G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5.bak G:\hmharness-selffeed\SelfFeedN\entry\src\main\module.json5
   Expected: exit code 0 and `找不到差异`.
4. On Unix use cmp instead: cmp module.json5.bak module.json5 && echo RESTORED

## Notes
- `harmony_schema_check` validates structure/enums only, not SDK-version range/plausibility; use `harmony_build_doctor` for build-log classification.
- Record the closed-loop evidence with `remember`.