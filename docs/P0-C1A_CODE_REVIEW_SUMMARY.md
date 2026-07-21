# P0-C1a Code Review Handoff

## Review objective

Confirm that P0-C1a creates a deterministic identity boundary before any flat-layout write, permits only verifiably identical read-only reuse, and rejects every ambiguous or unsafe collision without expanding into C1b/C2.

## High-value review areas

- `paper-identity.js`: canonical candidate trust boundary, conflict fallback, canonical serialization, trusted-file hashing, and provenance exclusion.
- `prepare-paper.js`: ordering of preflight versus writes, registry scan safety, reuse completeness, projection/index checks, and absence of overwrite fallback.
- `validation-report.js`: valid identity verification and unchanged legacy behavior.
- schema/manifest: strictness, version separation, and completeness of content-affecting inputs.
- failure paths: target/index immutability for legacy, partial, symlink, duplicate, source, generation, paper-ID, and stale-index conflicts.

## Intended invariants

- `sourceRevisionId` always derives from exact PDF bytes.
- `generationId` changes for content-affecting inputs but not cachebuster, time, path, PID, or platform provenance.
- Canonical conflicts never group a paper; they fall back to source identity with `CANONICAL_ID_CONFLICT`.
- `action: reused` performs no writes and preserves every file hash and mtime.
- New managed files are exclusive/no-follow; no `--force` or overwrite fallback exists.
- Old packages without identity keep existing compatibility behavior and receive no identity warning merely because they were read.

## Out of scope

Physical multi-generation layout, authoritative current resolver, mutable overlays, legacy adoption/migration, cross-process locks, transactional generation workspaces, atomic publication, index rebuild/recovery, and Viewer identity UI.

## Verification record

- Paper Identity/collision tests: 15/15 in the acceptance environment with PyMuPDF installed (8 pure identity tests and 7 prepare integration tests). `bash scripts/codex-paper.sh identity-test` enforces this prerequisite. A direct `node --test` run in a bare environment without `fitz` stops the 5 parser-reaching prepare cases before their identity assertions; that is an environment failure, not a skipped or passing identity check.
- Repository Guard mutations: 54/54; combined repository/security suite: 117/117.
- Study/unit: 74/74; PDF ingestion: 12/12; Validation Report: 21/21.
- Mandatory benchmark: 2/2; external parser: 5/5; reasoning/package: 12/12 each.
- Production build, Viewer HTTP security, smoke, official plugin validator, reinstall, and active-path/version check passed.
- Attention copy-to-temp acceptance returned `paperId=arxiv:1706.03762`; original sample hashes and mtimes were unchanged.
- Active plugin: `plugins/codex-paper/`, installed cachebuster `2.0.0+codex.20260721075804`.

## Review disposition

The first independent review approved P0-C1a with notes and no blocking correctness or security finding. Its environment discrepancy was reproduced both with and without PyMuPDF, and the full configured acceptance command remains 15/15. The canonical-identity observation is now explicit in the ADR and Paper Identity contract: when identical bytes have no trusted identifier in the PDF but a later exact DOI/arXiv locator yields a different `paperId`, the C1a flat layout rejects reuse with `PAPER_IDENTITY_CONFLICT`; it never silently promotes or rewrites the first identity. P0-C1b must define any alias or reconciliation flow explicitly.

Round 2 independently verified all round-1 dispositions, the fail-closed PyMuPDF prerequisite, and unchanged C1a/C1b/C2 scope. Its verdict is unconditional `Approve`, with no further C1a review action required. Stage commit `f947502` was pushed and [CI run 29815722103](https://github.com/byxshr/codex-paper/actions/runs/29815722103) passed the complete remote workflow, closing the C1a delivery gate.

The parent P0-C1 item remains `开发中` because C1b has not started. C1a itself is reviewed, pushed, and remotely verified.
