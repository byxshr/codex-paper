# P0-C1a Implementation Record

## Scope

P0-C1a freezes paper/source/generation identity and adds collision-safe preflight to the existing flat layout. It intentionally does not implement the P0-C1b layout/resolver/overlay or the P0-C2 locking/publication/manifest work.

## Implemented changes

1. Added strict Paper Identity `1.0.0` schema and `.codex-paper/paper-identity.json` authority.
2. Added exact URL/front-matter DOI/arXiv discovery, normalization, aliasing, conflict fallback, and stable diagnostics.
3. Added the versioned generation contract, canonical JSON hashing, per-file contract hashes, and provenance separation.
4. Moved prepare identity/fingerprint resolution ahead of target/index writes; added exclusive/no-follow creation and read-only identical-generation reuse.
5. Added fail-closed handling for source/generation/paper identity collisions, legacy/partial targets, unsafe registry records, duplicate identity, and stale index projections.
6. Added identity projection validation to reasoning/study validation without changing legacy packages or Validation Report intrinsic semantics.
7. Updated study/summary workflows to pass explicit workflow and language, and added `identity-test`, Repository Guard mutations, and a pre-validation CI gate.

## Acceptance and rollback

Acceptance requires unit/integration tests, the mandatory benchmark, full repository regression, official plugin validation/reinstall, and an Attention sample copied to an isolated temporary library with the original tree unchanged.

Local acceptance completed on 2026-07-21: identity 15/15 in the PyMuPDF-backed acceptance environment, Repository Guard 54/54, repository/security 117/117, study/unit 74/74, PDF security 12/12, Validation 21/21, mandatory 2/2, external parser 5/5, reasoning/package 12/12, production build, Viewer HTTP security, smoke, and official plugin validation all passed. The root `identity-test` command ensures PyMuPDF before running the 7 prepare integration cases; invoking those tests directly without `fitz` is not a supported full-acceptance environment. Attention produced `paperId=arxiv:1706.03762`; its original tree hashes and mtimes were unchanged. The active plugin was reinstalled as `2.0.0+codex.20260721075804`.

Two independent review rounds are complete. Round 1 approved with documentation notes and found no blocking correctness or security defect; round 2 verified every disposition and returned unconditional `Approve` with no further C1a action. Stage commit `f947502` was pushed, and [CI run 29815722103](https://github.com/byxshr/codex-paper/actions/runs/29815722103) passed Repository Contract, unit, PDF ingestion, Docker sandbox conformance, Paper Identity 1.0, Validation Report 1.0, all benchmarks, production build, Viewer security, and smoke gates.

Rollback is a normal Git revert of P0-C1a files. Newly created identity-aware flat packages remain protected data and must not be silently adopted by an older writer; operators should retain them until a compatible writer or P0-C1b migration path is available.

## Residual risks

- The flat layout cannot represent more than one generation for a source.
- In paper-only mode, a trusted input URL can strengthen `paperId` without changing `generationId`. If the PDF itself has no trusted canonical marker, preparing identical bytes first from a local path and later from an exact DOI/arXiv URL (or the reverse) can therefore resolve to different paper identities. C1a deliberately rejects that mismatch instead of rewriting the first record; C1b must define an explicit alias/reconciliation policy.
- Exclusive individual writes are not a multi-file transaction; crash recovery and cross-process locks remain P0-C2.
- Canonical extraction deliberately favors false negatives over false grouping and does not scan references or later pages.
- The transitional registry scan is O(N) in the number of identity-aware flat packages. C1b's authoritative resolver/index must replace this scaling boundary without weakening validation.
- Runtime dependency inputs beyond the currently enumerated content contract remain P1-3a input to the P0-C2 manifest freeze.
