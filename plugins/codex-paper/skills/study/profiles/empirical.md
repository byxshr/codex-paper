# Empirical Paper Profile

## Use when
The paper primarily supports claims with experiments, ablations, metrics, datasets, or statistical comparisons.

## Required evidence
- Dataset construction, splits, and filtering.
- Baselines and whether budgets are comparable.
- Metrics and what they actually measure.
- Main result tables and any variance, seed, or confidence reporting.
- Ablations or controlled comparisons that isolate the mechanism.

## Required reasoning checks
- Which observation motivates the intervention?
- Which result supports the mechanism rather than a correlation?
- Are baseline, compute, data, and tuning budgets comparable?

## Common weakest assumptions
- Split independence.
- Metric validity.
- Baseline fairness.
- No hidden data contamination.

## Minimal reproduction
Use a smaller dataset or subset, the same metric, matched budget, fixed seeds, and one decisive baseline.

## Strong counterexample
Distribution shift, leakage control, or an equal-budget baseline that removes the reported gain.

## Suitable learning artifacts
Code demo, numerical sanity check, or small simulation.

## Do not force
Do not require a new theorem or full-scale reproduction.
