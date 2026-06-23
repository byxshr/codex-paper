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

## Paper-Type Semantics

The critical-analysis slots are universal, but their meaning follows the paper profile:

- Empirical, architecture, system, benchmark, and post-training papers usually express `failureConditions`, `observableFailure`, `supportCriteria`, `falsificationCriteria`, and `predictedObservation` as experiments, ablations, workload shifts, metric checks, or controlled comparisons.
- Theoretical papers may express them as proof-boundary checks, violated assumptions, counterexamples, limiting constructions, dependency-map failures, or numerical sanity checks used only to probe the theorem's regime.
- Survey papers may express them as taxonomy stability, coverage audits, omitted-work checks, classification disagreement, or inclusion/exclusion sensitivity.
- Position papers may express them as argument-map failures, decision consequences, falsifiable predictions, or concrete cases where the proposed framing recommends the wrong action.
- Other or mixed papers should use the smallest check that matches the actual modality of the central claim.

Do not invent an experiment for a non-empirical paper. Use descriptive criteria when the paper's claim is conceptual, formal, taxonomic, or normative, and cite the paper evidence that makes the criterion relevant.

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

Draft skeletons created by migration or scaffolding can be checked with:

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js "<paper-dir>" --allow-draft
```

`--allow-draft` only suppresses completed-analysis schema noise for `status: "draft"` files. It still requires valid package JSON, a readable `evidence-ledger.json`, and resolvable evidence plumbing; a missing or corrupt ledger is treated as a broken package, not a valid draft.
