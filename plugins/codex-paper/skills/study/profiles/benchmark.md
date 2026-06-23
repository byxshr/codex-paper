# Benchmark Paper Profile

## Use when
The paper introduces or analyzes a dataset, evaluation suite, metric, leaderboard, or benchmark protocol.

## Required evidence
- Task definition and construct validity.
- Data source and annotation process.
- Inclusion, filtering, and quality controls.
- Metrics and sensitivity to scoring choices.
- Coverage and contamination analysis.

## Required reasoning checks
- What capability is the benchmark intended to measure?
- Do examples actually instantiate that construct?
- Can model rankings flip under a reasonable metric change?

## Common weakest assumptions
- The benchmark construct is valid.
- Data is not contaminated.
- Annotation and filtering do not create systematic bias.

## Minimal reproduction
Audit a sample of items, recompute the metric, or test a metric-sensitivity perturbation.

Support and falsification criteria may be dataset, scoring, annotation, or construct-validity checks; they do not need to be model-training experiments.

## Strong counterexample
Contamination, construct mismatch, or a scoring change that reverses rankings.

## Suitable learning artifacts
Taxonomy explorer, metric-sensitivity demo, or annotation audit worksheet.

## Do not force
Do not require method ablations unless the paper also proposes a model or algorithm.
