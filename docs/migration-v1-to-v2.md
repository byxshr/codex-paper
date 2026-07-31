# Migrating Legacy Packages

P1-2a freezes the old in-place migration implementation. Reading an old package, running Doctor, creating a backup, or building a migration plan must not rewrite the package.

## Inspect first

```bash
bash scripts/codex-paper.sh library-inventory --json
bash scripts/codex-paper.sh library-doctor --json
```

Doctor reports legacy v1, package 2.0/2.1, managed generations, workspaces, overlays, backups, restore journals, and record/current/index drift. It emits library-relative paths only. Drift is compared independently for every successfully projected authority, and failed identifiable authorities are explicit rather than suppressing other drift. `library-doctor` reports `payloadsVerified: true`; the shallow inventory and migration planner report `false`. Warnings return exit `0`; errors return exit `1`.

## Create the required backup

```bash
bash scripts/codex-paper.sh backup-create {paper-ref} --json
bash scripts/codex-paper.sh backup-verify {backup-id} --json
```

Only a one-level legacy paper in `papers/` or a complete managed paper record can be backed up. External paths, trash entries, and active workspaces are rejected. The backup is content-addressed and includes the paper bytes plus its related index projection. Unknown or semantically damaged packages may still be backed up when their filesystem structure is safe.

Restore is conservative:

```bash
bash scripts/codex-paper.sh backup-restore {backup-id} --json
bash scripts/codex-paper.sh backup-recover --json
```

An absent target is restored. A byte-and-mode-identical target is an idempotent success. A target with different bytes or filesystem modes is a conflict; P1-2a has no overwrite option. Restore uses private staging and a journal, preserves unrelated index entries, and can be retried after interruption.

## Build a read-only migration plan

```bash
bash scripts/codex-paper.sh migration-dry-run {paper-ref} --backup-id {backup-id} --json
```

The deprecated command name remains available only as an alias:

```bash
bash scripts/codex-paper.sh migrate {paper-ref} --dry-run --backup-id {backup-id} --json
```

The plan records the source compatibility, Identity and Manifest versions, Doctor blockers and verification depth, backup freshness, target Generation Contract, and expected P1-2b actions. Backup state distinguishes `missing`, `verified`, `stale`, `not_found`, and `invalid`; a selected absent or corrupt backup is represented by the matching stable `MIGRATION_BACKUP_*` blocker instead of aborting the plan. The embedded Doctor scan is intentionally shallow, while the selected backup is verified separately. The plan always returns `executionAvailable: false` with `MIGRATION_EXECUTION_DEFERRED`.

Passing no `--dry-run`, `--force`, `--external-path`, or any former write option is rejected. P1-2b will implement explicit new-generation migration, evidence aliases, reindex/drift repair, and rollback on top of the verified P1-2a backup format. Sealed generations will not be modified in place.

Legacy validation remains explicitly read-only:

```bash
node plugins/codex-paper/skills/study/scripts/validate-study-package.js {paper-ref} --legacy-ok
```
