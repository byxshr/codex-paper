# P1-2a Implementation Plan

## Status

- Development: complete
- Delivery: not pushed
- Parent P1-2: in progress
- Next item: P1-2b
- Scope date: 2026-07-30

## Objective

Establish a deterministic compatibility baseline, a read-only library Doctor, and a verified paper-scoped backup/restore format before any migration writes are reintroduced.

P1-2a does not migrate a package, replace an existing paper, repair the index, or rewrite a sealed generation.

## Implemented changes

### Compatibility goldens

`benchmarks/fixtures/pdf/compatibility/` contains five original MIT synthetic fixtures:

1. legacy v1 flat package;
2. package 2.0 flat package;
3. package 2.1 flat package;
4. Manifest 1.0 with Identity 1.0 managed generation;
5. Manifest 2.0 with Identity 2.0 managed generation.

`benchmarks/fixtures/generate-compatibility-fixtures.mjs --check` regenerates the complete corpus in a temporary directory and compares every byte. The root manifest records licensing, generator command, file size, SHA-256, and snapshot hash.

Tests call production package, Identity, and Manifest readers. They compare structure, content hashes, modes, and mtimes before and after reads.

### Inventory and Doctor

`library-inventory` and `library-doctor` use one tolerant scan engine. It inventories legacy packages, managed papers and every generation, overlays, workspaces, backups, and restore transactions. A corrupt item emits a bounded diagnostic while the scan continues.

Doctor checks package compatibility, Manifest/Identity validity, current/record resolution, overlay shape, index projection, crash residues, and concurrent scan drift. Index comparison is authority-scoped: successfully projected records are always checked even when another record is broken, while a failed source receives `LIBRARY_INDEX_DRIFT_UNDETERMINED` only when it maps to an identifiable paper authority. Output paths are POSIX library-relative paths with a readable bounded prefix plus hash for hostile or long identifiers. Doctor does not create directories or acquire filesystem locks. Reports include `payloadsVerified`; `library-doctor` is the authoritative full-payload check, while `library-inventory` and migration planning are explicitly shallow.

### Backup and restore

Paper-scoped backups are stored under `.codex-paper/backups-v1/<backupId>/`. The ID binds target identity, related index projection, and snapshot hash. Safe duplicate creation reuses an already verified backup.

Backup uses shared cross-process locks, no-follow reads, bounded streaming, private same-filesystem staging, file and directory fsync, and atomic rename. The manifest preserves root and nested directory modes plus empty directories, so a restored managed generation remains sealed. A second source inventory after copying detects additions, removals, mode changes, and content changes during the snapshot. A corrupt content-addressed backup is retained under a private quarantine name and recreated. Failed or rename-race `.init-*` cleanup first normalizes the private tree's permissions, so sealed payload modes cannot strand initialization residue; quarantine retention remains deliberate.

Restore verifies the complete backup before use. It restores through `.codex-paper/restore-staging-v1/` and journals progress in `.codex-paper/restore-transactions-v1/`. An absent target is restored; an identical target is idempotent without reverting live curated index metadata; a target with different bytes or filesystem modes is rejected. Index updates preserve the live envelope and unrelated entries. Corrupt unrelated journals are isolated and cannot block a healthy restore or recovery.

### Migration freeze

The former in-place migration implementation was removed. `migrate-package.js` imports only the read-only planner and CLI error formatter. It rejects execution unless `--dry-run` is present and never imports parser, writer, or lock modules.

The migration plan reports source versions, explicit Doctor verification depth, backup status, target contract, expected P1-2b actions, blockers, and `executionAvailable: false`. Backup status is `missing`, `verified`, `stale`, `not_found`, or `invalid`; selected absent or corrupt backups remain emittable plans with matching stable `MIGRATION_BACKUP_*` blockers rather than aborting the read-only planner. The embedded Doctor state is deliberately shallow (`payloadsVerified: false`); the selected backup is verified independently.

## Acceptance

- Compatibility fixtures reproduce byte-for-byte.
- P1-2a maintenance tests pass.
- Repository Guard mutation tests cover missing schemas, golden drift, untracked fixture content, migration capability reintroduction, and CI gate removal.
- Full fixed-runtime regression, production build, Viewer security, smoke, official plugin validation, and canonical reinstall are required before handoff.

## Rollback

The implementation changes no user paper data during tests. Code rollback removes the maintenance commands, schemas, synthetic fixtures, and CI gate. Existing backups are self-contained byte snapshots and must not be deleted automatically; an older plugin may simply ignore their private registry.

## Deferred to P1-2b

- creation and validation of a migrated generation;
- evidence aliases and compatibility projections;
- explicit replacement and rollback;
- Doctor-driven repair and reindex;
- migration publication and recovery semantics.
