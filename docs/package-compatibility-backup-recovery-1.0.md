# Package Compatibility, Backup, and Recovery 1.0

## Authority boundaries

- Package, Identity, and Manifest readers determine compatibility.
- Doctor is an observation report, not an authority and not a repair engine.
- `backup.json` is authoritative for one backup payload.
- A restore journal records transaction progress but does not supersede the backup or the live paper authority.
- Migration Plan 1.0 is advisory and cannot authorize writes.

## Compatibility matrix

| Input | Mode | Write behavior |
|---|---|---|
| legacy v1 flat package | `legacy_v1` | read only |
| package 2.0 | `compatible_2_0` | read only |
| package 2.1 | `native_2_1` | read only for Doctor |
| Manifest/Identity 1.0 | `compatible_1_0` | zero write |
| Manifest/Identity 2.0 | native | zero write |
| unknown or corrupt version | unsupported/invalid | fail closed |

Compatibility reads never update versions, mtimes, hashes, current records, or index entries.

## Doctor Report 1.0

Doctor status is `healthy`, `warnings`, or `errors`. A warning does not change the CLI exit from `0`; an error returns `1`.

`inventoryHash` covers the stable intrinsic report and excludes `generatedAt`. The intrinsic payload
includes `payloadsVerified`, so a shallow inventory and a full Doctor report cannot present different
verification depth under an ambiguous hash. `library-inventory` and migration planning set it to
`false`; `library-doctor` sets it to `true` and is the authoritative full-payload health check.
Diagnostics contain stable codes, severity, bounded messages, and optional library-relative paths.
Absolute paths, file content, environment values, and credentials are forbidden.

Doctor does not create `.codex-paper`, acquire a persistent lock, modify a file, or invoke `reindex`. It fingerprints relevant registries before and after the scan. A change produces `LIBRARY_SCAN_UNSTABLE`.
Index drift is checked independently for every successfully projected authority. One corrupt sibling
cannot suppress drift findings for healthy papers; a failed source receives
`LIBRARY_INDEX_DRIFT_UNDETERMINED` only when it maps to an identifiable paper authority.

## Backup Manifest 1.0

The backup layout is:

```text
.codex-paper/backups-v1/<backupId>/
├── backup.json
└── payload/
```

`backupId` is derived from the target descriptor, saved index projection, and payload snapshot hash. `backup.json` records the root mode, every nested directory and mode, every relative file path, SHA-256, byte count, mode, total bytes, index shape and entries, creation time, and intrinsic integrity hash. Empty directories are part of the snapshot, and a restored sealed generation retains its read-only directory modes.

Limits are 20,000 files, depth 20, 512 MiB per file, and 16 GiB total. Symlinks and special files are rejected. Paths must be relative, segmented, and contained by the selected legacy or managed paper root.

A managed snapshot covers the complete paper record, including all generations, paper/current records, overlay, and the matching index entry. A legacy snapshot covers the complete flat package and matching index entry.

If the content-addressed destination exists but fails full verification, it is renamed to a private
`.invalid-*` quarantine entry and the snapshot is recreated. No corrupt bytes are automatically
deleted. `library-inventory` performs manifest-level backup inventory; `library-doctor` and
`backup-verify` perform full payload hashing. Private `.init-*` cleanup uses a bounded no-follow
permission-normalizing walk so a partially copied sealed `0500/0400` tree can be removed. Quarantined
bytes remain until an explicit future retention policy removes them.

## Restore Transaction 1.0

Restore states are:

- `prepared`
- `target_restored`
- `index_committed`
- `failed`

The implementation currently writes the first three states; invalid or explicitly failed records remain diagnosable. Staging is private under `.codex-paper/restore-staging-v1/`, never under `papers/` or the managed record registry.

Restore behavior:

- absent target: restore and then commit the target index projection;
- byte-identical target: idempotent success without reverting an existing live index entry; a missing
  entry is repaired;
- target with different bytes or filesystem modes: `BACKUP_RESTORE_CONFLICT`;
- route owned by another paper: `BACKUP_RESTORE_CONFLICT`;
- index write failure after rename: move the target back to private staging;
- interruption: retry the command or use `backup-recover`.

Restore uses the live index shape and preserves an object envelope and unrelated top-level metadata.
Journal lookup is deterministic per backup; an unrelated malformed journal is returned as one failed
recovery item and cannot disable other restores.

There is no overwrite, purge, external-target, whole-library, compression, or encryption option.

## Migration Plan 1.0

Migration dry-run reports current layout and versions, Manifest verification, current snapshot hash, backup freshness, target 2.1/Identity 2.0/Manifest 2.0 contract, expected actions, and blockers.

`backup.status` is one of:

- `missing`: no backup was selected;
- `verified`: the selected backup is valid and matches the current target snapshot;
- `stale`: the selected backup is valid but targets another paper state;
- `not_found`: the selected syntactically valid backup ID does not exist;
- `invalid`: the selected backup failed schema, binding, or integrity verification.

The embedded Doctor summary is intentionally shallow and always records `payloadsVerified: false`.
The selected backup is verified independently; use `library-doctor` for a full-library payload
integrity check.

Every plan contains:

```json
{
  "executionAvailable": false,
  "diagnostics": [
    {
      "code": "MIGRATION_EXECUTION_DEFERRED"
    }
  ]
}
```

P1-2b must require a verified non-stale backup and create a new generation. It must not reinterpret this plan as permission to modify a sealed generation in place.

## Exit codes

- `0`: completed check or operation; Doctor warnings are allowed.
- `1`: integrity failure, Doctor errors, or operation failure.
- `2`: invalid arguments, policy/schema error, or frozen migration execution.
- `3`: lock conflict, restore conflict, or recoverable transaction state.
