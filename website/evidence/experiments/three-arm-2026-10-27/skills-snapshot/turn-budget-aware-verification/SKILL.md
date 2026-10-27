## Turn-Budget-Aware Verification

1. **Assess task scope**: Estimate required turns based on directory size and complexity.
2. **Break into subtasks**: Split verification into small, completable steps (e.g., per-file reads, section checks).
3. **Checkpoint progress**: Use `remember` tool after each subtask to save state and avoid rework.
4. **Verify paths first**: Always `list_dir` and `read_file` on parent directories to confirm paths and avoid ENOENT errors.
5. **Prioritize operations**: Focus on critical checks (e.g., key files, device status) and defer non-essential steps.
6. **Example workflow**:
   - Step 1: `list_dir` on verification folder to get file list.
   - Step 2: `read_file` one file per turn, e.g., `read_file('path/to/file1.md')`.
   - Step 3: `remember('progress', {files_read: 1})` after each read.
   - Step 4: If turn budget low, summarize findings and exit gracefully.
7. **Tools used**: `list_dir`, `read_file`, `remember`, `run_command` for validation.