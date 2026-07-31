# P0-C1b Code Review Result — Round 2

Reviewer: automated code review (Claude)
Date: 2026-07-21
Branch: `codex/audit-optimizations-2026-07-10`
Scope: re-review of the two round-1 findings (B1, H1) and the accompanying changes recorded in `docs/P0-C1B_CODE_REVIEW_SUMMARY.md`.

## Verdict

**Approve.** Both round-1 findings are fixed correctly, each with a targeted regression test that genuinely exercises the previously-broken path. The remaining nits were either resolved or given a documented, defensible rationale. No new defect introduced. C1b is merge-ready pending CI in a PyMuPDF-equipped environment; parent P0-C1 may proceed to `Review 完成` once CI confirms the parser-dependent suites.

## Round-1 findings — disposition

### B1 (blocking-ish) — RESOLVED ✓

`prepare-paper.js:361` now reads `identity.generation.fingerprint.value.slice(0, 12)` — the structured fingerprint's `.value`, not the object. The `TypeError` is gone.

- **Regression test added and verified genuine:** `prepare-paper-identity.test.mjs:117` (`prepare uses the generation fingerprint when base and source-suffixed routes both collide`) pre-creates legacy dirs at both `baseSlug` and `baseSlug-<sourceSha[:12]>`, forcing allocation into the exact third-tier branch that was broken, then asserts the route equals `baseSlug-<fingerprint.value[:12]>`. This is precisely the code path round-1 flagged as untested. Good.

### H1 (hardening) — RESOLVED ✓

`resolveExplicitPackage` (`paper-library.mjs:305-339`) now, before returning the writable `explicit_path` descriptor, checks whether the realpath'd candidate is contained in `<library>/papers`. If so it returns a `legacy_flat`, `readOnly: true` descriptor with a `legacy:<routeSlug>` lock key. The validation-vs-scaffold inconsistency is closed: explicit legacy paths are now uniformly read-only.

- **Test added and verified genuine:** `library-layout.test.mjs:97` (`explicit legacy package paths stay read-only for every mutating CLI consumer`) resolves an explicit legacy path, asserts `mode: 'legacy_flat'` / `readOnly: true`, drives all four mutating consumers (`buildAnalysisForPaperDir`, `renderMaterialsForPaper`, `scaffoldReasoningAnalysis` each throwing `LEGACY_LAYOUT_READ_ONLY`, plus `buildExecutionPlan` returning `nonconformant` with `approval: null`), and asserts a byte-for-byte `fileSnapshot` equality. This passes locally (no parser needed). Thorough — it verifies both the descriptor and actual no-write behavior end to end.

### Nits — dispositioned

- **Dead `resolveWritablePaperFile`** — removed from `librarySecurity.mjs` (grep confirms zero references). ✓
- **Equal-rank canonical tie-break** — documented inline at `paper-library.mjs:58`: "Equal-rank identities deliberately keep the first successfully pinned primary." Matches behavior. ✓
- **`.codex-paper-trash.json` on the denylist** — deliberately retained so older packages cannot expose machine tombstones; reasonable, accepted.
- **Tags rollback / missing-overlay** — intentionally unchanged; prepare guarantees the overlay exists, and broader rollback/recovery is scoped to P0-C2. Accepted.

## Verification (reproduced locally, round 2)

| Suite | Result | Notes |
| --- | --- | --- |
| `paper-identity.test.mjs` | 8/8 pass | pure unit |
| `library-layout.test.mjs` | 3/7 pass locally | tests 3, 4, 7 (parser-free) pass — including the new H1 test #4; tests 1,2,5,6 fail only on missing PyMuPDF (`fitz`), confirmed environmental, not regressions |

The B1 test and 4 other prepare-spawning cases require PyMuPDF and were not runnable here; the summary's 7/7 + 17/17 claims are credible given `scripts/codex-paper.sh` enforces `ensure_pymupdf`. The two fixes I could run without the parser (H1 test #4, reconciliation test #7) both pass.

## No regressions observed

The B1 change is a one-property access fix with no side effects. The H1 change only adds a read-only branch ahead of the pre-existing writable return; the writable `explicit_path` path is unchanged for out-of-library paths. Round-1's confirmed invariants (stable paperKey, authoritative fail-closed `current.json`, generation/overlay separation, zero-write reuse, no-follow containment, bounded audited reconciliation, atomic index write) are untouched by these edits.

## Recommendation

Approved. Both actionable findings are closed with real tests. Merge-ready pending a CI run with PyMuPDF installed to confirm the parser-dependent cases (`library-layout` 1/2/5/6 and the B1 prepare test). No further review action required for C1b.
