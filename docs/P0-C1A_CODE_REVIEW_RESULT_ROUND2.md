# P0-C1a Code Review Result — Round 2

Reviewer: automated code review (Claude)
Date: 2026-07-21
Branch: `codex/audit-optimizations-2026-07-10`
Scope: re-review after the round-1 notes were addressed in `docs/P0-C1A_CODE_REVIEW_SUMMARY.md`, ADR `0002`, and `scripts/codex-paper.sh`.

## Verdict

**Approve.** All three round-1 notes are resolved. No code logic changed since round 1 (the implementation diff is byte-identical), so the round-1 correctness/security verdict stands: no blocking defect. This round confirms the documentation and tooling now match reality.

## Round-1 notes — disposition

| # | Round-1 note | Round-2 status |
| --- | --- | --- |
| Verification | "15/15" claim was misleading in a bare environment | **Resolved.** Summary line 30 now states 15/15 holds *with PyMuPDF installed* (8 identity + 7 prepare), names the enforcing command, and explicitly labels the 5 bare-environment failures as environment failures, not skipped/passing checks. Accurate. |
| Obs #1 | `paperId` depends on URL but paper-only `generationId` does not; first prep pins identity | **Resolved.** ADR 0002 now has a dedicated paragraph: paper-only locator does not affect `generationId` but can affect `paperId`; first C1a prep pins identity; divergent later locator is rejected with `PAPER_IDENTITY_CONFLICT`, never silently promoted/aliased/rewritten; C1b must define reconciliation explicitly. |
| Obs #3 | O(N) registry scan cost | **Resolved.** ADR 0002 Consequences records "Registry discovery is O(N)… C1b must replace it with the authoritative resolver/index while preserving fail-closed duplicate detection." |

Obs #2 (first-two-pages front-matter scan) and #4 (coarse index cross-check) were non-blocking and remain acceptable as designed; ADR's "trusted, exact-match only" posture covers #2.

## Verification (reproduced locally, round 2)

- `paper-identity.test.mjs`: 8/8 pass.
- `validation-report.test.mjs`: 15/15 pass.
- `prepare-paper-identity.test.mjs`: 2/7 pass locally; the 5 parser-reaching cases fail only because `fitz` is absent in this sandbox — exactly as the summary now documents. Not a regression.

## Tooling claim — verified

- `bash scripts/codex-paper.sh identity-test` exists (`codex-paper.sh:155-164`) and runs both identity test files.
- It calls `ensure_pymupdf` (defined `scripts/common.sh:104-110`), which imports `fitz` and, if absent, runs `pip install pymupdf` before the tests. So the command genuinely enforces the PyMuPDF prerequisite rather than silently skipping — the summary's characterization is correct. (Minor: if the `pip install` itself fails, e.g. offline, the command errors out — fail-closed, which is the desired behavior.)

## Scope discipline

Still no leakage into C1b/C2. ADR explicitly defers alias/reconciliation and the authoritative resolver to C1b, and marks the identifiers as C2's manifest contract requiring a version bump to change semantics. Parent P0-C1 correctly remains open.

## Recommendation

Approved. Merge-ready pending CI confirmation of the parser-dependent integration tests in a PyMuPDF-equipped environment — which `scripts/codex-paper.sh identity-test` now guarantees. No further review action required for C1a.
