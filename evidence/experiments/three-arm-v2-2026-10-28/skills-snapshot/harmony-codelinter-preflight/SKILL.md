# Harmony Codelinter Preflight

Goal: Avoid `codelinter` not found or silently skipped during HarmonyOS lint checks.

## Detect
1. Run `run_command`:
   - `hvigorw codelinter --help`
   - `where codelinter`
2. If output includes usage info, plugin/path is present.
3. If command fails or returns non-zero, treat as missing.

## Fix
- In DevEco Studio: open Settings > Plugins, search `codelinter`, install/enable, restart IDE.
- Or set environment variable to the codelinter executable, e.g. in PowerShell:
  - `$env:HM_CODELINTER = 'C:\Program Files\Huawei\DevEco Studio\plugins\codelinter\bin\codelinter.exe'`
  - Verify with `& $env:HM_CODELINTER --help`.
- For persistent shell sessions use `setx HM_CODELINTER "C:\path\to\codelinter.exe"` and reopen terminal.

## Re-run
- Run lint again: `hvigorw codelinter`.
- Confirm no `module not found` or `plugin not installed` errors in logs.