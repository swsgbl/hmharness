# Browser Automation Preflight
Use before continuing WeChat/Weibo/browser tasks that rely on browser-harness or CDP.
## 1. Verify skill files
- Run: dir /s /b C:\Users\%USERNAME%\.claude\skills\browser-harness\SKILL.md
- Also check .zcode\skills\browser-harness\SKILL.md.
- If missing, list_dir the parent and install the skill before any browser action.
## 2. Verify Chrome debug port
- PowerShell: Get-NetTCPConnection -LocalPort 9222 -State Listen
- If no listener, start Chrome: & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=$env:TEMP\chrome-hmh
- Wait a few seconds and recheck.
## 3. Verify target content paths
- Run: dir /s /b G:\hmharness-yingxiao\posts\*.md
- Or use list_dir on G:\hmharness-yingxiao\posts.
- Confirm exact names (wechat-main.md, weibo-a.md, weibo-b.md) before read/edit; create any missing draft with write_file first.
## 4. Verify CDP dependency
- Run: cd /d G:\hmharness-yingxiao && npm ls baoyu-chrome-cdp
- If unmet, run: npm install
## 5. Resume only after all checks pass; never blindly retry the same failed command.
Example:
powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen
dir /s /b C:\Users\<user>\.claude\skills\browser-harness\SKILL.md
dir /s /b G:\hmharness-yingxiao\posts\*.md
