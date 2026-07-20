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
  -> study validator
  -> strict reasoning validator
```

The runner cannot call the parser worker or in-process parser directly. Each fixture receives a separate temporary `PAPERS_DIR`, and no user paper library is read or written.

## Golden Semantics

Each golden file has three independent sections:

- `requiredAssertions` are stable invariants that must pass now and after future extraction changes.
- `expectedFindings` are known current defects. Every listed code must be observed; disappearance is an XPASS that requires the owning phase to update the contract deliberately.
- `requiredAssertions.resultClaims2_1` is the active P0-B2 contract for typed results, excluded values, projections, and direct evidence.
- `reservedTargets.validationReport1_0` defines the evidence-supported P0-B3 destination without pretending that report exists yet.

Expected findings are named codes implemented by the benchmark. Gold files cannot inject scripts, expressions, or JSONPath.

## Exit and Reporting Contract

`benchmark-mandatory` returns:

- `0` only when every declared fixture was executed, completed, validated, and passed its expected-finding contract;
- `1` for a regression, parser failure, validator failure, or XPASS/contract drift;
- `2` for invalid or empty configuration, missing fixtures, or license/hash/generator failures.

The report at `/tmp/codex-paper-mandatory-benchmark.json` contains stable check results and finding codes. It omits source text dumps, user paths, and temporary absolute paths.

“Deterministic” applies to the committed PDF bytes, the bounded execution route, and the stable semantic assertions/finding codes. Temporary generated artifacts may contain wall-clock `generatedAt` values and are therefore not required to be byte-identical between runs; those dynamic fields are excluded from comparisons and finding detection.

The optional external corpus retains its separate allow-missing behavior and report. Its result cannot substitute for or override the mandatory suite.

## Migration State

P0-B2 migrated the year/noise/value-selection findings to positive typed ResultClaim assertions. The only remaining expected findings are parser-level front-matter contamination and the missing result-conflict warning. P0-B3 must replace those with Validation Report 1.0 assertions; removing them without the replacement report assertion is a contract regression.
