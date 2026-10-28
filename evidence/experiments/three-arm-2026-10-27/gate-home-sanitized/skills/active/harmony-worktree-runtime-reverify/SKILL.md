# HarmonyOS Worktree Runtime Re-verification

Use this when starting or resuming a HarmonyOS runtime verification inside a Windows worktree, especially when turn budget is limited.

## Preflight every session
1. List the worktree parent and confirm exact path/case:
   `list_dir "D:\AI Learning OS\ai-learning-os-worktrees\m13-14-harmony-governance-controls"`
2. Confirm branch and project files; read `build-profile.json5` and `oh-package.json5`.
3. Run `harmony_toolchain_check` and report missing hdc/hvigorw/ohpm before any build.

## Stage 1: Build
4. From the project root, run `harmony_build` or hvigorw; capture stdout and error text.
5. Do not continue if the build fails. Save the exact error to memory and stop before the turn boundary.

## Stage 2: Device/emulator
6. List devices with `harmony_devices`. If empty, start an emulator and wait for a device such as `127.0.0.1:5555`.
7. Re-check with `harmony_devices` and record the exact device id.

## Stage 3: Sign/install/launch
8. Sign only after a successful build with `harmony_sign`.
9. Install with an explicit HAP path:
   `harmony_install --bundle "D:\...\entry\build\default\outputs\default\entry-default-signed.hap"`
10. Launch with an explicit bundle/ability:
    `harmony_launch --bundle <bundleName> --ability <abilityName>`
    Or use `harmony_device_test --bundle <bundleName>`.

## Stage 4: Runtime evidence
11. Capture UI with screenshot tooling if available and inspect via `see_image`.
12. Collect logs:
    `hdc -t 127.0.0.1:5555 hilog | findstr /I "ArkTS"`
    Or use PowerShell `Select-Object -First 200` / `Select-String`.
13. Compare actual UI/log against expected behavior and record the discrepancy.

## Checkpoint before turn ends
14. Use `remember` with this exact data:
    worktree path, branch, device id, completed stage, next stage command, and last error/output snippet.
15. On resume, read memory first, skip completed stages, and continue from the next uncompleted stage.

## Example commands
- `list_dir "D:\AI Learning OS\ai-learning-os-worktrees\m13-14-harmony-governance-controls"`
- `harmony_toolchain_check`
- `harmony_build`
- `harmony_install --bundle "D:\...\entry-default-signed.hap"`
- `hdc -t 127.0.0.1:5555 hilog | findstr /I "ArkTS"`
- `remember "worktree=... device=127.0.0.1:5555 stage=launch next=log"`