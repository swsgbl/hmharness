# Windows Command Compatibility

The agent runs on Windows hosts. Unix commands cause silent or explicit failures.

## Common Replacements

| Unix | Windows (cmd) | Windows (PowerShell) |
|---|---|---|
| `head -n 5 file` | `more +5 file` | `Get-Content file | Select-Object -First 5` |
| `tail -n 5 file` | N/A | `Get-Content file | Select-Object -Last 5` |
| `ps aux` | N/A | `Get-Process` |
| `findstr -i "pattern"` | `findstr /i "pattern"` | `Select-String -Pattern "pattern" -CaseSensitive:$false` |
| `grep -r "pattern" .` | `findstr /s /i "pattern" *.*` | `Get-ChildItem -Recurse | Select-String -Pattern "pattern"` |
| `which <cmd>` | `where <cmd>` | `Get-Command <cmd>` |
| `kill <pid>` | `taskkill /PID <pid> /F` | `Stop-Process -Id <pid>` |
| `df -h` | `wmic logicaldisk get size,freespace,caption` | `Get-PSDrive -PSProvider FileSystem` |
| `ls` | `dir` | `Get-ChildItem` |
| `cat file` | `type file` | `Get-Content file` |
| `mkdir -p a/b/c` | `mkdir a\b\c` | `New-Item -ItemType Directory -Force -Path a/b/c` |

## Lesson Learned

`run_command` failed 30+ times when agents assumed Unix syntax. Always default to PowerShell where possible.

Example:
powershell
# Instead of: pip list | grep -i ai
Get-Command pip | ForEach-Object { & $_.Source list } | Select-String -Pattern "ai|agent|llm"

