# Turn-Budget Checkpointing for Long Tasks

Most recent session failures ended in `turn-budget` on multi-step tasks that
spawn follow-up "继续" turns. Prevent this by checkpointing progress in memory
and economizing tool calls.

## When to apply
- Any task likely to need more than ~10 tool calls (multi-repo setup, batch
  installs, multi-file edits, promotional builds).
- Any turn where the user says "继续" — treat it as a resume, not a fresh start.

## Steps
1. At task start, write the plan to memory:
   remember "task:<name> plan: 1)... 2)... 3)..."
2. After EVERY completed step, update the checklist:
   remember "task:<name> done: <last step>; next: <exact file or command>"
3. Batch independent shell commands into a single run_command with `&&` or `;`
   (e.g. `hdc list targets && hdc shell param get const.product.name`).
4. Cache list_dir results in memory; never re-list the same directory in a
   later turn.
5. When nearing budget, write a precise resumption note containing the exact
   next file path and next command, then stop cleanly.

## Resume protocol on "继续"
1. Recall / read the latest `task:*` note FIRST, before any exploration.
2. Execute the recorded `next` action immediately — no re-analysis, no
   re-listing the whole project.
3. Update the checkpoint after the action succeeds, before anything else.

## Example
remember "task:strix-promo done: Root.tsx written; next: write_file G:\StrixPromo\src\StrixPromo.tsx, then run hvigorw assembleHap"

## Why it works
Turn-budget deaths almost always come from re-exploring known state each
turn. A one-line checkpoint plus batched commands cuts resume cost to 1-2
tool calls.