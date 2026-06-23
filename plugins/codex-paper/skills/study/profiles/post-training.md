# Post-Training Paper Profile

## Use when
The paper studies fine-tuning, RLHF, RLVR, reward modeling, preference optimization, distillation, or test-time training after pretraining.

## Required evidence
- Data source and filtering.
- Reward or preference signal.
- Sampling and rollout strategy.
- Baseline and training budget fairness.
- Stability, variance, and failure analysis.

## Required reasoning checks
- Which signal changes model behavior?
- Does the method improve credit assignment, exploration, or data quality?
- Are gains separable from budget, sampling, or filtering changes?

## Common weakest assumptions
- Reward signal is aligned with the target capability.
- Baseline budget is fair.
- Data quality or contamination is not the real driver.

## Minimal reproduction
Run a small controlled training or simulation with fixed budget and matched data.

## Strong counterexample
Reward hacking, data-quality confound, or equal-budget baseline that removes the gain.

## Suitable learning artifacts
Policy-update demo, reward-signal simulator, or budget-matching calculator.

## Do not force
Do not claim full capability reproduction from a toy RL demo.
