# System Paper Profile

## Use when
The paper focuses on a deployed or deployable system, runtime, serving stack, compiler, storage layer, or infrastructure design.

## Required evidence
- Hardware and software environment.
- Workload and traffic assumptions.
- Latency, throughput, memory, or cost metrics.
- Bottleneck analysis.
- Failure, scalability, or deployment constraints.

## Required reasoning checks
- Which bottleneck is moved or removed?
- Does the evaluation workload match the claimed deployment setting?
- Which resource trade-off is hidden by the headline result?

## Common weakest assumptions
- Hardware representativeness.
- Workload stability.
- Bottleneck does not simply move elsewhere.

## Minimal reproduction
Run a fixed-hardware latency, throughput, or cost simulation with controlled workload.

## Strong counterexample
A different hardware or workload regime where the bottleneck reappears or moves to a worse component.

## Suitable learning artifacts
Cost simulator, latency model, throughput calculator, or deployment diagram.

## Do not force
Do not require model-quality metrics unless the system claims quality changes.
