# P1-2b Code Review Summary

## Review scope

P1-2b introduces explicit new-generation migration, Evidence Alias Map 1.0, journaled legacy authority switching, rollback/roll-forward, and target-scoped reindex repair.

Primary implementation:

- `plugins/codex-paper/src/shared/generation-migration.mjs`
- `plugins/codex-paper/src/shared/library-maintenance.mjs`
- `plugins/codex-paper/src/shared/generation-publication.mjs`
- `plugins/codex-paper/src/shared/package-compatibility.mjs`
- `plugins/codex-paper/skills/study/scripts/generation-migration-cli.js`
- four new/updated migration schemas
- `scripts/tests/generation-migration.test.mjs`

## Security and correctness invariants

1. A verified, target-matching fresh backup is mandatory unless the current generation already satisfies the complete target contract.
2. Start only creates a private workspace; it does not change record/current/index or Viewer visibility.
3. Core evidence artifacts are regenerated from the original PDF with the pinned bounded parser.
4. Copied content is restricted to existing workspace authoring paths and is written through the shared CAS/no-follow/fsync writer with provenance actor `tool`.
5. Evidence aliases are single-hop, source-hash-bound, and target only real current-ledger IDs. Referenced structured aliases require 100% coverage.
6. Commit requires workspace state `validated` and reuses the complete standard publication gate.
7. The source snapshot and backup are reverified before commit. A missing source is rejected before publication, and managed freshness excludes mutable overlay state.
8. Legacy authority switching and every current/index transition are journaled under ordered cross-process locks. Recovery converges from the `after_current_commit` and `before_index_commit` crash windows.
9. Rollback and roll-forward re-read live current/authority state under lock and finish every precondition before mutation. The caller-supplied current-manifest CAS remains effective on resumed operations.
10. Recovery uses transaction state and exact IDs, never mtime or implicit “latest” selection.
11. Targeted reindex recomputes authority under lock and preserves unrelated entries and the index envelope.
12. Unknown/corrupt versions and ambiguous authority fail closed; the read-only planner returns a blocked plan and isolates unrelated damaged records.

## Independent review remediation

The first independent review reported 18 findings. Findings 1–10, 12, and 14–18 were accepted:

- legacy commit recovery now completes the owed source archive and index steps from both publication crash windows;
- source deletion, stale live current, divergent rollback/roll-forward authority, and dual live authorities are rejected before mutation;
- managed migration now has a parseable end-to-end fixture and excludes `overlay/` from backup/source freshness;
- Doctor inventories migration transactions and retained archives, including pending counts and retained bytes;
- migration and publication CLIs use the shared exact retryability map; `*_BLOCKED` and permanent conflicts return exit 1;
- reindex dry-run exposes `applyAvailable`, blockers, final entry count, and the exact post-apply index hash;
- repeated `migration-start` for the same plan/backup returns the existing migration transaction;
- policy constants, authoring-file `lstat` checks, planner scans, typo diagnostics, counted migration tests, and Repository Guard mutations were consolidated.

Finding 11 was addressed by removing the unreachable terminal `failed` transaction state. All non-terminal authority transitions are recoverable; no unsafe abandon command was added. Finding 13 was deliberately retained because the approved P1-2b contract explicitly requires Migration Plan 1.0 read-only compatibility. It has a compatibility validator test and never enables migration writes.

## Round-two remediation

The second independent review found no blocker and re-verified every round-one fix. Its remaining isolation and compatibility findings were addressed as follows:

- migration planning now resolves the selected structural target directly, so an unrelated damaged managed record cannot relabel a healthy legacy source or change its `planId`;
- migration commit, managed switching, and legacy rollback/roll-forward use target-scoped index replacement, so unrelated invalid legacy directories cannot stall a transition after authority has moved;
- workspace-addressed transaction lookup skips corrupt/unsupported siblings, while direct reads return `MIGRATION_TRANSACTION_INVALID` or `MIGRATION_TRANSACTION_UNSUPPORTED`;
- a second active migration for the same paper is rejected; an unregistered workspace left by an interrupted start returns `MIGRATION_START_INCOMPLETE` with the exact workspace ID and abandon remediation;
- copied authoring files are never overwritten through a self-satisfying CAS; identical projected bytes are reused and divergent content fails closed;
- Doctor Report 1.1 adds migration registries while Doctor Report 1.0 remains strict, read-only compatible;
- `STORAGE_LOCK_OWNERSHIP_LOST` is explicitly retryable; corrupt/required lock policy errors remain non-retryable;
- unsafe library-root reindex plans return blockers instead of throwing, and tests use the production manifest hash function.

The migration copy budget is explicit: each `code/**` file is limited to 1 MiB; other approved authoring files are limited to 16 MiB. During the two-rename legacy authority transition, the selected route may transiently return not found, but it never has two live authorities and journal recovery converges.

## Focus areas for independent review

- Crash convergence between publication journal state and migration transaction state.
- Legacy transition ordering at `current_committed → source archived → index committed`.
- Managed and legacy rollback CAS behavior under concurrent current changes.
- Alias ambiguity, missing refs, fact projection, and tampered target-ledger behavior.
- Archive and backup tamper detection, symlink/special-file rejection, and mode fidelity.
- Target reindex isolation with damaged unrelated records and route conflicts.
- Provenance DAG inclusion of the migration source record and alias map.

## Local evidence

- Repository Guard `87/87`, repository/security `259/259`, and study `102/102`.
- Migration/maintenance `55/55`, Validation `25/25`, PDF security `12/12`, Identity `17/17`, Layout `7/7`, Storage `16/16`, Publication `15/15`, and Provenance `13/13`.
- Mandatory regression `2/2`, external parser corpus `5/5`, reasoning `12/12`, and package `12/12`.
- Runtime, dependency audit, secret scan, supply-chain review, production build, Viewer HTTP security, smoke test, and the official plugin validator passed.
- The canonical marketplace was reinstalled from `plugins/codex-paper/`; active version is `2.0.0+codex.20260731100653`.
- The local host has no Docker engine, so real Docker conformance remains a mandatory remote-CI gate for the later pushed review revision.

No files were staged, committed, or pushed as part of implementation.
