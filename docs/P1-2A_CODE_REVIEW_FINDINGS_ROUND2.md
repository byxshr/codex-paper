# P1-2a Independent Code Review Findings — Round 2

- Review date: 2026-07-31
- Branch: `codex/audit-optimizations-2026-07-10`
- Reviewed artifact: `docs/P1-2A_CODE_REVIEW_SUMMARY.md` (updated), `docs/P1-2A_IMPLEMENTATION_PLAN.md` (updated)
- Round 1 findings: `docs/P1-2A_CODE_REVIEW_FINDINGS.md`
- Method: re-ran every round-1 reproduction against the updated code, then reviewed the deltas
  (`library-maintenance.mjs`, the four schemas, `library-maintenance-cli.js`, `migrate-package.js`,
  `cli-error-format.mjs`, `generation-publication.mjs`, `storage-transaction.mjs`, guards, tests) and
  built five new reproductions. No user library was touched.

## Verdict

The round-1 fixes are real. All nine reproductions I built in round 1 now behave correctly, and I
verified each one independently rather than relying on the new tests. The backup manifest now carries
directory metadata, so the format is defensible as 1.0.

Three of the fixes, however, introduced new defects, and one of them is a **fail-open in the gate that
is supposed to guard P1-2b writes**: a single stray directory in `papers/` suppresses index-drift
detection entirely, and a paper with a drifted index entry then reports
`eligibility: ready_for_p1_2b` with zero blockers. That is finding 1 below and it should block handoff.

## Round-1 findings: independently re-verified as fixed

Each line is the round-1 reproduction re-run against the current code.

| # | Round-1 finding | Round-2 result |
|---|---|---|
| 1 | Restore un-sealed published generations | `sealed pkg 500 → restored 500`, file `400`, sealed generation **not** writable; empty `assets/` restored; legacy package directory mode `755` preserved |
| 2 | Hostile filesystem names aborted Doctor | newline- and backslash-named directories now yield `status: errors` with a bounded `encoded-<hash>` path instead of `DOCTOR_REPORT_INVALID` |
| 3 | Corrupt backup permanently blocked re-backup | first retry recreates (`reused: false`), second reuses (`reused: true`); corrupt bytes retained under `.invalid-<id>-<rand>` |
| 4 | One stray journal blocked all restores | unrelated corrupt journal no longer blocks the restore; `backup-recover` reports it as a single failed item |
| 5 | Index envelope loss | object envelope with `schemaVersion`/`generatedAt` preserved; branch now keys off the live index (`library-maintenance.mjs:623`) |
| 6 | No-op restore reverted curated metadata | `tags: ["important","read"]` and `progress` survive an already-present identical restore |
| 7 | Unrelated broken entry blocked every dry-run | junk sibling is now scoped to `papers/_scratch`; a healthy paper's plan has zero blockers (**but see finding 1**) |
| 8 | `.DS_Store` forced `errors` | library with `.DS_Store` in `papers/` reports `healthy` |
| 9 | Duplicate managed-paper items | one item, `state: 'invalid'`, `summary.managedPapers = 1` |

Also confirmed still correct: Doctor remains zero-write on a fresh library (tree and entry list
unchanged, no directories created); the two CLI aliases now agree on exit codes (`BACKUP_TARGET_INVALID`
→ 2 from both `migrate-package.js` and `library-maintenance-cli.js`); guards hold both with the tree
untracked and with a simulated fully-tracked index (0 errors either way); all five goldens now traverse
Doctor/backup/verify/restore.

Test counts I reproduced locally: maintenance **24/24**, guard-static **83/83**, migrate-package
**12/12**, full `scripts/tests/*.test.mjs` **214/237**. All 23 failures are
`PROVENANCE_RUNTIME_NONCONFORMANT` (this machine runs Node 22.16.0; the content runtime is pinned to
22.23.1) — the identical set and cause as round 1, so neither the `generation-publication.mjs` change
nor the exit-code change regressed anything.

## New findings

### 1. Index-drift detection is disabled by any unrelated broken record — a fail-open (high, reproduced)

The round-1 fix for cross-contamination replaced strict projection with per-source diagnostics, but
gated the drift comparison on there being **no** source diagnostics at all
(`library-maintenance.mjs:1221`). One junk directory anywhere in `papers/` therefore switches drift
detection off for the entire library:

```
[1] drift alone     -> [ LIBRARY_INDEX_DRIFT ]
[2] drift + sibling -> [ LEGACY_PACKAGE_INVALID@papers/_scratch,
                         LEGACY_INDEX_SOURCE_INVALID@papers/_scratch ]
    LIBRARY_INDEX_DRIFT still reported? false
    plan eligibility for the drifted paper: ready_for_p1_2b | blockers: 0
```

The paper in that run has a genuinely stale index entry (`"STALE WRONG TITLE"`, missing
`packageVersion`) and a verified backup. Round 1's problem was too many blockers; this is the opposite
and worse, because `eligibility: ready_for_p1_2b` is the signal P1-2b will consume before it starts
writing. Creating `papers/_scratch` is enough to produce it.

Fix: compute drift over the successfully-projected subset instead of skipping it. Compare only the
entries whose source projected cleanly, and emit a distinct diagnostic (e.g.
`LIBRARY_INDEX_DRIFT_UNDETERMINED`, error severity) for the slugs that could not be projected, so the
unknown region is explicit rather than silent. A regression test should assert that drift is still
reported when an unrelated sibling is broken.

### 2. Sealed payloads are not removable by the module's own cleanup paths (medium-high, reproduced)

Now that payloads faithfully reproduce `0o500` directories, an ordinary recursive delete fails on them:

```
rmSync of a backup containing 0500 dirs -> EACCES
    backup dir still present: true
    (rmdir '.../generations/gen-sha256-.../package/.codex-paper')
```

`library-maintenance.mjs` contains exactly two removals and neither chmods first:

- **line 606** — the `createPaperBackup` failure path: `try { fs.rmSync(...) } catch {}`. The EACCES is
  swallowed, leaving a `.init-` residue that Doctor reports as a warning forever and that the user
  cannot `rm -rf` either without a manual chmod walk.
- **line 600** — the lost-rename branch (`EEXIST`/`ENOTEMPTY`): `fs.rmSync(...)` is **not** guarded, so
  EACCES escapes and turns a benign race into a hard failure, still leaving the residue.

Quarantined `.invalid-*` trees inherit the same property. The new test harness needed its own
`makeWritable` walker to tear down fixtures (`scripts/tests/library-maintenance.test.mjs:60-71`, and
`chmodTree` at `:123-131` before every `fs.rmSync`) — that walker is precisely the helper production is
missing.

Fix: add one `removeTreeForcingWritable(root)` helper (chmod directories to `0o700` top-down, then
`rmSync`) and use it at both sites. Retention of quarantined bytes is a deliberate policy, but it
should be a policy, not a permission accident.

### 3. `reportPath` encoding silently empties the target-scoped blocker filter (medium, reproduced)

`reportSegment` (`library-maintenance.mjs:836`) replaces any path segment longer than 80 characters with
`encoded-<hash>`, but `target.targetRelativePath` in `buildMigrationPlan` is built by `relativePosix`
and is *not* normalized. The blocker filter compares the two directly
(`library-maintenance.mjs:1285`), so for a legacy route slug over 80 characters the comparison can never
match. Two identically-corrupted papers, differing only in slug length:

```
doctor error diagnostics:
    LIBRARY_RECORD_INVALID @ papers/encoded-6b2ec79170f50ea57b886dc81a2cf787
    LIBRARY_RECORD_INVALID @ papers/short-paper

plan(short-paper)   doctor.blockers: [ LIBRARY_RECORD_INVALID@papers/short-paper ]
plan(90-char slug)  doctor.blockers: []
```

`ROUTE_PATTERN` imposes no length limit, so a 90-character slug is a legal legacy paper. In a second run
with a verified backup, the long-slug paper reported `doctor.status: errors` alongside
`doctor.blockers: []`; `eligibility` still came out `blocked`, but only because the compatibility
classifier independently fired `PACKAGE_ARTIFACT_INVALID`. I could not construct a full fail-open for
the corruption types currently reachable on a legacy target — every one of them also trips the
classifier — so today this is a latent fail-open plus an internally inconsistent report. It becomes a
live one as P1-2b adds target-scoped Doctor error classes that the classifier does not duplicate.

Fix: normalize the comparison key, i.e. match against `reportPath(target.targetRelativePath)` (or keep
an unencoded `rawPath` on diagnostics for internal matching and encode only on output).

### 4. `inventoryHash` and `status` depend on a verification depth the report does not record (medium, reproduced)

`library-doctor` verifies backup payloads and `library-inventory` does not
(`library-maintenance.mjs:1131`, `library-maintenance-cli.js` `verifyBackupPayloads: command === 'doctor'`),
and `buildMigrationPlan` hardcodes the shallow depth (`library-maintenance.mjs:1279`). Nothing in the
report says which depth produced it:

```
library-doctor    status: errors   hash: 6ba539a3fdf2b58d
library-inventory status: healthy  hash: f2171d9c9f44cb94
same library state, same generatedAt, different verdict: true
report keys: schemaVersion,status,layoutVersion,summary,items,diagnostics,generatedAt,inventoryHash
```

So `inventoryHash` is a function of (state, depth) while it reads as a function of state, and a
migration plan embeds the shallow hash under `doctor.inventoryHash`. A later `library-doctor` on an
unchanged library yields a different hash, which will read as drift to anything that compares them.

Fix: record the depth in the report (e.g. `payloadsVerified: true|false`, included in the hashed
intrinsic) so the two hashes are distinguishable, or exclude verification-dependent backup item state
from the hash. The invariant list should say which surface is authoritative.

### 5. The shared exit-code helper silently reclassified nine pre-existing error codes (medium-low, measured)

Consolidating on `cliExitCode` (`cli-error-format.mjs:39-46`) was the right call, but the shared version
added `code.includes('CONFLICT') || code.includes('RECOVERY') → 3`, and `storageCliExitCode` now
delegates to it. That changes the contract of commands outside P1-2a — `prepare-paper.js` and
`workspace-cli.js`:

```
CHANGED BACKUP_RESTORE_CONFLICT 1 -> 3      CHANGED PUBLICATION_IDENTITY_CONFLICT 1 -> 3
CHANGED CANONICAL_ID_CONFLICT 1 -> 3        CHANGED PUBLICATION_RECORD_CONFLICT 1 -> 3
CHANGED IDENTITY_REGISTRY_CONFLICT 1 -> 3   CHANGED PUBLICATION_ROUTE_CONFLICT 1 -> 3
CHANGED LIBRARY_REGISTRY_CONFLICT 1 -> 3    CHANGED PUBLICATION_RECOVERY_FAILED 1 -> 3
CHANGED PAPER_ROUTE_CONFLICT 1 -> 3
```

Exit 3 has meant "retryable — a conflicting operation is already running" (`STORAGE_LOCK_CONFLICT`,
`STORAGE_LOCK_TIMEOUT`, both flagged `retryable: true`). A route or canonical-ID collision is not
retryable; retrying it loops forever. No test pinned the old values, which is why this passed. Decide
deliberately: either keep 3 for lock/timeout only and give non-retryable conflicts their own code, or
accept the widening and update the exit-code documentation and the affected commands' contracts in the
same change.

### 6. `migration-dry-run --backup-id <corrupt>` throws instead of reporting a blocker (medium-low, reproduced)

`buildMigrationPlan` calls `verifyBackup` unguarded (`library-maintenance.mjs:1301-1302`), so a corrupt
or absent `--backup-id` produces `BACKUP_INTEGRITY_FAILED` / `BACKUP_NOT_FOUND` and a non-zero exit
rather than a plan carrying `MIGRATION_BACKUP_STALE`. The planner is the read-only surface a user turns
to in order to find out what is wrong, and quarantine now makes the corrupt-backup state a normal,
expected one. Fix: catch and map to `backup.status: 'stale'` plus a `MIGRATION_BACKUP_*` blocker, and
keep the plan emittable.

## Low

7. **`strict` has inverted defaults in the two halves of `buildLibraryIndexEntries`.**
   `buildManagedIndexEntries` uses `if (options.strict) throw` (`generation-publication.mjs:364`, tolerant
   when unset) while the new `buildLegacyIndexEntries` uses `if (options.strict !== false) throw`
   (`:392`, strict when unset). Both existing callers keep their previous behavior and explicit
   `true`/`false` agree, so nothing is broken today — but the option means opposite things depending on
   which half reads it. Make both explicit-default and give the two call sites the value they want.
8. **`LIBRARY_INDEX_DRIFT` and finding 1 aside, the 80-character segment cap makes long-but-legal
   identifiers unactionable.** A diagnostic path of `papers/encoded-6b2e…` gives the user no way to find
   the offending directory. Consider keeping a truncated prefix plus the hash
   (`papers/aaaaaaaa…-encoded-<hash>`), or bounding route slugs at creation time instead.
9. **`existingRestoreJournal` is read before the lock is taken** (`library-maintenance.mjs:694`), so the
   in-lock decision can use a stale journal state. I traced the reachable interleavings and they all
   converge (worst case is a transient `prepared` rewrite followed by a correct `index_committed`), so
   this is a robustness note, not a defect. Re-reading the journal inside the lock would remove the
   reasoning burden.

## Documentation accuracy

The updated summary and plan match the implementation on every point I checked, including the round-1
disposition section — the partial adoptions (Doctor still verifies payloads; journal pruning deferred to
P1-7; Identity module boundary deferred to P1-3b) are stated rather than glossed. Two corrections are
needed once the findings above are addressed:

- Invariant 8 and the plan's "Index updates preserve the live envelope and unrelated entries" are
  accurate, but neither says that drift detection can be silently disabled (finding 1). The invariant
  list should state the drift contract explicitly.
- The plan's "A corrupt content-addressed backup is retained under a private quarantine name and
  recreated" is accurate; it should also say that quarantined and `.init-` trees may be
  permission-locked until finding 2 is fixed, since that affects what an operator can clean up.

## Suggested disposition

- Blocks handoff: finding 1 (fail-open in the P1-2b gate), finding 2 (cleanup paths cannot remove what
  backup now legitimately writes).
- Before P1-2b starts writing: findings 3, 4, 6.
- Decide deliberately and document: finding 5.
- Opportunistic: findings 7, 8, 9.
