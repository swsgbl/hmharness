# Windows Browser Publish Preflight

Use before any browser automation or publishing task to avoid repeated ENOENT/port failures.

## 1. Verify target file paths
- List the workspace directory first; never assume filenames.
powershell
Get-ChildItem G:\hmharness-yingxiao\posts | Select-Object Name

- Confirm exact paths and case before read/write/edit.
- If a required file is missing, create it with write_file before continuing.

## 2. Verify browser-harness skill path
powershell
Test-Path C:\Users\<user>\.claude\skills\browser-harness\SKILL.md

If false, locate the real path with `dir /s /b SKILL.md` and update.

## 3. Verify Chrome remote debugging port 9222
powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen

Do not retry netstat/findstr loops. If the port is not listening, start Chrome with --remote-debugging-port=9222 before automation.

## 4. Verify browser CDP dependency
powershell
Test-Path node_modules\baoyu-chrome-cdp

If missing, run `npm install` in the project directory.

## 5. Use native PowerShell and UTF-8
- Prefer PowerShell cmdlets (Get-ChildItem, Select-String, Get-NetTCPConnection) over netstat/findstr.
- Set `$OutputEncoding = [System.Text.Encoding]::UTF8` before reading/writing Chinese content.

## 6. Serialize same-file edits
- Do not issue concurrent edits to the same draft file.
- Complete one edit and verify before starting the next.

## 7. Re-check after repair
After creating a missing file or starting Chrome, re-run the exact preflight command before executing the task script.