# hmharness skill experiment arm-blind design

Use when running skill candidate experiments in hmharness, especially when pass rates look identical (e.g., 9/10 vs 9/10, p=1.0) or when gate cases may leak arm identity.

## Steps
1. Separate cases into holdout and non-holdout sets.
2. Add non-holdout cases first: known-good and known-bad cases that exercise the runner and skill injection.
3. Ensure gate cases are arm-blind: no prompt reveals expected answer or skill arm.
4. Fix makeCaseRunner skillsPrompt injection before final runs; inject skill content only after cases are locked.
5. Shuffle case order and use explicit arm labels.
6. Record per-case pass/fail in JSON, not just aggregate proportions.
7. Run at least 3 seeds and compute per-case agreement or McNemar, not just exact proportion.
8. If all arms tie at 9/10, suspect arm-blind leakage; inspect case outputs to confirm the candidate actually exercised the skill.

## Example
python makeCaseRunner.py --cases cases.json --arms baseline,candidate --seed 3 --output results.json
# Then read results.json and check per-case arm comparisons.

## Pitfalls
- p=1.0 with small n is not evidence of equivalence.
- Arm-blind means prompt cannot expose arm identity or expected output.
- Aggregate accuracy hides per-case differences.
