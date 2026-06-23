# Architecture Paper Profile

## Use when
The paper proposes a model architecture, module, layer, routing design, or major structural change.

## Required evidence
- Component descriptions and data flow.
- Parameter, compute, and memory budget.
- Main benchmark results.
- Ablations for component necessity.
- Scaling or efficiency discussion.

## Required reasoning checks
- What failure mode does each component target?
- Are gains explained by structure rather than parameter count or compute?
- Which component is necessary for the central claim?

## Common weakest assumptions
- Fair compute and parameter matching.
- Component interaction is causal rather than incidental.
- Ablation settings isolate a single mechanism.

## Minimal reproduction
Implement the smallest component-level behavior under matched budget and compare against a simpler baseline.

## Strong counterexample
An equal-parameter or equal-compute baseline that matches the reported gain without the new component.

## Suitable learning artifacts
Code demo, architecture explorer, simulation, or interactive component map.

## Do not force
Do not require dataset-scale training if a component-level behavior is enough for learning.
