# Safe File Operations

Prevent ENOENT/EISDIR failures by following this order.

## Before read_file

1. Use `list_dir` to confirm the path exists and is a file.
   bash
   # Verify parent directory
   ls <parent-dir>
   
2. Do not pass a directory path to `read_file` — it will fail with EISDIR.

## Before write_file

1. Always create the parent directory first.
   bash
   mkdir -p <parent-dir>
   
2. Then write the file.
   bash
   write_file path=<full-path> content=<content>
   

## Before run_command

1. Test with a lightweight probe first (`ls`, `pwd`, `echo ok`).
2. If a command fails, capture stderr and retry once with explicit working directory:
   bash
   cd <dir> && <command>
   
3. For pip/package checks, prefer checking with `where` or `which` before invoking:
   bash
   where python
   where pip
   

## Common Failure Patterns

| Error | Cause | Fix |
|---|---|---|
| ENOENT: no such file | Parent dir missing | `mkdir -p` first |
| EISDIR: illegal op | Read a directory | `list_dir` first to verify |
| Command failed 30x | Broken env/PATH | Probe with `echo $PATH` or `where` |
