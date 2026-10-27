# Safe Path Existence Check

Before any `read_file`, `write_file`, or `run_command` that targets a specific path, always verify the path exists first.

## Steps

1. **Discover the actual project structure** before assuming paths:
   
   run_command: pwd
   list_dir: <parent-directory>
   

2. **Check directory exists** before writing into it:
   
   list_dir: G:\StrixPromo\src
   
   If it fails with ENOENT, create it first via `run_command`: `mkdir -p G:\StrixPromo\src`

3. **Check file exists** before reading it:
   
   read_file: G:\project\memory.json
   
   If ENOENT, confirm the correct path with `list_dir` on the parent directory.

4. **Never pass a directory to `read_file`** — `EISDIR` means you gave it a folder, not a file. Verify with `list_dir` first.

## Common Pitfalls
- Assumed paths like `memory.json` or `Root.tsx` may not exist in the expected location.
- Windows paths use backslashes — ensure they are properly handled.
- Always run `pwd` and `list_dir` at the start of a new session to map the workspace.

## Example Fix

# Instead of directly reading:
read_file: G:\StrixPromo\src\Root.tsx  # ENOENT!

# Do this first:
pwd
list_dir: G:\StrixPromo
list_dir: G:\StrixPromo\src
# Then read the actual file that exists
