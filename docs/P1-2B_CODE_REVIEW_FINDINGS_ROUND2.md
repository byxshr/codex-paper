# P1-2b Independent Code Review Findings — Round 2

- Review date: 2026-07-31
- Branch: `codex/audit-optimizations-2026-07-10`
- Reviewed artifacts: `docs/P1-2B_CODE_REVIEW_SUMMARY.md` and `docs/P1-2B_IMPLEMENTATION_PLAN.md` (both updated)
- Round 1 findings: `docs/P1-2B_CODE_REVIEW_FINDINGS.md`
- Method: re-ran every round-1 reproduction against the updated code, read the full round-2 delta
  (`generation-migration.mjs` rewrite, `library-maintenance.mjs`, `generation-publication.mjs`,
  `cli-error-format.mjs`, both CLIs, schemas, guards, tests), and built nine new reproductions targeting
  the new state machines. Same harness as round 1: an ESM loader neutralizes only the pinned Node version
  comparison in `collectRuntimeAttestation`, changing no file on disk, so the real parser, the real
  publication transaction and real manifest sealing all execute. Every run used a throwaway
  `fs.mkdtempSync` library; no user data was touched.

## Verdict

**No blocking finding.** All four round-1 blockers are genuinely closed, and I verified each by driving
the code rather than by reading the new tests. The rewrite of `switchLegacy` / `switchManaged` into
"verify every precondition, then mutate, then journal" is the right shape and it holds under all eight
crash points I can reach. The documented local evidence reproduces exactly:

```
scripts/tests/*.test.mjs                      256/256    (claimed 256/256)
plugins/.../study/scripts/tests/*.mjs         102/102    (claimed 102/102)
scripts/tests/check-repository.test.mjs          87/87    (claimed 87/87)
migration-test (now run_counted_test_suite 52)   52/52    (claimed 52/52)
```

What remains is a coherent theme rather than scattered nits: **isolation**. Round 1's isolation problems
were fixed where they were fatal, but three places still let one damaged, unrelated object degrade or
block an operation on a healthy one — the planner's source description (finding 1), the index rebuild at
the end of every authority switch (finding 2), and the workspace-addressed transaction lookup
(finding 3). Finding 2 is the one I would fix before handoff: it stops a rollback *after* the authority
has already moved.

## Round-1 findings: independently re-verified

| # | Round-1 finding | Round-2 result |
|---|---|---|
| 1 | Two legacy commit crash points unrecoverable | **fixed** — all five fault points converge |
| 2 | Deleted source treated as unchanged | **fixed** — rejected before publication |
| 3 | Refused roll-forward → dual authority + wedge | **fixed** — refuses before mutation, state settled |
| 4 | Rollback CAS absent once rollback attempted | **fixed** — in-lock live-current check, both kinds |
| 5 | Planner hard-fails instead of emitting a plan | **fixed**, but see finding 1 |
| 6 | Doctor blind to the new private registries | **fixed** — items, pending counts, retained bytes |
| 7 | Managed migration had no end-to-end coverage | **fixed** — commit + rollback + roll-forward |
| 8 | Managed freshness included the Viewer overlay | **fixed** — excluded, real changes still caught |
| 9 | Exit-code widening reintroduced | **fixed**, but see finding 6 |
| 10 | `reindex --dry-run` did not predict the apply | **fixed** — byte-exact prediction |
| 11 | Unreachable `failed` state, no abandon path | addressed — state removed from the schema |
| 12 | `migration-start` not idempotent | **fixed** for the happy retry; see finding 4 |
| 13 | Migration Plan 1.0 shim has no consumer | deliberately retained, stated in the summary |
| 14 | Policy constants duplicated | **fixed** — one imported `MIGRATION_POLICY` |
| 15 | Uneven `lstat` checks on copied authoring files | **fixed** — `addRegularFile` |
| 16 | Plan built twice per start | **fixed** — one `buildMigrationPlan` call |
| 17 | Typo'd migration ID reported as a workspace error | partial — see low observations |
| 18 | Migration gate not counted | **fixed** — `run_counted_test_suite "migration" 52` |

### 1. Crash convergence — fixed

Re-running the round-1 fault matrix (columns: state after the fault, then the outcome of a plain retry):

```
after_committing_journal      pkgDir=present  arch=false  retry=ok -> committed
after_current_commit          pkgDir=ABSENT   arch=false  retry=ok -> committed
before_index_commit           pkgDir=ABSENT   arch=false  retry=ok -> committed
after_legacy_archive          pkgDir=ABSENT   arch=true   retry=ok -> committed
after_migration_publication   pkgDir=ABSENT   arch=true   retry=ok -> committed
```

Rows 2–3 were the permanently wedged pair. The legacy source/archive check moved out of the
`detachedRecovery` branch and now runs unconditionally (`generation-migration.mjs:574-588`), requiring
exactly one of `{source, archive}` to exist and verifying the snapshot of whichever survived, so a
detached retry with `source present / archive absent` finishes the archive and the index commit.
`recoverPublications` is still unaware of `allowLegacyRoute`, but it no longer matters: the migration
surface converges on its own, which is what the plan promises.

### 2. Deleted source — fixed

```
source modified after start    commit=MIGRATION_SOURCE_CHANGED   state=workspace_created  currentSwitched=false
source file added after start  commit=MIGRATION_SOURCE_CHANGED   state=workspace_created  currentSwitched=false
source DELETED after start     commit=MIGRATION_SOURCE_MISSING   state=workspace_created  currentSwitched=false
```

The `existsSync &&` short-circuit is gone (`:579`); deletion now fails before the `committing` journal
write and before publication, leaving no store directory behind.

### 3. Roll-forward dual authority and wedge — fixed

The round-1 sequence (roll back, edit the restored legacy paper, roll forward) now:

```
[1] rolled back; paper is legacy_flat, state=rolled_back
[2] roll-forward attempt -> MIGRATION_ROLLFORWARD_CONFLICT; state is now rolled_back
[3] can the operator return to a settled rolled_back state? -> ok
[4.1] migration-recover -> recovered=0 failed=0
[5] final state=rolled_back, paper=legacy_flat
```

Every precondition is checked before the first rename (`:736-754`), and the `rolling_*` marker is written
only after they pass (`:755`), so a refused operation is a true no-op. The mutation order was also
inverted in both directions so the intermediate state is "neither authority live" rather than "both". I
faulted between the two renames in all four positions and every one converged:

```
rollback @after_legacy_target_archive   mid: rolling_back    resolve=THREW PAPER_NOT_FOUND | recover failed=0 -> rolled_back  legacy_flat
rollback @after_legacy_source_restore   mid: rolling_back    resolve=legacy_flat           | recover failed=0 -> rolled_back  legacy_flat
rollfwd  @after_legacy_source_archive   mid: rolling_forward resolve=THREW PAPER_NOT_FOUND | recover failed=0 -> committed    managed_v1
rollfwd  @after_legacy_target_restore   mid: rolling_forward resolve=managed_v1            | recover failed=0 -> committed    managed_v1
```

### 4. Rollback CAS — fixed for both kinds

`switchManaged` reads the live current under the lock and requires it to equal the expected pre-state, or
the post-state if this is a resume of the same direction (`:703-707`); `switchLegacy` does the equivalent
via `sameCurrent(liveManagedCurrent(recordDir), currentAfter)` (`:743`). The round-1 matrix — a migration
committed as `C1`, then an unrelated newer generation `C2` published — now refuses in every row:

```
state=committed, --expected=C1 (the migrated one)    REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
state=committed, --expected=C2 (the live one)        REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
state=rolling_back, --expected=C1                    REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
state=rolling_back via automatic migration-recover   REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
```

Driving `switchManaged` directly with the round-1 synthetic transaction (bindings matching neither the
on-disk current) now throws `MIGRATION_CURRENT_CONFLICT` at `:706` instead of overwriting.

### 6, 8, 10 — fixed and measured

Doctor after a clean legacy migration and after an interrupted one:

```
summary: {... "migrationTransactions":1,"pendingMigrations":0,"migrationArchives":1,"migrationArchiveBytes":1962 ...}
interrupted: status=warnings  ["warning:MIGRATION_RECOVERY_PENDING@.codex-paper/migration-transactions-v1/mig-sha256-48fd8fc2….json"]
junk entries: status=errors   [MIGRATION_TRANSACTION_INVALID@…/README.txt, MIGRATION_ARCHIVE_INVALID@…/not-a-migration-id]
```

Overlay exclusion (`migrationSourceSnapshot`, `library-maintenance.mjs:265`) is exact — a Viewer tag no
longer perturbs the snapshot, the plan ID, or backup freshness, while a real generation byte change is
still caught:

```
[E1] managed snapshot stable across a Viewer tag: true
[E2] backup.status before=verified after=verified
[E3] plan source.snapshotHash unchanged: true; planId unchanged: true
[E4] a real generation byte change is still detected: true
```

Reindex dry-run now predicts the apply byte-for-byte, and its `applyAvailable`/`blockers` agree with what
apply actually throws in all six cases I tested:

```
library scope, healthy                       applyAvailable=true   blockers=[]                              predicted post-apply hash exact: true
library scope, broken legacy sibling         applyAvailable=false  blockers=[LEGACY_INDEX_SOURCE_INVALID]    apply=THREW LIBRARY_INDEX_REPAIR_BLOCKED
target scope, curated sibling retained       applyAvailable=true   resultEntries=2                          predicted post-apply hash exact: true
target scope, object envelope                applyAvailable=true   resultEntries=2                          predicted post-apply hash exact: true
target scope, broken target                  applyAvailable=false  blockers=[LIBRARY_INDEX_REPAIR_BLOCKED]   apply=THREW LIBRARY_INDEX_REPAIR_BLOCKED
target scope, route owned by managed record  applyAvailable=false  blockers=[PUBLICATION_ROUTE_CONFLICT]     apply=THREW PUBLICATION_ROUTE_CONFLICT
```

### Still holding from round 1

The alias layer is unchanged and still correct and tamper-proof (all three mapping methods, exact
coverage, and the four tamper attempts still caught by `MIGRATION_EVIDENCE_UNRESOLVED` /
`PROVENANCE_DEPENDENCY_STALE` / `EVIDENCE_ALIAS_MAP_INVALID`); symlinks, symlinked `code/`, a directory
named `README.md` and a fifo are all still refused — the directory case now with the intended
`MIGRATION_SOURCE_UNSAFE`; unsafe `papers/` roots and unsafe legacy entry names still fail closed with
`.DS_Store` still tolerated; no CLI error leaks an absolute library path; Repository Guard yields 0 errors
both with the P1-2b tree untracked and with a simulated fully-tracked index, and now pins
`migrationSourceSnapshot`, `sameCurrent`, `liveManagedCurrent`, `MIGRATION_SOURCE_MISSING`, the two new
publication fault points, and `"migration" 52`.

## New findings

### 1. The planner still mislabels a healthy paper when an unrelated record is damaged (medium, reproduced)

`buildMigrationPlan` now catches the resolution failure (`library-maintenance.mjs:1486`) — which fixes the
hard-fail — but it applies the failure to *the target's own description*. Because
`resolveLibraryPaper` reaches `listManagedRecords`, a broken record anywhere makes resolution fail for
every paper, so a healthy legacy paper's plan changes underneath it:

```
[1] healthy library, healthy legacy paper:
    source  = {"layoutMode":"legacy_flat","compatibilityMode":"legacy_v1","packageVersion":"legacy",
               "identityVersion":null,"manifestVersion":null,...}
    blockers = ["error:MIGRATION_BACKUP_REQUIRED@-"]

[2] SAME healthy legacy paper, one unrelated managed record damaged:
    source  = {"layoutMode":"legacy_flat","compatibilityMode":"unknown_read_only","packageVersion":null,
               "identityVersion":"invalid","manifestVersion":"invalid",...}
    blockers = ["error:LIBRARY_RECORD_INVALID@index.json",
                "error:LIBRARY_RECORD_INVALID@papers/healthy-legacy",   <- another paper's corruption
                "error:MIGRATION_BACKUP_REQUIRED@-"]
    planId changed: true
```

The paper is a perfectly readable legacy v1 package, but the plan reports it as an unsupported version
with invalid identity and manifest, attributes `LIBRARY_RECORD_INVALID` to its own path, and changes its
`planId`. Invariant 12's new clause ("isolates unrelated damaged records") is not met, and this is exactly
the misreporting Doctor was fixed for in P1-2a rounds 1–2 — Doctor scopes the same damage correctly in the
same run.

Worth noting: the shipped regression test asserts
`legacyPlan.diagnostics.some((item) => item.path?.includes(managed.record.paperKey)) === false`
(`generation-migration.test.mjs:379`), which passes *because* the misattribution rewrites the path to the
healthy paper's own. The assertion cannot distinguish "isolated" from "mislabelled".

Fix: isolate at the resolution layer the way Doctor does (resolve the target without requiring every other
record to parse), or at minimum keep the target's own `packageVersions` description and attribute the
resolution error to `index.json` rather than to the target path.

### 2. An unrelated broken legacy sibling blocks commit and rollback *after* the authority has moved (medium, reproduced)

`writeRebuiltIndexLocked` now projects tolerantly but throws when any diagnostic path starts with
`papers/` (`generation-publication.mjs:428-436`). It is called with no `paperRef` at the end of
`commitPublicationLocked`, `switchManaged` and `switchLegacy` — i.e. after every rename. A single stray
`papers/_scratch/meta.json` containing malformed JSON (the exact object P1-2a decided to tolerate) is
enough:

```
[A1] commit with unrelated junk -> LIBRARY_INDEX_REPAIR_BLOCKED
[A1] state=committing  resolve=managed_v1  index=["synthetic-front-matter-noise"]      <- index still legacy
[A1] legacy source archived already: true
[A2] recover -> recovered=0 failed=1 LIBRARY_INDEX_REPAIR_BLOCKED
[A3] junk removed, recover -> recovered=1 failed=0; state=committed index=[...(managed)]

[B1] rollback with unrelated junk -> LIBRARY_INDEX_REPAIR_BLOCKED
[B1] state=rolling_back  resolve=legacy_flat  index=["synthetic-front-matter-noise(managed)"]  <- index still managed
[B1] legacy restored: true; managed record present: false
[B2] recover -> recovered=0 failed=1 LIBRARY_INDEX_REPAIR_BLOCKED
[B3] junk removed, recover -> recovered=1 failed=0; state=rolled_back index=[...]
```

In both cases the filesystem authority has already switched while `index.json` still describes the old
one, so the Viewer's index and the resolver disagree until an operator notices. Nothing is lost and it
converges once the unrelated directory is removed, which is why this is not a blocker — but the operator
is given no way to find it: `recoverGenerationMigrations` keeps only `error.message`
(`generation-migration.mjs:832`) and drops `details.diagnostics`, so the reported failure is
"Library index repair is blocked by an invalid legacy authority" with no path.

Fix: these three call sites all know exactly which paper they are changing, and `writeRebuiltIndexLocked`
already has a target mode. Passing `{ paperRef, descriptor }` would keep the unrelated damage out of the
transition entirely. Failing that, propagate `details.diagnostics` through recovery results.

### 3. One corrupt transaction file breaks every workspace-addressed operation (medium-low, reproduced)

`inspectGenerationMigration` scans the transaction registry in sorted order and calls `readTransaction`
on each entry (`:523-527`), which schema-validates. One unreadable file that sorts before the target kills
the lookup:

```
[C1] inspect by workspace works: true
[C2] with ONE unrelated corrupt transaction file (id sorting first):
     inspect by workspace   -> THREW LIBRARY_RECORD_INVALID
     inspect by migrationId -> ok
     commit by workspace    -> THREW LIBRARY_RECORD_INVALID
```

Both `migration-inspect <workspace>` and `migration-commit <workspace>` are documented entry points. The
failure depends on sort order relative to the target ID, so it presents as intermittent. Doctor already
reports such files as their own `MIGRATION_TRANSACTION_INVALID` item, so the scan loop should skip
unreadable entries rather than propagate.

### 4. A start interrupted before the transaction is written is a dead end (medium-low, reproduced)

The finding-12 fix reuses an existing migration when `preparePaper` reports `WORKSPACE_EXISTS`
(`:420-436`), but only if a transaction already exists — and the transaction is written last, after
`buildAliasMap`, `copyAuthoring` and the provenance writes. Any failure in that span leaves no transaction
and no way back in:

```
[2] start with an oversize code/ file -> STORAGE_FILE_TOO_LARGE: Storage file exceeds the allowed size.
[2] workspaces left behind: 1
[2] transactions written: 0
[2] leftover workspace state=authoring; README carried=true
[2] migration-inspect <workspace> -> THREW MIGRATION_NOT_FOUND
[3] retrying migration-start -> WORKSPACE_EXISTS
```

The trigger is mundane: `copyAuthoring` caps `code/` files at 1 MiB (`:328`), so any source package with a
larger script can never be migrated, and the first attempt poisons the route. The operator must know to
abandon the workspace through the unrelated `workspace-*` commands; neither the plan nor the error says
so. Note `copyAuthoring` was made idempotent in this round, so resuming would work — the only thing in the
way is the transaction-exists precondition.

Two smaller things in the same code: the "Could not migrate authoring file `<path>`" context wrapper only
covers the write (`:348-358`), not the bounded read that actually failed here, so the operator gets no
file name; and the 1 MiB `code/` cap is not documented anywhere.

### 5. Doctor Report 1.0 changed incompatibly without a version bump (medium-low)

`library-doctor-report-1.0.schema.json` gained four **required** summary fields
(`migrationTransactions`, `pendingMigrations`, `migrationArchives`, `migrationArchiveBytes`) and two item
kinds. A Doctor Report 1.0 document produced by the P1-2a implementation — the version shipped and frozen
one commit ago — no longer validates against the schema that claims to define it, and `inventoryHash` now
covers the new fields so an unchanged library hashes differently than before.

This is inconsistent with how the same round treated Migration Plan, which was correctly bumped
`1.0.0 → 1.1.0` for a strictly smaller change (one enum value, one field) with the 1.0 schema retained for
reads. Either make the new summary fields optional or bump to Doctor Report 1.1 with the same
`validateMigrationPlanDocument`-style dispatch.

### 6. The exit-code fix also silently demoted three pre-existing lock codes (medium-low, measured)

Replacing `code.includes('LOCK')` with an exact set (`cli-error-format.mjs:43-45`) correctly stops
`MIGRATION_PLAN_B-LOCK-ED` and `LIBRARY_INDEX_REPAIR_B-LOCK-ED` from being classified as retryable —
verified live, both now exit 1, and all eleven permanent conflicts from round 1 are back to 1. But the
narrowing also moved three codes outside P1-2b's scope from 3 to 1:

```
STORAGE_LOCK_CORRUPT          3 -> 1
STORAGE_LOCK_OWNERSHIP_LOST   3 -> 1
STORAGE_LOCK_REQUIRED         3 -> 1
```

`STORAGE_LOCK_OWNERSHIP_LOST` (`storage-transaction.mjs:264`) is the one where 3 was arguably right —
the operation lost its lock and retrying is the correct response. As in P1-2a round 2, no test pins these
values, which is why the change is invisible. Decide each of the three deliberately and pin the set.

## Low

1. **`copyAuthoring`'s new existing-target branch is an unconditional overwrite dressed as a CAS.**
   `{ expectedSha256: sha256(<the file's current bytes>) }` (`:346`, retried at `:354` after a fresh read)
   can never fail its own precondition. It is unreachable today because the reuse path returns before
   `copyAuthoring`, but it becomes a live clobber of workspace content the moment finding 4 is fixed by
   resuming. Prefer an explicit "overwrite intended" flag over a self-satisfying hash.
2. **A corrupt transaction JSON is reported as `LIBRARY_RECORD_INVALID`.** The reader's generic code wins
   over the `error.code || 'MIGRATION_TRANSACTION_INVALID'` fallback, so Doctor and the CLI both name the
   wrong contract.
3. **`reindex --dry-run` still throws instead of reporting blockers** when `papers/` itself is a regular
   file (`LIBRARY_PATH_MISSING`) or a symlink (`LIBRARY_PATH_UNSAFE`). Correct direction, but inconsistent
   with the blocker-reporting contract the same change introduced.
4. **A pending migration transaction does not gate a fresh `migration-start` for the same paper.** Only
   the deterministic workspace identity prevents a second in-flight migration; a plan or backup change
   would produce a second transaction for one paper. Doctor now counts `pendingMigrations`, so the check
   is cheap.
5. **Doctor schema-validates every transaction**, so one written by a newer plugin version is reported as
   `invalid` rather than as an unknown-but-tolerated state. The rest of the codebase distinguishes
   "unsupported version" from "corrupt".
6. **During a legacy authority switch the route transiently 404s.** The intermediate state is deliberately
   "neither authority live" while `index.json` still lists the pre-switch one, so a Viewer request for
   that slug fails for the duration. That is the right trade against dual authority and it is
   crash-recoverable; worth one sentence in the plan so it is a documented property.
7. **The guard pins the new helpers but not the ordering they exist to enforce.**
   `sameCurrent`, `liveManagedCurrent` and `migrationSourceSnapshot` are required to be present, but
   nothing prevents a refactor from moving the `rolling_*` journal write back above the precondition
   checks — the specific regression that produced round-1 findings 3 and 4.
8. **`makeManagedGoldenParseable` re-implements the manifest hash algorithm in the test**
   (`generation-migration.test.mjs:113-118`). It works, and it is what unblocked managed coverage, but the
   fixture is now validated against the test's own copy of a production rule.
9. **Finding 17 is only half fixed.** `mig-`-prefixed typos now report `MIGRATION_ID_INVALID` at exit 2,
   but an unrecognizable reference still falls through to workspace resolution:
   `migration-inspect not-an-id` → `WORKSPACE_NOT_FOUND`, exit 3 (retryable).

## Documentation accuracy

The updated summary and plan match the implementation on every point I checked, including the honest
account of what was accepted, what was removed (finding 11) and what was deliberately retained
(finding 13). Two invariants need a further pass once the findings above are addressed:

- Invariant 9 ("Rollback and roll-forward re-read live current/authority state under lock and finish every
  precondition before mutation") is now accurate and I verified both halves.
- Invariant 8's added sentence about converging from `after_current_commit` and `before_index_commit` is
  accurate.
- Invariant 12's "the read-only planner returns a blocked plan and isolates unrelated damaged records" is
  half true: the plan is emittable, but unrelated damage is misattributed to the target rather than
  isolated (finding 1).
- Neither document mentions that an unrelated invalid legacy directory can block a commit or rollback at
  the index step (finding 2), nor the 1 MiB `code/` limit on migrated authoring files (finding 4).

## Suggested disposition

- Nothing blocks handoff.
- Worth fixing before handoff: finding 2 (an unrelated stray directory should not be able to stall a
  transition after the authority has moved) and finding 1 (a healthy paper should not be described as
  corrupt).
- Before the formats are frozen again: finding 5 (Doctor Report version bump).
- Decide deliberately and pin: finding 6.
- Opportunistic: findings 3, 4, and low observations 1–9.
