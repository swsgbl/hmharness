# Recovering from read_file / write_file Errors

Recurring failure signatures:
- read_file → EISDIR: the path is a directory, not a file.
- read_file → ENOENT: file does not exist at the assumed path.
- write_file → ENOENT: the parent directory does not exist yet.

## Error → Fix table
- read_file EISDIR → the target is a directory. Use list_dir on it instead.
- read_file ENOENT → wrong or assumed path (e.g. memory.json, src/Root.tsx
  may simply not exist). list_dir the parent to find the real name; never
  assume paths you have not listed this session.
- write_file ENOENT → create the parent directory first, then retry the exact
  same write_file call.
- Tool-call JSON parse error → unescaped quotes/backslashes in the path;
  escape backslashes or use forward slashes before retrying.

## Workflow
1. On first touch of a new project, discover structure before any read:
   run_command: `cd /d G:\Proj && dir /s /b` (or list_dir level by level).
2. Probe with list_dir before read_file on any path not yet seen this session.
3. Before write_file into a new tree, create parents in one shot:
   run_command: powershell -Command "New-Item -ItemType Directory -Force -Path 'G:\NewProj\src\main'"
4. Retry write_file with the identical path after mkdir succeeds.
5. Record confirmed paths with remember so later turns skip probing:
   remember "paths: G:\Scrapling is a directory (python project); G:\StrixPromo\src exists"

## Example
write_file G:\NewProj\src\main\module.json5 → ENOENT
run_command powershell New-Item -Force → OK
write_file G:\NewProj\src\main\module.json5 → OK

## Rule of thumb
One probe (list_dir) per unknown path beats three failed read_file attempts;
every failed call burns a turn that long tasks cannot afford.