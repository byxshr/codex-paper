# Deterministic PDF Regression Contract

P0-B1 provides the repository-owned, non-skippable acceptance boundary for the PDF-to-study-package chain.

## Trust and Fixture Policy

- Mandatory PDFs live only under `benchmarks/fixtures/pdf/`.
- Each PDF has an adjacent manifest containing its origin, SPDX identifier, copyright, license, redistributability, SHA-256, and generator.
- The current fixtures are original synthetic works licensed under MIT.
- `generate-pdf-fixtures.py --check` regenerates them in a private temporary directory and requires byte-for-byte equality.
- Local Attention PDFs, images, tables, and long extracts are not redistributable and never enter this suite.

## Execution Boundary

The mandatory route is fixed:

```text
committed PDF
  -> preparePaper
  -> bounded P0-A4 parser supervisor
  -> evidence/facts/analysis package
  -> fixed model-free authoring boundary
  -> reasoning draft validator
  -> strict complete validator
  -> standard complete validator
```

The runner cannot call the parser worker or in-process parser directly. Each fixture receives a separate temporary `PAPERS_DIR`, and no user paper library is read or written.

## Golden Semantics

Each golden file has active required assertions:

- `requiredAssertions` are stable invariants that must pass now and after future extraction changes.
- `requiredAssertions.resultClaims2_1` is the active P0-B2 contract for typed results, excluded values, projections, and direct evidence.
- `requiredAssertions.validationReport1_0` is the active P0-B3 contract for three-state health, standard/strict gate behavior, structured parser/conflict findings, and stable intrinsic report identity.

Gold files cannot inject scripts, expressions, or JSONPath. P0-B1's expected-defect contract is fully migrated: no reserved target or expected finding remains.

## Exit and Reporting Contract

`benchmark-mandatory` returns:

- `0` only when every declared fixture was executed, completed, validated, and passed its expected-finding contract;
- `1` for a regression, parser failure, validator failure, missing required finding, or intrinsic strict/standard drift;
- `2` for invalid or empty configuration, missing fixtures, or license/hash/generator failures.

The report at `/tmp/codex-paper-mandatory-benchmark.json` contains stable check results and finding codes. It omits source text dumps, user paths, and temporary absolute paths.

“Deterministic” applies to the committed PDF bytes, the bounded execution route, and the stable semantic assertions/finding codes. Temporary generated artifacts may contain wall-clock `generatedAt` values and are therefore not required to be byte-identical between runs; those dynamic fields are excluded from comparisons and finding detection.

The optional external corpus retains its separate allow-missing behavior and report. Its result cannot substitute for or override the mandatory suite.

## Active contracts

P0-B2 migrated extraction defects to the active `resultClaims2_1` assertions. P0-B3 migrated parser-contamination and result-conflict defects to active `validationReport1_0` assertions. The mandatory report therefore exposes both IDs in `activeContractIds` and an empty `reservedTargetIds`.
