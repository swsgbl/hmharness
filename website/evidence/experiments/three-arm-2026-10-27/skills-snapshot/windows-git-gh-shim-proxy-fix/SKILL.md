## Symptom
- On Windows, `gh` (Go exec) fails with: failed to run git: 'merge' 不是内部或外部命令.
- Root cause: `where git` first returns a `.cmd` shim such as `C:\Users\hongfu\.local\bin\git.cmd`, which Go exec cannot invoke.

## Fix
1. Check PATH: `where git`.
2. Prepend real Git cmd dir for the current shell before running gh:
   `set "PATH=C:\Program Files\Git\cmd;%PATH%"`
   Or remove `C:\Users\hongfu\.local\bin` from PATH.
3. Avoid cmd trailing-space bug: do NOT use `set VAR=value && cmd2`; the space before `&&` becomes part of the value. Use:
   `set "VAR=value"`
   or pass config directly to git.
4. If GitHub API/push needs a proxy, set:
   `set "https_proxy=http://127.0.0.1:7892"`
   then run `gh` or `git push`.

## Example push without env pollution

git -c http.proxy=http://127.0.0.1:7892 -c https.proxy=http://127.0.0.1:7892 push origin feature-branch


## Verify
- `git --version`
- `gh --version`
- `where git` shows only real Git executable first.