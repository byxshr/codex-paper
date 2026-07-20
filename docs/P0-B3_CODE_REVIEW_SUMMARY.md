# P0-B3 Code Review Handoff

## Review objective

Review the new Validation Report 1.0 implementation as the authoritative cross-artifact quality gate. The most important invariants are:

1. Standard and strict runs over identical artifacts have identical intrinsic status, findings, publishability, and report hash.
2. Only gate fields and CLI exit may differ by policy.
3. Validation writes only `.codex-paper/validation-report.json`.
4. Unknown versions, corrupt authoritative metadata, and unsafe symlink boundaries fail closed without package mutation.
5. A complete warning-only package is publishable under standard policy and blocked under strict policy.

## Main review surfaces

- Schema: `plugins/codex-paper/skills/study/schemas/validation-report-1.0.schema.json`
- Engine: `plugins/codex-paper/skills/study/scripts/validation-report.js`
- CLIs: `validate-reasoning.js` and `validate-study-package.js`
- Contract tests: `validation-report.test.mjs`
- Mandatory migration: `benchmarks/mandatory/`
- Viewer API/parser: `src/web/server/api/papers/[slug]/validation.get.ts` and `src/web/server/utils/validationReport.mjs`
- Viewer UI: `src/web/pages/papers/[slug].vue`
- Repository/CI gates: `scripts/check-repository.mjs`, repository tests, and `.github/workflows/ci.yml`

## Consistency rules to challenge

- Every facts/analysis/reasoning reference must resolve through the P0-B2 compatibility layer.
- `keyResults` must remain the deterministic projection of 2.1 ResultClaims.
- Analysis and visible metric-bound numbers must map to evidence-backed ResultClaims.
- Different values for the same compatible result context create `RESULT_VALUE_CONFLICT`.
- A conflict must be represented in reasoning uncertainty and explicitly disclosed with both values in visible material, otherwise `RESULT_CONFLICT_UNDISCLOSED` blocks.
- Front-matter contamination creates `PARSER_FRONT_MATTER_CONTAMINATION` with source locations.
- Sparse sections alone do not create parser-quality warnings.

## Compatibility and threat boundaries

Package 2.0 is validated in memory with a compatibility warning. v1 remains limited and report-free under `--legacy-ok`. Unknown versions and damaged authoritative metadata are report-free failures. No migration occurs.

Typed ResultClaim projection, metric grounding, conflict detection, and conflict-disclosure checks apply only to native 2.1 packages. Compatible 2.0 packages still receive reference, parser-quality, artifact-integrity, and other checks available under their legacy contract, plus `PACKAGE_COMPATIBILITY_LIMITED`; the validator does not invent missing ResultClaims.

The Viewer endpoint inherits P0-A1 authentication/path/no-store controls, independently parses the report, caps its response at 100 findings, and degrades missing, legacy, or corrupt files into safe diagnostics. It must not depend on a valid reasoning artifact to render quality status.

The report validates deterministic package consistency, not external scientific truth. Generated-code execution, complex table recovery, direct exported-HTML execution, identity, transactional publication, and generation-manifest integration remain outside P0-B3.

## Independent Review remediation

The first independent Review identified two material soundness defects and one missing compatibility test:

- A raw substring check allowed `41.8` to satisfy the integer-valued `41.0` side of a conflict. Disclosure now tokenizes complete numeric values and compares their numeric meaning, so `41`, `41.0`, and `41.00` are equivalent while `41.8` is distinct.
- Native 2.1 projection and result-grounding rules were incorrectly applied to compatible 2.0 packages, which have `keyResults` but no `resultClaims`. All typed ResultClaim checks are now gated on `native_2_1` plus facts schema `2.1.0`; native packages with the wrong facts version still fail schema validation.
- Regression fixtures now cover both the one-sided `41.8` disclosure attack and a legitimate result-bearing 2.0 package. The latter remains writable only for the Validation Report, produces `PACKAGE_COMPATIBILITY_LIMITED`, and is warning-only/publishable under standard policy.

All four Review findings F1–F4 were accepted: F2/F3 share one implementation fix, while F4 is closed by the new compatibility regression.

## Round-two Review disposition

The independent second pass verified all four first-round fixes with proof-of-concept and found no new soundness defect. It reconfirmed standard/strict intrinsic equality, fail-closed schema behavior for a native 2.1 package with non-2.1 facts, compatible 2.0 warning-only publication, atomic writes, symlink rejection, and Viewer degradation. The Review verdict is Approve for M1 close after remote CI.

Two non-blocking notes were evaluated:

- Thousands-separated values are not currently normalized. This is documented as a contract limitation and deferred because changing only the disclosure tokenizer would leave visible-claim and projection parsing inconsistent. No current mandatory fixture or audited metric requires this syntax.
- The corroborating-evidence metric expression already escapes dynamic metric names correctly. No code change is needed.

## Acceptance evidence

- Repository/security: `114/114`; study: `58/58`; Validation Report: `20/20`; PDF ingestion security: `12/12`.
- Mandatory deterministic regression: `2/2`; external parser: `5/5`; reasoning: `12/12`; package: `12/12`.
- Production build, Viewer HTTP security integration, smoke test, `git diff --check`, and the official plugin validator passed.
- Browser QA used an isolated temporary library and verified AuthGate pairing, session persistence after reload, the complete warning-state panel, and evidence-drawer navigation from a finding. No browser console errors were observed.
- The Attention sample was copied into a temporary library for validation. The new report exposed the 41.8/41.0 conflict and front-matter contamination, and also honestly caught residual F1 and 2/28.4 cross-artifact divergence. The source sample's hashes and mtimes were unchanged.
- The active plugin path is `plugins/codex-paper/`; the installed cachebuster version is `2.0.0+codex.20260720134033`.
- Web dependency installation still reports 34 known audit findings (4 low, 12 moderate, 14 high, 4 critical). These remain assigned to the pre-existing P1-3a dependency-governance scope rather than being silently changed in P0-B3.

Delivery remains uncommitted and unpushed until Review is complete.
