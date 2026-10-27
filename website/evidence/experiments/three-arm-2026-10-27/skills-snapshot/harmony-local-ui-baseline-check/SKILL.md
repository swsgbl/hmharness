# HarmonyOS Local UI Baseline Check

## When to use
When you have a HarmonyOS app like SelfFeedR with existing UI baselines and need to verify pages after changes, or drive UI navigation for regression.

## Prerequisites
- Emulator or device reachable via hdc, typically target `127.0.0.1:5555`.
- Project root containing `hmh-baseline.cjs` and optionally `hmh-ui.cjs`.
- Baseline directory e.g. `C:\Users\hongfu\.hmharness\ops\ui-baselines\SelfFeedR\` with PNGs and `baseline.json`.

## Baseline check
1. `cd /d G:\hmharness-selffeed\SelfFeedR`
2. Run `node hmh-baseline.cjs check <Index|A|B|C>` for each page.
3. The tool compares screenshot hash/text sets against `baseline.json` and reports pass/fail.

## Device probing / navigation
1. Use `node hmh-ui.cjs state` to inspect current UI state.
2. Use `node hmh-ui.cjs tap "<text>"` to tap a control by visible text.
3. Use `node hmh-ui.cjs shot <png>` to capture a screenshot after each action.
4. Use `node hmh-ui.cjs logs` to pull runtime logs.
5. Typical navigation sequence: Index -> tap "Open Page A" -> page A -> tap "Go to B" -> page B -> tap "Go to C" -> page C.

## Tips
- Ensure emulator is in the state ground truth before running checks (`hdc list targets`).
- Re-run baseline checks after every UI-affecting change; do not report verified without running the check.
- Store new baselines by capturing shots and hashes into `baseline.json`.