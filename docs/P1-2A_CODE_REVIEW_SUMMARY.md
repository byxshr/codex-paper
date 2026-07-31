# P1-2a Code Review Summary

## Review scope

P1-2a adds compatibility goldens, a read-only library Doctor, paper-scoped backup/restore, and migration dry-run. It intentionally removes all active in-place migration behavior.

Primary implementation:

- `plugins/codex-paper/src/shared/library-maintenance.mjs`
- `plugins/codex-paper/skills/study/scripts/library-maintenance-cli.js`
- `plugins/codex-paper/skills/study/scripts/migrate-package.js`
- four maintenance schemas under `plugins/codex-paper/skills/study/schemas/`
- `benchmarks/fixtures/generate-compatibility-fixtures.mjs`
- `benchmarks/fixtures/pdf/compatibility/`
- `scripts/tests/library-maintenance.test.mjs`

## Security and correctness invariants

1. Doctor performs no mkdir, lock acquisition, repair, or write.
2. Every reported path is library-relative; CLI formatting removes absolute paths and URL secrets.
3. Backup accepts only a library paper reference resolved to a legacy flat package or a structurally identifiable managed record; a damaged managed record may be preserved as raw safe bytes but remains ineligible for migration.
4. Source and payload trees reject symlinks and special files and enforce file/depth/byte budgets.
5. Backup snapshots preserve root and nested directory modes plus empty directories, are re-inventoried after copying, fsync every directory, and are then atomically published.
6. Restore staging is outside Viewer-visible paper registries.
7. A divergent target or cross-paper route collision fails closed; no overwrite option exists.
8. Index update preserves the live envelope and unrelated entries, does not revert curated metadata on an already-present identical target, and rolls a newly restored target back to private staging on failure. Doctor compares every successfully projected authority even when unrelated sources are damaged; failed sources with an identifiable authority are explicitly marked undetermined.
9. Restore journals support retry and explicit recovery; an unrelated corrupt journal is isolated as one failed recovery item.
10. `migrate-package.js` has no parser or writer imports and requires `--dry-run`.
11. Unknown package versions may be backed up as raw safe bytes but remain ineligible for migration.
12. Existing sealed generations and user libraries are never changed by automated tests.

## Review round 1 disposition

The first independent review found four format/recovery blockers and several consistency issues. The
following were accepted and fixed:

- Backup Manifest 1.0 now records `rootMode` and a sorted `directories` inventory. Restore preserves
  empty directories and sealed `0500` generation directories; nested directories are fsynced.
- Hostile filesystem names are converted to stable bounded report identifiers/paths, Finder metadata is
  ignored, and one malformed record can no longer invalidate the whole Doctor schema.
- A corrupt content-addressed backup is atomically quarantined and recreated. The corrupt bytes are
  retained for inspection rather than deleted.
- Restore lookup reads only the deterministic journal for the requested backup; recovery reports other
  corrupt journals independently.
- Restore follows the live index envelope and an identical-target no-op preserves current curated
  metadata. Unrelated invalid records no longer become target migration blockers.
- Re-resolved backup lock keys are asserted against the held handle; target path and declared identity
  are bound; CLI aliases share one exit-code policy and neutral internal-failure fallback.
- Doctor item schemas and Migration Plan diagnostics are strict, duplicate managed-paper items were
  removed, current-generation diagnostics are attached to their paper item, and all five compatibility
  goldens now traverse Doctor/backup/verify/restore.

The review's proposal to make Doctor skip payload verification was only partially adopted: the lightweight
`library-inventory` and migration planner skip full hashing of unrelated backups, while
`library-doctor` continues to verify every payload because integrity checking is part of its contract.
Automatic pruning of committed journals remains deferred to P1-7 retention policy. Moving Identity
schema code out of the study layer remains a P1-3b module-boundary refactor; no correctness behavior
depends on that layout.

## Review round 2 disposition

The second independent review confirmed every round-1 fix and identified one Doctor fail-open plus
several follow-on consistency issues. All nine suggestions were accepted:

- Index drift is now compared per successfully projected authority. A broken sibling produces
  `LIBRARY_INDEX_DRIFT_UNDETERMINED` for itself but cannot suppress a target paper's
  `LIBRARY_INDEX_DRIFT` or migration blocker.
- Production cleanup makes private sealed `.init-*` trees writable before removal; quarantined corrupt
  bytes remain retained by policy.
- Migration blocker matching uses the same bounded report path as Doctor. Long legal identifiers retain
  a readable prefix plus a stable hash.
- Doctor Report 1.0 and embedded migration Doctor state expose `payloadsVerified`; the flag is part of
  `inventoryHash`.
- Shared CLI exit mapping reserves `3` for locks, workspace state, and the explicit
  `BACKUP_RESTORE_CONFLICT`; permanent identity, route, and recovery failures remain operation failures.
- Missing or corrupt selected backups produce an emittable dry-run with stable
  `MIGRATION_BACKUP_NOT_FOUND` or `MIGRATION_BACKUP_INVALID` blockers.
- Managed and legacy index projection share a tolerant default; publication rebuild explicitly
  preserves its prior managed-tolerant and legacy-strict policy.
- Restore re-reads its deterministic journal after acquiring the complete restore lock.

Repository Guard mutation coverage freezes these boundaries.

## Review round 3 disposition

The third independent review found no blocking issue and marked P1-2a ready for handoff. Its
pre-freeze contract recommendation and low-risk precision suggestions were accepted:

- Migration Plan 1.0 now distinguishes `not_found` and `invalid` selected backups from a merely
  `stale` snapshot; the stable blocker codes remain the operational source of remediation.
- `LIBRARY_INDEX_DRIFT_UNDETERMINED` is emitted only when the failed source maps to an actual paper
  authority. Non-authority junk remains an error but no longer claims that a paper projection is
  unknowable.
- Restore conflicts explicitly describe divergence in bytes or filesystem modes.
- Backup fault injection uses one helper, private sealed-staging cleanup documents its 0700 registry
  and lock assumption, and a lost final-rename race reports `reused: true`.

`doctor.payloadsVerified: false` in every migration plan remains intentional: planning performs a
shallow whole-library scan, while the selected backup is verified separately and
`library-doctor` remains the full-payload health command.

## Compatibility evidence

The five synthetic goldens cover:

- legacy v1;
- package 2.0;
- package 2.1;
- Manifest 1.0 / Identity 1.0;
- Manifest 2.0 / Identity 2.0.

The generator is deterministic and all fixture bytes, licensing metadata, and hashes are guarded. Tests verify production reader modes, native Manifest 2.0 DAG/validation/identity binding, unknown/corrupt fail-closed behavior, and hash/mtime zero-write behavior.

## Focus areas for independent review

- filesystem race handling during backup and restore;
- lock ordering and collision behavior;
- restore journal transitions and retry semantics;
- index projection replacement without unrelated entry loss;
- Doctor tolerance and unstable scan detection;
- schema strictness and diagnostic redaction;
- absence of hidden migration write paths;
- fixture coverage of the production compatibility readers.

## Validation status

- P1-2a maintenance suite: 29/29 passing.
- Compatibility generator byte check: passing.
- Repository Guard static suite: 84/84 passing.
- Full fixed-runtime regression: repository/security 243/243, study 100/100, PDF security
  12/12, mandatory 2/2, external parser 5/5, reasoning 12/12, package 12/12,
  all lifecycle gates, production build, Viewer security, and smoke passing.
- Official plugin validation and canonical marketplace reinstall: passing; active version
  `2.0.0+codex.20260731040626`.

No files are staged, committed, or pushed as part of this implementation turn.
