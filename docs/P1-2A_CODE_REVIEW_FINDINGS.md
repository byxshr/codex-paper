# P1-2a Independent Code Review Findings

- Review date: 2026-07-30
- Branch: `codex/audit-optimizations-2026-07-10`
- Reviewed artifact: `docs/P1-2A_CODE_REVIEW_SUMMARY.md`, `docs/P1-2A_IMPLEMENTATION_PLAN.md`
- Reviewed implementation: `plugins/codex-paper/src/shared/library-maintenance.mjs`,
  `plugins/codex-paper/skills/study/scripts/library-maintenance-cli.js`,
  `plugins/codex-paper/skills/study/scripts/migrate-package.js`,
  the four maintenance schemas, `benchmarks/fixtures/generate-compatibility-fixtures.mjs`,
  `scripts/tests/library-maintenance.test.mjs`, and the `scripts/`/CI guard diffs.
- Method: source review plus twelve executable reproductions against temporary libraries and the
  committed goldens. Every finding marked **reproduced** was observed directly; no user library was touched.

## Verdict

The read-only surfaces (Doctor, inventory, migration planner, compatibility goldens) hold up well and
the migration freeze is real and statically guarded. The **backup/restore format is not yet ready to be
frozen as 1.0**: it cannot represent directory metadata, so restoring a managed paper silently un-seals
every published generation in it, and several failure states have no supported remediation path. Items
1–4 below should be resolved before P1-2a is handed off, because three of them require a backup manifest
schema or CLI surface change that is harder to make after the format ships.

## What I independently confirmed as correct

- **Doctor is genuinely zero-write.** On a fresh library, `inspectLibrary` left the directory tree
  byte- and entry-identical and created no directories, including no `.codex-paper/`. Invariant 1 holds.
- **Migration execution is frozen.** `migrate-package.js` imports only the planner and the error
  formatter; `check-repository.mjs:683` rejects reintroduction of parser/writer/lock/`--force`/
  `--external-path` capability; snapshot-based tests confirm zero writes on both the refusal and the
  dry-run path.
- **Repository Guard coverage activates correctly once the tree is committed.** The P1-2a tree is
  currently untracked, which makes every `trackedSet.has(...)`-gated assertion inert. I re-ran
  `checkRepository` with a synthetic tracked set containing all currently-untracked files: 0 errors both
  ways, so the guards are consistent, not merely dormant. Partial commits (e.g. manifest without
  schemas) do fire, which is the intended design.
- **Fixtures are deterministic and clone-safe.** `--check` passes, and `treeInventory`
  (`benchmarks/fixtures/generate-compatibility-fixtures.mjs:62`) records only path/sha256/bytes — not
  mode — so a fresh clone under a different umask still reproduces byte-for-byte in CI.
- **Lock ordering stays deadlock-free.** Adding `backup`/`restore` at rank 50
  (`storage-transaction.mjs:19`) preserves a total order under `normalizeLockKeys`.
- **Test accounting is consistent.** 209 + 17 (new maintenance suite) + 3 (new guard-static tests) = 229;
  `migrate-package.test.mjs` replaced 12 tests with 12, so `study` stays at 100.
- **Local runs:** maintenance suite 17/17, guard-static 82/82. The full `scripts/tests/*.test.mjs` run
  showed 206/229 here, but all 23 failures are `PROVENANCE_RUNTIME_NONCONFORMANT` — this machine has
  Node 22.16.0 and the content runtime is pinned to 22.23.1. They are not attributable to P1-2a, and the
  summary correctly scopes its claim to the fixed runtime.

## Findings

Severity is about the delivered contract, not about how hard the fix is.

### 1. Restore un-seals published generations — the manifest cannot represent directory state (high, reproduced)

`inventoryTree` (`library-maintenance.mjs:172`) records only regular files, with `mode` per file. It
records no directory entries at all. `copyInventory` (`library-maintenance.mjs:234`) therefore
recreates every directory with a hardcoded `mode: 0o700`.

Published generations are sealed by `generation-publication.mjs:302` with directories at `0o500` and
files at `0o400`. After a backup/restore round trip of a managed record:

```
sealed package dir mode:    500
restored package dir mode:  700
restored manifest file mode: 400
sealed generation writable?  true     # a new file can be created inside a sealed generation
```

The files keep `0400`, but the directory is writable again, so entries inside a sealed generation can be
created, unlinked, or replaced. Doctor does catch the resulting content change
(`GENERATION_MANIFEST_DIRTY`, verified), so this is a loss of a defense-in-depth invariant rather than
silent corruption — but it is exactly the immutability property that sealing exists to provide, and
nothing re-seals after restore.

Two related fidelity gaps from the same root cause:

- **Empty directories are dropped.** A package containing an empty `assets/` restores without it.
- **Directory modes are never preserved** even for legacy packages: a `0755` package directory comes
  back as `0700`.

This is the item most sensitive to timing: `paper-backup-manifest-1.0.schema.json` has no directory
list, so fixing it properly means changing the manifest schema — cheap now, a compatibility event after
1.0 ships. Suggested fix: add a `directories: [{path, mode}]` array to the manifest, recreate
directories from it (deepest-last chmod so traversal still works during the copy), and re-apply sealing
for managed generations after restore.

Repro: `docs`-external script; seal a copy of `managed-manifest-2-identity-2`, back it up, remove it,
restore, then stat the package directory.

### 2. Any item name that violates the report schema aborts Doctor entirely (high, reproduced)

`diagnostic()` (`library-maintenance.mjs:724`) sanitizes `message` but not `path`, and item `id` is
passed through unsanitized and unclamped. The report schema's `relativePath` pattern rejects
backslashes and (because `.` does not match a newline) any name containing `\n`; `id` is capped at 1024
chars. A violating value makes the final `assertSchema('doctor', …)` throw, so the whole report is lost:

```
$ # a stray directory named "weird\nname" or "back\slash" under papers/
THREW DOCTOR_REPORT_INVALID doctor document does not match its 1.0 schema.
```

Both names are legal on macOS and Linux. The blast radius is larger than Doctor: `buildMigrationPlan`
calls `inspectLibrary` unconditionally (`library-maintenance.mjs:1102`), so one oddly-named directory
anywhere in the library also breaks `migration-dry-run` for every healthy paper. This directly
contradicts the design goal that "a corrupt item emits a bounded diagnostic while the scan continues" —
which is tested only for corrupt JSON, not for hostile names. The same class covers a corrupt
`workspace.json` whose `workspaceId` exceeds 1024 characters (`library-maintenance.mjs:973`).

Fix: normalize at construction — sanitize and clamp `id`, and percent- or JSON-escape path segments
that cannot satisfy the schema — so the report is always emittable, and add a test with a
newline/backslash-named entry.

### 3. A corrupted stored backup permanently blocks re-backup of that paper state (high, reproduced)

`createPaperBackup` derives the backup ID from target + index projection + snapshot hash, then takes the
reuse path whenever the directory already exists (`library-maintenance.mjs:478`) — and that path calls
`verifyBackup`, which throws on a corrupt payload. Because the ID is content-addressed, retrying always
lands on the same corrupt directory:

```
retry 0 -> BLOCKED BACKUP_INTEGRITY_FAILED
retry 1 -> BLOCKED BACKUP_INTEGRITY_FAILED
```

The CLI exposes `backup-list/-inspect/-create/-verify/-restore/-recover` and no delete or prune
command, so the only remediation is a manual `rm -rf` inside `.codex-paper/backups-v1/`. Since
`migration-dry-run` requires `backup.status: "verified"`, that paper can never reach a migratable state
through the supported surface. Bit-rot, a full disk mid-copy, and finding 12 below all lead here.

Fix: on reuse-path verification failure, quarantine the corrupt entry (rename to `.invalid-<id>`) and
recreate, or add an explicit `backup-quarantine`/`backup-delete` command. The rollback section of the
plan says backups "must not be deleted automatically", so quarantine-and-recreate is the option that
respects that constraint.

### 4. One stray journal file blocks every restore and all recovery (high, reproduced)

`existingRestoreJournal` (`library-maintenance.mjs:591`) validates *every* file in
`restore-transactions-v1/`, not just the one matching the requested `backupId`, and
`validateRestoreJournal` throws. A single unrelated or truncated journal therefore disables the entire
restore subsystem:

```
restore a1 BLOCKED: RESTORE_TRANSACTION_INVALID
recover:  [{"id":"restore-000…","ok":false,"code":"RESTORE_TRANSACTION_INVALID"}]
```

`backup-recover` cannot clear it either, so invariant 9 ("restore journals support retry and explicit
recovery") does not hold for this state; manual deletion is the only exit. Note the contrast with the
publication subsystem, which has a test named *"one corrupt journal is diagnosed without blocking
healthy recovery"* — that tolerance was not carried over here.

Fix: skip-and-diagnose unparseable journals during lookup, match on `backupId` before validating, and
let `backup-recover` report them as failed items instead of aborting.

## Medium

### 5. Restore rewrites the index envelope from stale backup metadata (reproduced)

`indexWithRestoredEntry` (`library-maintenance.mjs:547`) selects the output shape from
`manifest.index.shape` — the shape recorded at *backup* time — while the production writer
`writeRebuiltIndexLocked` (`generation-publication.mjs:407`) correctly keys off the *live* index. With a
manifest recorded as `array` and a live index that has since become object-shaped, restore discards the
top-level envelope:

```
before: {"schemaVersion":"1.0.0","generatedAt":"…","papers":[{"slug":"other"…}]}
after:  [{"slug":"other"…},{"slug":"p1"…}]        # schemaVersion and generatedAt gone
```

Entries survive, so invariant 8 holds for entries, but unrelated top-level keys do not. The reverse
direction also mutates shape (`array` live index promoted to `{papers: […]}` from an empty base). Fix:
mirror `writeRebuiltIndexLocked` and branch on the live `index.shape`.

### 6. A no-op restore silently reverts curated index metadata (reproduced)

When the target is byte-identical, restore reports `alreadyPresent: true` but still rewrites the index
from the backup-time projection:

```
alreadyPresent (no-op restore): true
index after no-op restore:  [{"slug":"p","title":"P","tags":[]}]   # ["important","read"] and progress lost
```

Test `restore refuses divergent target, repairs its own index entry` asserts this repair behavior
deliberately, so the mechanism is intended — but for legacy flat papers the index is the only home for
tags and progress, so an operation documented as "idempotent" destroys user curation. Managed papers are
unaffected in practice because their tags live in the restored overlay. Fix: skip the index write when
the target was already present and its entry already matches, or state the revert in the CLI output and
docs.

### 7. An unrelated broken entry blocks the dry-run of every healthy paper (reproduced)

Doctor's drift check calls `buildLibraryIndexEntries(…, { strict: true })`
(`library-maintenance.mjs:1055`), which throws on the first unsafe registry entry. The failure is
reported against `index.json`, and `buildMigrationPlan` treats any `index.json`-scoped error as a
blocker for *every* target (`library-maintenance.mjs:1106`):

```
doctor (junk sibling): errors  [LEGACY_PACKAGE_INVALID@papers/_scratch,
                                LEGACY_INDEX_SOURCE_INVALID@index.json]
plan blockers for HEALTHY paper: [LEGACY_INDEX_SOURCE_INVALID@index.json]
```

Two problems: the diagnostic misattributes a `papers/` problem to `index.json`, and a scratch directory
next to an unrelated paper blocks that paper's migration. Fix: run the drift check non-strictly and
report per-record skips at the record's own path, reserving `index.json` blockers for genuine index
faults.

### 8. `.DS_Store` in `papers/` makes Doctor report errors (reproduced)

`buildLegacyIndexEntries` (`generation-publication.mjs:378`) explicitly tolerates `.DS_Store`,
`Thumbs.db`, `desktop.ini`, `.localized`, and `._*`. Doctor's legacy loop
(`library-maintenance.mjs:827`) does not:

```
doctor with .DS_Store in papers/: errors  [LEGACY_PACKAGE_INVALID@papers/.DS_Store]
```

`library-doctor` then exits 1. On macOS — the platform this repo targets — Finder creates that file by
merely opening the folder. Fix: reuse the same ignore list, or downgrade to a `warning` with a distinct
code.

### 9. Doctor emits duplicate, contradictory items (reproduced)

`inspectLibrary` pushes the `managed_paper` item at line 876 and only afterwards enumerates generations;
if enumeration throws, the outer `catch` (line 949) pushes a *second* item for the same paper:

```
managed_paper items: [{id: p-cccccccc…, state: 'current'}, {id: p-cccccccc…, state: 'invalid'}]
summary.managedPapers = 2   (records on disk: 1)
```

`summary.total` is inflated too. `inventoryHash` stays deterministic, so this is report correctness
rather than integrity. Fix: build the item after enumeration, or mutate the existing item's state in the
catch.

### 10. Backup lock keys are chosen before the lock and never re-asserted

`createPaperBackup` resolves the target once outside the lock to pick lock keys, re-resolves inside
(`library-maintenance.mjs:455-457`) — good — but discards the `lockHandle` (`async () => {`) and never
checks that the re-resolved `target.lockKeys` are the keys actually held. If a slug flips from
`legacy_flat` to `managed_paper` in that window, the operation proceeds holding `legacy:<slug>` + `index`
while reading a managed record that requires `registry` + `paper:<key>`. Narrow window, but the handle
is right there: `lockHandle.assertOwns(key)` for each re-resolved key, failing closed with a retryable
error, costs two lines.

### 11. Doctor cost is O(total backup bytes) on every run

`inspectLibrary` → `listBackups` (`library-maintenance.mjs:431-432`) calls `inspectBackup` *and*
`verifyBackup` for every backup, and `verifyBackup` re-inspects internally — so each manifest is parsed
and schema-validated twice and every payload byte is re-hashed on every `library-doctor`,
`library-inventory`, and `migration-dry-run`. With the documented 16 GiB per-backup ceiling this is not a
read-only "inventory" cost. Fix: default to a manifest + size/mtime precheck and gate full re-hash
behind `--verify-payloads` (or reuse the `verifyBackup` result rather than re-inspecting).

### 12. Nested payload directories are never fsynced

`copyInventory` fsyncs each copied file and then only `targetRoot` (`library-maintenance.mjs:246`);
directories created for nested paths such as `payload/.codex-paper/` are not fsynced, and neither are
nested directories in restore staging. The plan claims "file and directory fsync". After a power loss a
backup can therefore be published (the `initDirectory` rename and `backupsRoot` fsync both succeeded)
while entries inside subdirectories are missing — which lands exactly on finding 3's dead end. Fix:
fsync each directory created during the copy, deepest-first, before the publish rename.

## Low

13. **Exit codes diverge between two documented aliases of the same operation.** The same error yields
    different codes depending on entry point, and a test locks the divergence in:
    ```
    migrate-package.js  BACKUP_TARGET_INVALID -> exit 1
    library-maintenance-cli migration-dry-run -> exit 2
    ```
    `library-maintenance-cli.js:38` also reimplements an ad-hoc `exitCode()` instead of the shared
    `storageCliExitCode`, with different rules (`BACKUP_PATH_UNSAFE`/403 → 1 here, 2 there).
14. **Code-less errors are mislabeled as the freeze.** `formatCliError(error, 'MIGRATION_EXECUTION_DEFERRED')`
    (`migrate-package.js:46`) reports a genuine internal crash (e.g. a `TypeError` in the planner) to the
    user as "migration is frozen". Use a neutral fallback such as `MIGRATION_PLAN_FAILED`.
15. **Schema strictness is shallower than claimed.** `library-doctor-report-1.0`'s `items.items` has no
    `additionalProperties: false` (every other object in the four schemas does) and `compatibility` is an
    unconstrained `object`. `migration-plan-1.0`'s `diagnostics` items allow `additionalProperties: true`
    and do not require `severity`, although `doctor.blockers` does — so the merged `diagnostics` array
    has an inconsistent element contract. `check-repository.mjs:1108` only asserts root-level
    `additionalProperties === false`, so it cannot catch this.
16. **Invariant 3 in the summary is contradicted by the implementation.** The `structuralTarget` fallback
    (`library-maintenance.mjs:315-340`) accepts a managed record with no `paper.json` and no
    `current.json`; I backed one up and restored it successfully. Snapshotting a broken record before
    repair is desirable, so the fix is to correct the invariant wording (or gate the fallback), not to
    remove the capability.
17. **Restore does not bind the target directory name to the manifest identity.**
    `library-maintenance.mjs:616` takes the basename of `target.relativePath` without checking it equals
    `paperKey`/`routeSlug`. Manifest integrity is self-attesting (`integrity.value` is a hash of the
    manifest itself), so anything that can write to `backups-v1/` chooses the record directory name and
    the entire restored index projection. Write access to the library is already game over, but this is
    the one place the backup store is the trust root, and the check is one comparison.
18. **Diagnostic/state inconsistencies in the report.** `CURRENT_GENERATION_UNINVENTORIED`
    (`library-maintenance.mjs:917`) is pushed to the global list but attached to no item; a legacy package
    in `unknown_read_only` mode gets `state: 'invalid'` while all of its diagnostics are `severity:
    'warning'`, so an "invalid" item can leave overall status at `warnings`.
19. **The goldens do not exercise the maintenance engine.** Only `managed-manifest-2-identity-2` is ever
    installed into a library; `legacy-v1-flat`, `package-2.0-flat`, `package-2.1-flat`, and
    `managed-manifest-1-identity-1` reach only `classifyPackageCompatibility` /
    `readPaperIdentity` / `verifyGenerationManifest`. Doctor, backup, and restore are tested exclusively
    against hand-built `addLegacy()` fixtures. Running the Doctor/backup/restore matrix over all five
    goldens is the highest-value test addition here, and would likely have caught finding 1.
20. **Layering and duplication.** `src/shared/library-maintenance.mjs` imports
    `skills/study/scripts/paper-identity.js` and loads its schemas from `skills/study/schemas/`, inverting
    the shared→skill direction. `sanitizeCliText` (`cli-error-format.mjs:39`) is a pure alias of the
    private `sanitizeText`; export the original instead.
21. **Committed journals are never pruned,** so `restore-transactions-v1/` grows without bound;
    `recoverBackupRestores` skips `index_committed` entries but never removes them.

## Guard observation

`check-repository.mjs:687` forbids `withStorageLocks|atomicWrite|writeFile|--force|--external-path` in
`migrate-package.js` only. The write and lock capability now lives in `library-maintenance.mjs`, which
`migrate-package.js` imports, so the textual guard passes while the transitive import graph does provide
those capabilities. `buildMigrationPlan` is in fact read-only (I traced every call: `inspectLibrary`,
`inventoryTree`, `inspectBackup`, `verifyBackup`) and the snapshot tests back that up, so this is a
guard-strength note rather than a defect — but the guard promises more than it verifies.

## Suggested disposition

- Before handoff: 1, 2, 3, 4 (each changes either the frozen manifest schema or the supported CLI
  surface), plus 5 and 12 (cheap, and 12 feeds 3).
- Before P1-2b starts writing: 6, 7, 9, 10, 19.
- Opportunistic: 8, 11, 13–18, 20, 21.
- Documentation corrections needed in `docs/P1-2A_CODE_REVIEW_SUMMARY.md`: invariant 3 (finding 16),
  invariant 5's implied fidelity (finding 1), invariant 8 (finding 5), invariant 9 (finding 4), and the
  plan's "file and directory fsync" claim (finding 12).
