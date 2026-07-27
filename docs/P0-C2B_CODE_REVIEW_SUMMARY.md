# P0-C2b Code Review Summary

## Review objective

P0-C2b closes the publication half of the P0-C lifecycle. Review should concentrate on the authority boundary between a validated workspace and a Viewer-visible managed generation, including crash convergence, manifest integrity, and index rebuild semantics.

## Implemented contract

- Publication accepts one exact workspace only after a complete Validation Report 1.0 standard gate returns `allow_publish` with a valid intrinsic report hash.
- The package is sealed with Generation Manifest 1.0, which binds paper/source/generation identity, source SHA, generation fingerprint, validation report hash, transaction ID, and every regular package file.
- Visibility commits at `current.json`. The library index is a rebuildable projection written afterward; an index failure never rolls back an authoritative current commit.
- A bounded `publication.json` journal drives idempotent recovery across `prepared`, `generation_committed`, `current_committed`, and `index_committed` states.
- Published packages are read-only and are verified against the current-record manifest binding before shared resolvers expose them. Missing, extra, modified, symlinked, or special files fail closed.
- `reindex` rebuilds managed entries from paper/current/manifest records while preserving legacy flat papers and the existing index envelope shape.
- Publication holds the existing lock hierarchy in order: registry → paper → source → generation → workspace → index.

## Primary implementation locations

- `plugins/codex-paper/src/shared/generation-manifest.mjs`
- `plugins/codex-paper/src/shared/generation-publication.mjs`
- `plugins/codex-paper/src/shared/paper-library.mjs`
- `plugins/codex-paper/skills/study/scripts/publication-cli.js`
- `plugins/codex-paper/skills/study/schemas/generation-manifest-1.0.schema.json`
- `plugins/codex-paper/skills/study/schemas/publication-transaction-1.0.schema.json`
- `scripts/tests/generation-publication.test.mjs`
- `benchmarks/mandatory/run-fixture.mjs`

## Suggested review focus

1. Verify that `current.json`, rather than index mutation or generation rename, is the only Viewer visibility commit point.
2. Exercise each journal boundary and confirm recovery is idempotent, never guesses a workspace, and never overwrites a colliding route or generation.
3. Confirm manifest inventory and hashing are deterministic and that reader/reindex integrity checks reject drift without rewriting published data.
4. Check that legacy index entries and object-envelope metadata survive managed reindex.
5. Confirm terminal journals are retained as non-active audit records, while incomplete journals continue reserving their generation and route until recovery.
6. Confirm published package sealing does not block overlays and does not make test or retention cleanup silently destructive.

## Local verification

- Repository Guard: canonical repository passed; mutation tests `67/67`.
- Repository/security tests: `176/176`; study tests: `83/83`.
- PDF ingestion `12/12`; identity `17/17`; layout `7/7`; storage `16/16`; publication `15/15`; validation `24/24`.
- Mandatory benchmark `2/2`; external parser `5/5`; reasoning `12/12`; package `12/12`.
- Production build, Viewer HTTP security integration, smoke test, and official plugin validation passed.
- Canonical marketplace reinstall resolves active path `plugins/codex-paper/` at `2.0.0+codex.20260722121624`.
- Browser QA used a temporary published fixture: pairing, published-only library listing, paper detail, and reviewer view all worked under the strict CSP. The temporary server and library were removed.
- Local Docker remains intentionally unavailable; `sandbox-status` failed closed. Real Docker conformance remains a remote CI gate.

## Out of scope and follow-up

- P1-4 expands the minimum manifest into full provenance.
- P1-2 owns migration, doctor, backup/restore, rollback UX, and historical revision browsing.
- P1-3 owns root workspace, dependency/runtime governance, lint/typecheck/coverage, and the currently reported npm audit debt.
- P1-7 owns retained journal/workspace lifecycle and purge controls.

## First review disposition

- **Accepted C1:** manifest inventory is now globally sorted by full relative path; directory/file sibling conflicts have a direct regression.
- **Accepted C2:** new-paper staging is re-entrant after payload rename. Existing staged payload, paper record, overlay, and current record are validated or completed independently; a fault immediately after payload staging recovers successfully.
- **Accepted C3/C7:** corrupt journals are surfaced as `publicationInvalid` with a bounded diagnostic. Recovery reports the bad workspace and continues processing healthy transactions.
- **Accepted C4:** index rebuild validates manifest-file binding plus the sealed hash of consumed `meta.json`, skips corrupt entries with diagnostics, and no longer lets one damaged paper block unrelated publication or reindex.
- **Partially accepted C5:** index projection no longer re-hashes all content. Actual paper resolution still performs full inventory verification because weakening that path would violate the approved published-generation drift boundary.
- **Accepted C6:** failure diagnostics are appended to the latest persisted journal, so `current_committed` and other progressed states cannot regress.
- **Accepted C8:** a no-follow, explicitly authorized lifecycle unseal helper centralizes permission reversal. No purge API was added.
- **Accepted cleanup:** publication uses the shared `deriveManifestId`, manifest-binding builder, and overlay-state builder. Broad stable-hash consolidation is deferred to P1-3 because it crosses already frozen validation contracts; the unused `failed` state and terminal residue lifecycle remain deliberate forward-compatible/P1-7 concerns.

## Delivery state

Implementation is `Review 完成 / 未推送`. Both review rounds and the final independent re-review have passed. No C2b files have been committed or pushed yet. M2 remains open until the stage commit passes remote CI.

## Second review disposition

- **Accepted R1:** both new-paper staging and existing-record generation paths now call `sealPermissions` after the payload is known to exist, regardless of whether the current process performed the rename. Dedicated pre-seal fault points prove recovery changes `0700/0600` authoring modes to `0500/0400` before current commit.
- **Accepted R2-a:** journal entry discovery uses no-follow `lstat`; symlink and non-regular journals enter the same `publicationInvalid` diagnostic path as malformed JSON. A mixed recovery batch reports the poisoned workspace and still publishes the healthy workspace.
- **Accepted R2-b:** lifecycle unseal now requires an explicit containment root, canonicalizes both paths, rejects symlinked ancestors or final paths, checks containment, and continues to reject descendant symlinks and special files.
- Repository Guard pins both rename-window fault points and the lifecycle containment contract. Publication coverage is now `15/15`.

## Final review disposition

- The independent re-review passed after the Round-2 corrections, with no remaining blocking findings.
- C2b is ready for its stage commit and remote CI verification. M2 closes only after that remote gate passes.
