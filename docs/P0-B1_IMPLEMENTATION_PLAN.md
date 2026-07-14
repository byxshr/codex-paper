# P0-B1 Implementation Plan: Non-skippable Deterministic Regression

## Objective

Close the Sprint 0 quality-gate gap by adding redistributable synthetic PDFs that must pass through the bounded production prepare pipeline and fixed authoring validators on every pull request.

P0-B1 freezes current Attention-style defects as expected findings. It does not change extraction behavior, the frozen 2.0 schemas, ResultClaim 2.1, or Validation Report 1.0.

## Implementation

1. Generate two byte-reproducible one-page PDFs for front-matter noise and conflicting numerical results.
2. Attach SPDX, copyright, SHA-256, generator, and redistributability manifests.
3. Run each fixture in an isolated temporary paper library through `preparePaper`, which uses the P0-A4 bounded parser supervisor.
4. Apply a fixed, model-free authoring boundary with evidence selectors that must resolve uniquely.
5. Run study-package validation and strict reasoning validation.
6. Require both current invariants and the complete expected-defect contract; treat an unexpected fix as XPASS/contract drift.
7. Run the mandatory suite before the separately reported optional external corpus in CI.

## Acceptance

- `declared=2`, `executed=2`, `completed=2`, `passed=2`, `failed=0`.
- Empty manifests, missing PDFs, invalid hashes, partial execution, validator failures, and missing expected findings fail closed.
- The committed PDFs reproduce byte-for-byte from the standard-library generator.
- The real Attention package remains local, read-only, and outside the repository.

## Rollback

Revert the P0-B1 fixture, benchmark, Guard, CI, and documentation changes together. Do not retain a CI command that points to absent fixtures, and do not weaken the mandatory gate to optional skipping as a rollback shortcut.

## Implementation Result

- Local implementation status: completed on 2026-07-13.
- Delivery status: not pushed.
- Mandatory result: 2/2 executed and passed; all ten frozen expected findings observed.
- P0-B2/B3 product behavior remains unchanged.
