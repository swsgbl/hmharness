# hmharness Session Log Search

Goal: Reliably find and search past session JSONL logs under `~/.hmharness/sessions/<yyyy>/<mm>/<dd>`.

## Locate files
1. Confirm directory exists:
   - `list_dir` on `C:\Users\<user>\.hmharness\sessions`
   - or `run_command`: `dir "%USERPROFILE%\.hmharness\sessions" /s /b *.jsonl`
2. If missing, no logs; skip search.

## Search without false failure
`findstr` returns non-zero when no match, which can break scripts.
- Use PowerShell Select-String instead:
  - `powershell -NoProfile -Command "Get-ChildItem -Recurse -Filter *.jsonl '%USERPROFILE%\.hmharness\sessions' | Select-String -Pattern 'keyword' -SimpleMatch"`
- Or append `|| exit /b 0` after findstr to tolerate no matches.

## Extract user/assistant text
Use PowerShell JSON parsing:
powershell
Get-Content 'C:\Users\hongfu\.hmharness\sessions\2026\09\13\*.jsonl' | ForEach-Object {
  $o = $_ | ConvertFrom-Json
  if ($o.type -eq 'user' -or $o.type -eq 'assistant') { $o.text }
}


## Before reading a specific file
- Always `read_file` only after confirming path exists; recreate missing summary files from prior notes if needed.