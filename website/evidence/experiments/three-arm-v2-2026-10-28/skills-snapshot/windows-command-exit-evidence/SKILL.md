# Windows Command Exit Evidence

Use for any Windows run_command where outcome depends on exit code or process termination.

## Capture exit codes
- Do NOT use cmd /c "command & echo exit=%errorlevel%" to prove exit code; cmd expands %errorlevel% at parse time and reports the previous command's code.
- Use PowerShell $LASTEXITCODE immediately after the command in the same invocation:
run_command: powershell -NoProfile -Command "& { hvigorw assembleHap; Write-Output ('exit=' + $LASTEXITCODE) }"
- For npm/cjpm/hvigorw, add -NoProfile and long timeout; redirect large output to a file and poll tail instead of returning the full buffer.

## Detect crashed/hung processes
- Exit code 0 or timeout can be misleading when WerFault holds a crashed native process.
- Check WER events and process list:
run_command: powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Windows Error Reporting'} -MaxEvents 5 | Select-Object TimeCreated,Id,Message | Format-List"
run_command: powershell -NoProfile -Command "Get-Process | Where-Object {$_.Name -match 'cjpm|hvigor|node|qemu'} | Select-Object Id,Name,StartTime"
- If the expected output file/artifact is absent, treat as failure even if exit code was 0.

## Read, don't execute filenames
- Use read commands (Get-Content, Select-String, tail, cat) to inspect files; never pass a bare filename as a command.
- Quote semicolon/bracket values: --providers '[;dist]', not --providers [;dist].

## Final evidence
Claim success only when at least one of:
- exit code captured via $LASTEXITCODE
- expected output file exists with expected content
- process/WER checks confirm clean exit