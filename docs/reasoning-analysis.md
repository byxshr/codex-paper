# Codex Paper v2 Reasoning Analysis

`reasoning-analysis.json` is the internal research reasoning contract for a completed v2 package. The scaffold is deterministic, but high-level analysis must be filled by Codex after reading the evidence ledger and paper profile.

## Required Content

- `centralClaims`: one to three scoped central claims.
- `researchQuestion`: the problem and why it matters.
- `priorWorkGap`: existing approaches, the gap, and the novelty boundary.
- `authorReasoningPath`: a directed acyclic chain of observations, constraints, hypotheses, design decisions, validations, and boundaries.
- `coreIntuition` and `methodModel`: the mechanism, components, pipeline, equations, and outputs.
- `validations`: question, design, observation, conclusion, scope, and alternative explanations when applicable.
- `weakestAssumption`: the single fragile assumption most likely to break a core claim.
- `minimalReproduction`: smallest meaningful support and falsification criteria.
- `strongestCounterexample`: the strongest plausible case against a central claim.
- `followUpIdea`: a non-incremental research direction, not just more data, a larger model, or tuning.
- `uncertaintyZones`: explicit unresolved or low-confidence zones.

## Source Types

Every analysis node uses one `sourceType`:

- `paper_claim`: asserted or directly supported by the paper and backed by `ev-*`.
- `literature_fact`: external context backed by `ext-*`; forbidden in `paper-only` mode.
- `inference`: Codex analysis grounded in available evidence.
- `speculation`: research guess or forward-looking idea; never high confidence.

## Validator

`validate-reasoning.js` checks:

- JSON Schema validity.
- Evidence references and source-type rules.
- Numeric claims against cited evidence text.
- Reasoning DAG dependency validity and cycle absence.
- Critical-analysis fields for assumptions, reproduction, counterexamples, and follow-up ideas.
- Template residue and low evidence coverage.

The report is written to:

```text
{paper-dir}/.codex-paper/validation-report.json
```
