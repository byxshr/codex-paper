# P0-B1 Code Review Handoff

## Review scope

P0-B1 closes the Sprint 0 gap where the external parser corpus could be entirely absent or skipped while CI still succeeded. It adds a repository-owned, non-skippable deterministic regression from committed PDF bytes through the bounded production prepare path and both package validators.

This change intentionally does **not** fix extraction defects. It freezes the current Attention-style failures as expected findings so P0-B2 and P0-B3 must replace them deliberately with positive assertions.

Primary review areas:

- `benchmarks/fixtures/generate-pdf-fixtures.py`
- `benchmarks/fixtures/pdf/`
- `benchmarks/mandatory/`
- `benchmarks/run-mandatory-benchmark.mjs`
- `scripts/check-repository.mjs`
- `scripts/tests/mandatory-benchmark.test.mjs`
- `.github/workflows/ci.yml`

Supporting contracts:

- `docs/P0-B1_IMPLEMENTATION_PLAN.md`
- `docs/deterministic-regression-contract.md`
- `docs/contracts/s0-contract-baseline.json`

## Delivered behavior

Two original MIT-licensed, one-page PDFs are committed under the S0 fixture allowlist:

1. `front-matter-noise.pdf` contains a valid 28.4 BLEU result plus an equal-contribution footnote, conference year 2017, and copyright year 2026.
2. `result-conflict.pdf` contains 28.4 BLEU, WMT 2014 with 41.8 BLEU, and conflicting prose reporting 41.0 BLEU.

The standard-library generator fixes PDF object order, text positions, metadata and document IDs. `--check` regenerates both fixtures in a temporary directory and requires byte-for-byte equality. Adjacent manifests bind each PDF to its SPDX license, copyright, SHA-256, redistributability and canonical generator command.

The mandatory execution path is:

```text
committed PDF
  -> isolated temporary PAPERS_DIR
  -> preparePaper
  -> P0-A4 bounded parser supervisor
  -> evidence/facts/analysis artifacts
  -> fixed model-free authoring boundary
  -> study-package validator
  -> strict reasoning validator
```

The worker may not import the parser worker, enable the internal in-process parser or honor the optional external-corpus skip flag. The fixed authoring boundary resolves evidence selectors uniquely and does not execute its synthetic code file.

## Golden and expected-defect semantics

Each fixture gold has three independent sections:

- `requiredAssertions`: stable source, parser, evidence, generated-file and validator invariants.
- `expectedFindings`: current defects that must be observed exactly. A missing finding is reported as XPASS/contract drift and fails the suite.
- `reservedTargets`: evidence-supported P0-B2 ResultClaim 2.1 and P0-B3 Validation Report 1.0 destinations. Their product interfaces are not implemented in this change.

Frozen front-matter findings:

- `FRONT_MATTER_FOOTNOTE_IN_ABSTRACT`
- `FRONT_MATTER_COPYRIGHT_IN_ABSTRACT`
- `CONFERENCE_YEAR_AS_KEY_RESULT`
- `COPYRIGHT_YEAR_AS_KEY_RESULT`
- `FRONT_MATTER_NOISE_IN_ANALYSIS`

Frozen result-conflict findings:

- `DATASET_YEAR_AS_KEY_RESULT`
- `EXPECTED_RESULT_41_8_NOT_SELECTED`
- `CONFLICTING_RESULT_41_0_SELECTED`
- `CROSS_ARTIFACT_RESULT_MISMATCH_UNGATED`
- `RESULT_CONFLICT_HAS_NO_VALIDATION_WARNING`

These findings mean “the audited defect was reproduced,” not “the extracted result is correct.” P0-B2 must replace the extraction findings with typed positive assertions; P0-B3 must replace the silent mismatch/conflict findings with report assertions.

## Exit and CI contract

The public command is:

```bash
bash scripts/codex-paper.sh benchmark-mandatory
```

Exit behavior:

- `0`: every declared fixture was executed, completed, validated and matched its expected-finding contract.
- `1`: parser/prepare/validator regression, failed required assertion, unexpected finding, or XPASS/contract drift.
- `2`: empty/invalid configuration, missing fixture, or license/hash/generator failure.

The JSON report is written to `/tmp/codex-paper-mandatory-benchmark.json` and omits user paths, temporary absolute paths and full source text.

CI now runs the mandatory gate before the separately reported optional external corpus. `CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS` remains valid only for the external corpus and cannot affect mandatory execution. Repository Guard prevents empty manifests, missing/untracked references, hash or generator drift, parser-supervisor bypass and removal/reordering of the CI gate.

## Verification evidence

- Mandatory regression: `declared=2`, `executed=2`, `completed=2`, `passed=2`, `failed=0`.
- All ten expected findings were observed.
- Deterministic generator: both PDFs reproduced byte-for-byte.
- Repository/security tests: 104/104, including the metadata-only false-positive regression.
- Study tests: 23/23.
- PDF ingestion security: 12/12.
- External parser corpus: 5/5.
- Reasoning benchmark: 12/12.
- Package benchmark: 11/11.
- Production build, Viewer HTTP security integration and smoke test passed.
- Official plugin validator passed.
- Frozen 2.0 schema hashes and active plugin version `2.0.0+codex.20260713121349` are unchanged.

## Reviewer focus

- Confirm fixture bytes, manifests and generator commands are reproducible and legally complete.
- Confirm every fixture can only reach parsing through `preparePaper` and the P0-A4 supervisor.
- Check that zero/partial execution, missing references and optional-skip leakage always fail closed.
- Review the distinction between required assertions, expected defects and reserved future targets; no current defect should be mislabeled as a successful quality outcome.
- Check that the correct fixed authoring materials are evidence-grounded while the incorrect facts/analysis mismatch remains explicitly observable.
- Confirm report and failure diagnostics cannot disclose temporary or user-local absolute paths.
- Confirm P0-B2/B3 cannot remove an expected finding without introducing its positive replacement assertion.

## Review feedback resolution

The independent Review approved the implementation with one recommended correction. `FRONT_MATTER_NOISE_IN_ANALYSIS` previously searched the complete serialized analysis object, so the active `parserVersion` cachebuster and wall-clock `generatedAt` could keep the finding present after extracted content was cleaned. The detector now inspects only authored analysis content (`oneSentence`, problem/core idea, contributions, result rows, limitations and open questions). A regression test proves metadata-only `2026` values do not trigger the finding while contaminated result content still does.

The Review's determinism clarification was also adopted in the contract documentation. The duplicated manifest checks and textual CI-order check remain intentional low-risk boundaries for this phase: Repository Guard validates repository topology/tracked inputs before execution, while the mandatory runner validates runtime configuration; both retain independent mutation coverage without adding a new module-loading or YAML dependency to the Guard.

Round 2 independently re-ran the focused tests, confirmed the metadata false-positive is closed in both directions, and returned an unconditional **Approve** with no regressions. The remaining manifest-validator drift risk is tracked as a P1-3b repository-engineering follow-up rather than a P0-B1 merge condition.

## Out of scope and residual boundary

- No parser, facts, analysis or validation-report product logic was changed.
- ResultClaim 2.1, direct `ev-*` result references and compatibility projections remain P0-B2.
- Cross-artifact gating and `pass | pass_with_warnings | fail` semantics remain P0-B3.
- Advanced multi-column, header/footer and table-grid calibration remains P1-1.
- Model-in-loop evaluation remains optional nightly/manual coverage.
- Consolidating or cross-checking the Guard/runtime manifest validators remains a P1-3b repository-engineering follow-up.
- Existing npm audit findings remain assigned to P1-3a and were not modified here.

Delivery status is `Review 完成 / 已推送`. The P0-B1 stage is committed on `codex/audit-optimizations-2026-07-10`; remote CI is still required before M0 is formally closed.
