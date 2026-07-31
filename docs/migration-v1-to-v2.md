# Migrating Legacy Packages

Migration never rewrites an old package or sealed generation. P1-2b creates a new reviewable generation workspace, then performs a separate explicit commit after complete standard validation.

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

Migration Plan 1.1 records the source compatibility, Identity and Manifest versions, Doctor blockers and verification depth, backup freshness, target Generation Contract, stable `planId`, policy hash, and executable status. Backup state distinguishes `missing`, `verified`, `stale`, `not_found`, and `invalid`; a complete native 2.1 / Identity 2.0 / Manifest 2.0 generation returns `not_required`. Migration Plan 1.0 remains read-only compatible.

The deprecated `migrate` command still rejects every write mode. It is only a planner alias.

## Create and review a migration workspace

```bash
bash scripts/codex-paper.sh migration-start {paper-ref} --backup-id {backup-id} --json
bash scripts/codex-paper.sh migration-inspect {migration-id-or-workspace} --json
```

Start rechecks the backup, Doctor result, source snapshot, authority, and pinned content runtime. It reparses the original PDF and creates a private current-contract workspace. It never changes the source, current record, or index. Only one active migration is allowed per paper. If an interrupted start leaves an unregistered workspace, retry reports its exact workspace ID; inspect and explicitly abandon that workspace before starting again.

The workspace contains an Evidence Alias Map. Readers resolve direct current-ledger IDs first, then validated aliases, then frozen 2.0 fact projections. Referenced migrated JSON must reach 100% unique alias coverage. Old validation, manifest, identity, and execution reports are not copied. Migrated `code/**` files are limited to 1 MiB each; other approved authoring files are limited to 16 MiB.

Complete any required authoring with `workspace-write --actor codex`, run reasoning validation, create the visible package, and run the complete standard validator. Do not publish an unvalidated workspace.

## Commit

```bash
bash scripts/codex-paper.sh migration-commit {migration-id-or-workspace} --json
```

Commit rechecks the backup, source snapshot, alias coverage, runtime, provenance DAG, Validation Report, and index CAS. Managed sources gain a new immutable generation. Legacy flat sources are moved into a private migration archive while a complete managed authority is committed. `current.json` remains the visibility boundary. Index replacement is target scoped, so unrelated damaged library entries cannot block the selected authority transition.

Interrupted transactions are resumed explicitly:

```bash
bash scripts/codex-paper.sh migration-recover --json
```

## Roll back or roll forward

```bash
bash scripts/codex-paper.sh migration-rollback {migration-id} \
  --expected-current-manifest-hash {sha256} --json
bash scripts/codex-paper.sh migration-rollforward {migration-id} --json
```

The manifest hash is a compare-and-swap guard. Managed rollback switches to the exact previous current binding. Legacy rollback verifies and restores the original flat bytes and modes, while privately retaining the managed target for roll-forward. A changed current, source/archive drift, route collision, or damaged manifest fails closed.

## Repair the index projection

```bash
bash scripts/codex-paper.sh reindex --dry-run --paper {paper-ref} --json
bash scripts/codex-paper.sh reindex --paper {paper-ref} --json
```

Apply recomputes authority under lock and preserves every unrelated entry and the live index envelope. It never guesses through damaged record/current/manifest authority.

Legacy validation remains explicitly read-only:

```bash
node plugins/codex-paper/skills/study/scripts/validate-study-package.js {paper-ref} --legacy-ok
```
