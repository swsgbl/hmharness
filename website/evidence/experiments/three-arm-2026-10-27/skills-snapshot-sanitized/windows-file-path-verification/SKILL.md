# Windows File Path Verification

When working on Windows, file paths can cause issues due to case sensitivity or incorrect assumptions. Always verify paths before file operations.

## Steps

1. Before any file read or write, list the parent directory to confirm the exact path and existence.
   - Use `list_dir` tool with the parent directory path.
   - Example: If target is `D:\project\src\main.ts`, first run `list_dir` on `D:\project\src\`.

2. Check the output to ensure the file or directory exists and the name matches case-sensitively.
   - Look for the exact file name in the listing.

3. Use native Windows commands in `run_command` if needed, avoiding Unix tools.
   - Example: Use `dir` in cmd or `Get-ChildItem` in PowerShell.

4. If path is part of a worktree, verify the worktree path first using harmony tools if applicable.

## Example Commands

- `list_dir(path: "D:\\AI Learning OS\\ai-learning-os-worktrees\\m13-14-harmony-governance-controls\\.verify")`
- `run_command(command: "dir D:\\project\\src", workdir: "D:\\project")`

By following this workflow, you can prevent common file-not-found errors on Windows.