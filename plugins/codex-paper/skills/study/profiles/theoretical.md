# Theoretical Paper Profile

## Use when
The paper's core contribution is a theorem, proof, formal bound, derivation, or mathematical argument.

## Required evidence
- Formal assumptions and definitions.
- Theorem statements and dependency order.
- Proof bottlenecks and lemmas.
- Boundary conditions and examples.
- Any simulation or numerical check used to illustrate the theory.

## Required reasoning checks
- Which assumptions carry the main conclusion?
- Which proof step is the bottleneck?
- Does the theorem cover the informal claim?

## Common weakest assumptions
- Smoothness, convexity, independence, realizability, or boundedness assumptions.
- Hidden regularity conditions.
- A proof step that only holds in a narrow regime.

## Minimal reproduction
Build a proof dependency map and run a boundary-case or numerical sanity check.

Support and falsification criteria may be formal boundary checks, violated assumptions, limiting constructions, or proof-dependency failures; do not invent conventional experiments.

## Strong counterexample
A construction that violates the weakest assumption while preserving the problem setting.

## Suitable learning artifacts
Symbolic derivation, numerical sanity check, or small simulation.

## Do not force
Do not require conventional experiments, ablations, or code reproduction when the paper does not make empirical claims.
