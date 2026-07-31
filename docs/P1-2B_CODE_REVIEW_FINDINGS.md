# P1-2b Independent Code Review Findings

- Review date: 2026-07-31
- Branch: `codex/audit-optimizations-2026-07-10`
- Reviewed artifacts: `docs/P1-2B_CODE_REVIEW_SUMMARY.md`, `docs/P1-2B_IMPLEMENTATION_PLAN.md`,
  `docs/explicit-generation-migration-1.0.md`, `docs/adr/0008-explicit-generation-migration-and-rollback.md`
- Prior phase reviews: `docs/P1-2A_CODE_REVIEW_FINDINGS.md`, `_ROUND2.md`, `_ROUND3.md`
- Method: read the new engine, CLI, schemas, guards and every diff against `HEAD`, then drove the real
  end-to-end migration in throwaway temp libraries — commit, rollback, roll-forward, recovery, reindex,
  alias mapping and tamper attempts — using fault injection and hand-built crash states. No user library
  was touched; every reproduction ran in `fs.mkdtempSync` roots that were torn down.

### How I got the real path to run locally

This machine runs Node 22.16.0 against a content runtime pinned to 22.23.1, so anything calling
`preparePaper` fails with `PROVENANCE_RUNTIME_NONCONFORMANT` — that is what blocked rounds 1–3 of P1-2a
from executing the publication path at all. I neutralized only the version comparison
(`generation-provenance.mjs` `collectRuntimeAttestation`: `node: observedNode === policy.host.node` →
`node: true`) through an ESM loader hook, changing no file on disk. Python 3.11.15 and PyMuPDF 1.28.0
are already conformant here, so the real bounded parser, real publication transaction and real manifest
sealing all ran. With that single override:

```
scripts/tests/*.test.mjs                        251/251 pass
plugins/.../study/scripts/tests/*.mjs           102/102 pass
scripts/tests/check-repository.test.mjs           87/87 pass
migration-test (the three files the gate runs)    47/47 pass
```

Without the override: 225/251, 97/102, 87/87, 44/47 — all 26 + 5 + 3 failures trace to the version pin.
So the documented local evidence is reproducible, and everything below was found by exercising the code,
not by reading it.

## Verdict

**Do not hand off yet.** The alias layer, the publication/manifest integration and the targeted reindex
are solid and I could not break them. The crash and rollback machinery is not: three of the four
authority-changing paths mutate published state *before* they finish checking their preconditions, and
the recovery guards then refuse the state they themselves produced. I found two windows where a legacy
migration becomes permanently unrecoverable by any shipped command, one where a refused roll-forward
leaves the library with two live authorities for one route, and one where the documented rollback CAS is
switched off — reached without any crash, by a single failed rollback attempt.

None of this is exotic. Findings 1, 3 and 6 are reachable by a process kill or a normal precondition
failure, and finding 6 fires through `migration-recover`, the command the plan tells operators to run.

## Blocking

### 1. Two crash points in a legacy commit are permanently unrecoverable (high, reproduced)

Faulting at each point in the commit sequence, then retrying:

```
fault point                  wsState    pkgDir   legacy dir  archive  retry            final state
after_committing_journal      validated  present  archived    false    ok            -> committed
after_current_commit          validated  ABSENT   present     false    MIGRATION_ARCHIVE_CONFLICT -> committing
before_index_commit           validated  ABSENT   present     false    MIGRATION_ARCHIVE_CONFLICT -> committing
after_legacy_archive          validated  ABSENT   archived    true     ok            -> committed
after_migration_publication   validated  ABSENT   archived    true     ok            -> committed
```

The two middle rows are the window the plan names as its ordering guarantee
(`current_committed → source archived → index committed`). In that window:

```
[2] transaction state: committing
[2] legacy flat dir still present: true
[2] managed current.json committed: true
[2] index.json entries: [{"slug":"synthetic-front-matter-noise"}]        <- still legacy
[2] resolveLibraryPaper('synthetic-front-matter-noise') -> managed_v1    <- dual authority
[2] doctor: errors ["PUBLICATION_ROUTE_CONFLICT@index.json"]
[3] publication-recover -> [{"ok":false,"code":"PUBLICATION_ROUTE_CONFLICT"}]
[4] migration-recover -> recovered=0 failed=1
    FAILED MIGRATION_ARCHIVE_CONFLICT: Detached migration recovery cannot verify the archived legacy source.
[4] transaction state: committing        (unchanged, forever)
```

Both recovery surfaces refuse, for different reasons:

- `commitGenerationMigration` computes `detachedRecovery = initial.state === 'committing' &&
  !workspace.packageDir` (`generation-migration.mjs:518`). Publication renames the workspace package into
  the record at/just before `current_committed`, so `packageDir` is already absent — the retry takes the
  detached branch, which *requires the archive to already exist* (`:533-537`) instead of finishing the
  archive step it owes.
- `recoverPublications` cannot resume it either: `assertRouteAvailable` is only tolerant when the caller
  passes `allowLegacyRoute` (`generation-publication.mjs:281`), and `recoverPublications` has no way to
  pass it. Any interrupted legacy-migration publication is therefore invisible to the generic publication
  recovery path.

The data is intact — the guard is simply too strict. Completing by hand exactly what the crashed step
owed makes the retry succeed immediately:

```
[1] interrupted PUBLICATION_FAULT_INJECTED
[2] manually completed the archive rename the crashed step owed
[3] retry now succeeds: committed=true state=committed
[3] index: [{"slug":"synthetic-front-matter-noise","storageKey":"p-89160820"}]
```

Fix: key detachment on the publication journal state rather than on `packageDir`, and let the detached
legacy branch accept `legacy source present + archive absent` and finish `moveLegacySourceToArchive` plus
the index rebuild. Give `recoverPublications` a way to learn `allowLegacyRoute` from the migration
transaction (or move the whole legacy transition behind the migration journal). Add fault-injection tests
at `after_current_commit` and `before_index_commit` — the suite only tests `after_legacy_archive` and
`after_migration_publication`, which happen to be the two recoverable points in that region.

### 2. A deleted source is treated as unchanged and lands in finding 1 (medium-high, reproduced)

`commitGenerationMigration:530` reads
`if (fs.existsSync(sourcePath) && inventoryTree(sourcePath).snapshotHash !== initial.source.snapshotHash)`.
The `existsSync` short-circuit means a source that vanished passes the freshness pre-flight:

```
source modified after start    commit=MIGRATION_SOURCE_CHANGED   state=workspace_created  currentSwitched=false  resolve=legacy_flat
source file added after start  commit=MIGRATION_SOURCE_CHANGED   state=workspace_created  currentSwitched=false  resolve=legacy_flat
source DELETED after start     commit=MIGRATION_SOURCE_MISSING   state=committing         currentSwitched=true   resolve=managed_v1
```

Modification is rejected before any authority changes — correct. Deletion is rejected only inside
`beforeIndexCommit`, i.e. after `current.json` was switched, so it lands in exactly the unrecoverable
state of finding 1. One-line fix: require the source to exist, and fail before the publication starts.

### 3. A refused roll-forward leaves two live authorities and wedges the transaction (high, reproduced)

`switchLegacy`'s roll-forward branch renames the retained managed record back into the store
(`:651`) *before* it verifies that the legacy bytes still match (`:658`). When that check fires, the
rename has already happened and nothing undoes it:

```
[1] roll-forward refused: MIGRATION_ROLLFORWARD_CONFLICT
[2] papers/synthetic-front-matter-noise present            : true
[2] managed record restored into the store                 : true
[2] migration archive 'target' still present               : false
[2] transaction.archive : {"sourceRelativePath":null,
     "targetRelativePath":".codex-paper/migration-archives-v1/mig-sha256-46f6c373…/target"}   <- path no longer exists
[3] index.json says   : [{"slug":"synthetic-front-matter-noise"}]   <- legacy
[3] resolver says     : managed_v1                                  <- managed
[4] doctor: errors ["PUBLICATION_ROUTE_CONFLICT@index.json"]
```

And there is no way out in either direction:

```
[3] can the operator return to a settled rolled_back state? -> MIGRATION_CURRENT_CONFLICT
[4.1] migration-recover -> recovered=0 failed=1 (MIGRATION_ROLLFORWARD_CONFLICT)
[4.2] migration-recover -> recovered=0 failed=1 (MIGRATION_ROLLFORWARD_CONFLICT)
[5] final state=rolling_forward, paper=managed_v1
```

The trigger is the ordinary reason to roll back in the first place: the operator edited the restored
legacy paper. `rollbackGenerationMigration` then refuses because it only accepts `committed` /
`rolling_back` (`:713`), so the transaction is stuck in `rolling_forward` and every `migration-recover`
run fails. The suite passes only because its test restores the exact original bytes and mode before
retrying.

`switchLegacy`'s rollback branch has the same shape: `verifyManagedCurrent(recordDir, currentAfter)` and
the `recordDir → targetArchive` rename at `:686-688` run after the legacy source has already been
renamed back at `:677`. Fix both directions the same way: complete every precondition check first, then
perform the renames, and treat a mid-transition failure as a state the next call can finish rather than
one it must refuse.

### 4. Rollback has no CAS on the live current once a rollback has been attempted (high, reproduced)

The documented precondition (`--expected-current-manifest-hash`, invariant 9) is enforced in two places,
both at `rollbackGenerationMigration:713-719`: against `transaction.currentAfter` (a value the caller
reads out of the transaction, so it constrains nothing about the library) and against the live
`descriptor.current` — but only `if (transaction.state === 'committed')`, and outside the locks. Nothing
inside `switchManaged` / `switchLegacy` ever compares the on-disk `current.json` to `currentAfter`;
`verifyManagedCurrent` only checks that the *desired* binding is self-consistent and that its generation
still exists.

Set-up: a legacy migration commits (current `C1`), then an ordinary later generation `C2` is published for
the same paper. Rolling back the migration:

```
state=committed, --expected=C1 (the migrated one)    REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
state=committed, --expected=C2 (the live one)        REFUSED MIGRATION_CURRENT_CONFLICT  newer generation preserved: true
state=rolling_back, --expected=C1                    PROCEEDED                           newer generation preserved: false
state=rolling_back via automatic migration-recover   PROCEEDED                           newer generation preserved: false
```

Reaching `rolling_back` needs no crash — both switch functions write that state as their *first* action
inside the lock (`:625`, `:643`) and only then run checks that can throw:

```
[1] rollback attempt refused: MIGRATION_ROLLBACK_CONFLICT
[2] transaction state left as: rolling_back   <-- no crash needed
```

So one refused rollback permanently disarms the CAS for every later attempt, including the automatic one.
For the managed path this is the whole protection — I drove `switchManaged` directly (it has no test
coverage at all, see finding 7) with a transaction whose bindings matched neither the on-disk current, and
it overwrote it without complaint:

```
[3] interrupted managed rollback transaction: state=rolling_back, currentAfter=C1, currentBefore=C1
[3] on disk, current is C2 -- neither of the transaction's bindings
[4] current is now 8d7bb7a611fb5371…  reverted to C1: true
[4] the later generation C2 was silently discarded as current: true
```

Fix: re-read `current.json` under the lock and require it to equal `currentAfter` before any authority
change, for both kinds and for every entry state; write the `rolling_*` marker only after the
preconditions pass (or make the marker itself carry the observed pre-state so a resume can re-verify).

## Before handoff

### 5. `buildMigrationPlan` hard-fails where it used to emit a blocked plan (medium-high, reproduced)

`library-maintenance.mjs:1396` now calls `resolveLibraryPaper(input, …)` unconditionally. That is a real
correctness fix — the old `packageVersions(target.targetDir)` inspected the record directory rather than
the package — but it also makes the read-only planner throw:

```
                                           doctor    backup                     plan
legacy: corrupt meta.json                  errors    ok bk-sha256-1f5f5ad0…     eligibility=blocked blockers=4
legacy: missing meta.json                  errors    ok bk-sha256-09e8fdb2…     eligibility=blocked blockers=3
managed: corrupt paper.json                errors    ok bk-sha256-c39f7e10…     THREW LIBRARY_RECORD_INVALID (422)
managed: corrupt current.json              errors    ok bk-sha256-905579c2…     THREW LIBRARY_RECORD_INVALID (422)
managed: current points at missing gen      errors    ok bk-sha256-b666d0a4…     THREW PAPER_GENERATION_NOT_FOUND (404)
```

Because `resolveLibraryPaper` reaches `listManagedRecords`, the damage also cross-contaminates: one broken
record anywhere makes the planner throw for every *other* paper, including healthy legacy ones — the exact
class of fail-hard that P1-2a rounds 1–2 removed from Doctor:

```
[1] healthy library      -> eligibility=blocked, doctor=healthy
[2] Doctor still scopes the damage: ["LIBRARY_RECORD_INVALID@.codex-paper/store-v1/papers/p-aaaa…",
                                    "LIBRARY_RECORD_INVALID@index.json"]
[2] plan for the UNRELATED healthy legacy paper -> THREW LIBRARY_RECORD_INVALID (422)
```

Doctor still scopes it correctly and backup still succeeds, so P1-2a's contract ("a damaged managed record
may be preserved as raw safe bytes but remains ineligible for migration") is only half true now: it is
ineligible, but `migration-dry-run` — the diagnostic surface of last resort, made emittable on purpose in
P1-2a round 2 — crashes instead of saying so. `migration-start` likewise reports a raw
`LIBRARY_RECORD_INVALID` rather than `MIGRATION_PLAN_BLOCKED`. Fix: resolve tolerantly (or catch and map to
a target diagnostic) and keep the plan emittable.

### 6. Doctor is blind to both new private registries (medium, reproduced)

After a clean legacy migration:

```
[1] doctor after a clean legacy migration: healthy
[1] diagnostics: []
[2] private registries: ["backups-v1","locks-v1","migration-archives-v1","migration-transactions-v1",
                         "store-v1","workspaces-v1"]
[3] archive tree: ["mig-sha256-3a1c6af6…/source"]     (a whole retained legacy paper)
[4] Doctor items mentioning "migration": []
```

`library-doctor` enumerates backups and restore transactions but has no item, count or diagnostic for
`migration-transactions-v1` or `migration-archives-v1`. Combined with findings 1–4 this is the part that
worries me most operationally: a transaction wedged in `committing` or `rolling_forward`, or a stale
archive holding an entire legacy paper, is invisible to the health command. The only way to discover a
wedged migration is to run `migration-recover` and read its failure. Doctor should enumerate both
registries, surface non-terminal transaction states as warnings/errors, and count retained archive bytes.

### 7. Managed-source migration has no end-to-end coverage (medium)

`scripts/tests/generation-migration.test.mjs` has five tests. The only managed-source one asserts
**failure**:

```js
await assert.rejects(
  startGenerationMigration(source.record.paperKey, backup.backupId, …),
  (error) => error.code === 'pdf_parse_failed',
)
```

The managed Manifest/Identity 1.0 golden's `paper.pdf` cannot be parsed, and both flat 2.0/2.1 goldens
carry empty evidence artifacts (`"evidence": []`, `coreClaims: []`), so no fixture can traverse a managed
migration. `switchManaged` — the whole managed rollback/roll-forward implementation, and invariant 9's
"Managed rollback switches to the previous current record" — is never executed by the suite. I had to
build a managed record by migrating a legacy paper and then hand-writing a transaction to reach it at all,
which is how finding 4's managed half was found. Either give the managed golden a parseable PDF or
construct the managed source in-test from a published generation.

### 8. A managed migration source includes the mutable Viewer overlay (medium, reproduced)

`structuralTarget` resolves a managed target to the record directory, and the overlay lives inside it:

```
structuralTarget('managed') targetRelativePath = .codex-paper/store-v1/papers/p-aaaa…
overlay/state.json is inside the migration source tree: true
adding one Viewer tag changes the migration source snapshot: true
  => commitGenerationMigration would report MIGRATION_SOURCE_CHANGED for a managed source
```

So one tag or reading-progress update between `migration-start` and `migration-commit` aborts the commit
— and also stales the backup, since `backup.status: 'verified'` requires the same `snapshotHash`. The
window is a full human authoring-and-validation cycle. This is also inconsistent with P1-2a, which went
out of its way not to revert curated overlay/index metadata on restore. The freshness contract should
cover the immutable record and generation content and exclude `overlay/`.

## Medium-low

### 9. The exit-code widening P1-2a reverted is back, in the new CLI

`generation-migration-cli.js:18-27` maps `code.endsWith('_CONFLICT')` plus four more codes to 3, on top
of the shared `cliExitCode` that P1-2a round 2/3 deliberately narrowed to locks, `WORKSPACE_` and the one
explicit `BACKUP_RESTORE_CONFLICT`:

```
code                            shared  migration      retryable
STORAGE_LOCK_CONFLICT           3       3              true
MIGRATION_CURRENT_CONFLICT      1       3  <-- widened  false
MIGRATION_ARCHIVE_CONFLICT      1       3  <-- widened  false
MIGRATION_ROLLBACK_CONFLICT     1       3  <-- widened  false
MIGRATION_ROLLFORWARD_CONFLICT  1       3  <-- widened  false
MIGRATION_STATE_CONFLICT        1       3  <-- widened  false
PUBLICATION_ROUTE_CONFLICT      1       3  <-- widened  false
PUBLICATION_IDENTITY_CONFLICT   1       3  <-- widened  false
PROVENANCE_MIGRATION_CONFLICT   1       3  <-- widened  false
MIGRATION_VALIDATION_REQUIRED   1       3  <-- widened  false
MIGRATION_EVIDENCE_UNRESOLVED   1       3  <-- widened  false
MIGRATION_SOURCE_CHANGED        1       3  <-- widened  false
```

Eleven non-retryable outcomes now share the exit code whose documented meaning is "retryable — a
conflicting operation is already running" (`retryable: true`, `storage-transaction.mjs:354`). Retrying a
route collision or a CAS mismatch loops forever.

Separately, the shared helper's `code.includes('LOCK')` heuristic (`cli-error-format.mjs:43`) accidentally
captures P1-2b's new `*_BLOCKED` codes — `MIGRATION_PLAN_B-LOCK-ED`, `LIBRARY_INDEX_REPAIR_B-LOCK-ED` —
and `publication-cli.js:34` has the same test. Verified live:

```
reindex --paper (unprojectable target) -> exit 3; stderr code: LIBRARY_INDEX_REPAIR_BLOCKED
```

Match on a code set or a `retryable` flag, not on substrings.

### 10. `reindex --dry-run` does not predict what `reindex` will do

Two divergences:

- **Library scope uses a different strictness than apply.** `planLibraryReindex` projects with
  `legacyStrict: false`; `writeRebuiltIndexLocked` with no `paperRef` uses `legacyStrict: true`
  (`generation-publication.mjs:427`). With one broken legacy sibling:

  ```
  [1] reindex --dry-run (library scope) -> scope=library projected=1 applyRequired=true
                                          diagnostics=["LEGACY_INDEX_SOURCE_INVALID"]
  [2] reindex (library scope)           -> THREW LEGACY_INDEX_SOURCE_INVALID
  ```

  The diagnostic is listed but carries no severity, and the plan has no `blocked` / `applyAvailable`
  field, so nothing in the document says the apply will refuse. Compare the migration plan, which has
  `eligibility` and `executionAvailable`.
- **Target scope reports the projection, not the result.** The dry run returns `projectedEntries: 1` and
  a `projectedSha256` over that single entry, while the apply writes the merged index — measured as 2 and
  3 entries in my runs. There is `indexBeforeSha256` but no `indexAfterSha256`.

### 11. `state: 'failed'` is unreachable and there is no abandon path

The transaction schema's `failed` state is never written by any code path; the module only ever writes
`workspace_created`, `committing`, `committed`, `rolling_back`, `rolled_back`, `rolling_forward`. With
findings 3 and 4 that means a transaction can sit in a non-terminal state indefinitely while
`migration-recover` fails on every invocation (`failed > 0` → exit 3). There is no `migration-abandon`
and the plan tells operators not to move directories by hand, so the documented instructions have no
answer for a permanently failed rollback.

## Low

12. **`migration-start` is the only non-idempotent verb.** A second start on the same paper throws
    `WORKSPACE_EXISTS` with the workspace ID but not the existing `migrationId`; commit, rollback and
    roll-forward all return `reused: true` instead. (The good news: it *is* blocked — the deterministic
    generation fingerprint prevents two concurrent migrations of one paper, which I verified.)
13. **`validateMigrationPlanDocument` and the retained `migration-plan-1.0` schema have no producer or
    consumer.** Plans are computed on demand and never persisted, and the only callers are in
    `migrate-package.test.mjs`. The `1.0.0 → compatible_1_0 / readOnly: true` branch is a shim for a
    document nothing reads. Also note `eligibility` changed values (`ready_for_p1_2b` → `ready`), so the
    two versions are not interchangeable.
14. **Migration policy constants are duplicated.** `library-maintenance.mjs:36-40` owns the hashed
    `MIGRATION_POLICY`; `generation-migration.mjs:53-55` re-declares `MIGRATION_POLICY_VERSION`,
    `MIGRATION_AUTHORING_PROVIDER` and `MIGRATION_AUTHORING_MODEL` and writes them into the source record
    alongside `plan.policy.sha256` from the other module. Drift would change `policySha256` while the
    schema's `const` fields stayed valid. Import the one object.
15. **`safeAuthoringFiles` enforces its safety checks unevenly.** The `code/` and `images/` walk raises
    `MIGRATION_SOURCE_UNSAFE` for symlinks, directories-as-files and special files (`:300-308`), but the
    hardcoded `ROOT_AUTHORING` / `CODEX_AUTHORING` entries are admitted on a symlink-following
    `fs.existsSync` (`:311-312`) and rely on the no-follow reader to fail later. Unreachable today because
    the mandatory backup rejects such a source first — I confirmed a symlinked `README.md`, a symlinked
    `code/`, a directory named `README.md` and a fifo all fail with `BACKUP_PATH_UNSAFE` /
    `STORAGE_PATH_UNSAFE` before start — but the asymmetry is one `lstat` away from being consistent.
16. **`startGenerationMigration` builds the plan twice** (`:367` and `:370`), so every start runs two full
    whole-library Doctor scans plus two backup verifications before doing any work.
17. **A typo'd migration ID reports a workspace error.** `inspectGenerationMigration` falls through to
    `resolveGenerationWorkspace`, so `migration-inspect not-an-id` exits 3 with `WORKSPACE_NOT_FOUND`
    rather than `MIGRATION_ID_INVALID` at exit 2.
18. **`cmd_migration_test` is the one gate not counted.** `scripts/codex-paper.sh` wraps
    `repository-security`, `study` and `repository-guard-static` in `run_counted_test_suite` (and the
    Repository Guard pins those three counts), but `migration-test` calls `node --test` directly, so the
    documented `47/47` is not pinned anywhere and a silently skipped migration file would not fail CI.

## What held up under attack

Worth recording, because I tried hard to break these and could not:

- **Evidence Alias Map.** Built a 2.0 source spanning all three mapping methods; every one resolved
  correctly and coverage was exact:

  ```
  coverage = {"referenced":4,"resolved":2,"unresolved":2,"ratio":0.5}
      claim:0                  -> ["ev-p001-par-c1fd562ed8"]  (fact_projection)
      ev-p001-par-011d3fccc0   -> ["ev-p001-par-011d3fccc0"]  (identity)
      ev-p001-par-0123456789   -> ["ev-p001-par-c1fd562ed8"]  (content_hash)
  diagnostics = ["EVIDENCE_ALIAS_UNRESOLVED:claim:1","EVIDENCE_ALIAS_UNRESOLVED:ev-p999-par-abcdef0123"]
  carried reasoning-analysis.json refs after translation: ["ev-p001-par-c1fd562ed8"]
  ```
- **Alias tampering after validation.** Every mutation was caught:

  ```
  untampered baseline                          COMMITTED
  coverage rewritten to unresolved=1           MIGRATION_EVIDENCE_UNRESOLVED
  alias injected pointing at a real ledger id  PROVENANCE_DEPENDENCY_STALE
  alias injected pointing at a FAKE ledger id  EVIDENCE_ALIAS_MAP_INVALID
  coverage made internally inconsistent        EVIDENCE_ALIAS_MAP_INVALID
  ```
- **Provenance and sealing.** The published generation's Manifest 2.0 covers
  `.codex-paper/evidence-aliases.json` and `.codex-paper/migration-source.json`, records the migration
  event, verifies clean, and seals at `0500` / `0400`.
- **Targeted reindex.** Envelope preserved, curated and junk entries retained, cross-authority conflict
  refused, unprojectable target refused, unrelated damage isolated, dry run byte-for-byte read-only:

  ```
  array index, legacy target            dry=scope=paper projected=1  readOnly=true  apply=entries=2  shape=array
  object-envelope index, legacy target  dry=scope=paper projected=1  readOnly=true  apply=entries=2  shape=object(...)
  managed record claims the same slug   dry=scope=paper projected=1  readOnly=true  apply=THREW PUBLICATION_ROUTE_CONFLICT
  index holds unrelated junk entries    dry=scope=paper projected=1  readOnly=true  apply=entries=3  shape=array
  broken legacy target (no meta.json)   dry=THREW LIBRARY_INDEX_REPAIR_BLOCKED       apply=THREW …
  unrelated broken legacy sibling       dry=scope=paper projected=1  readOnly=true  apply=entries=1  shape=array
  ```
- **Start is genuinely side-effect free** (index, source tree and Viewer visibility all unchanged), the
  fresh workspace has no authoring skeleton so `expectAbsent` copying is safe, no CLI error leaks an
  absolute library path, Manifest 1.0 bindings verify so managed rollback is mechanically possible, and
  the new `migration` lock kind joins the total order at rank 50 with no re-entrant acquisition.
- **Repository Guard**: 0 errors both with the P1-2b tree untracked and with a simulated fully-tracked
  index, and the new boundary assertions are `existsSync`-gated rather than tracking-gated, so they are
  live now.

## Documentation accuracy

The summary and plan are accurate about what was built; they overstate what was proven.

- Invariant 7 ("The source snapshot and backup are reverified before commit") is true for modification,
  false for deletion (finding 2).
- Invariant 8 ("Legacy authority switching and every current/index transition are journaled under ordered
  cross-process locks") is literally true — journaled and correctly locked — but the plan's
  `current_committed → source archived → index committed` ordering has two unrecoverable interior points
  (finding 1). The invariant should say the transitions are *convergent*, and only once they are.
- Invariant 9 ("Rollback uses a caller-supplied current-manifest CAS") does not hold for a resumed
  rollback of either kind (finding 4).
- Invariant 12 ("Unknown/corrupt versions and ambiguous authority fail closed") holds for authority, but
  a corrupt managed record makes the read-only planner throw rather than report (finding 5).
- The plan lists managed Manifest/Identity 1.0 as a supported source; no test can traverse it
  (finding 7). The acceptance line `47/47` is real and reproducible, but rollback/roll-forward coverage is
  legacy-only and picks the recoverable fault points.
- The `library-doctor` contract inherited from P1-2a — the authoritative read-only health surface — should
  either be extended to the two new registries or the docs should state that migration state is outside
  Doctor's scope (finding 6).

## Suggested disposition

- **Blocks handoff:** findings 1, 3, 4 (published state mutated before preconditions complete; recovery
  refuses the result), and finding 2 as the cheapest half of finding 1.
- **Before P1-3b:** findings 5, 6, 7, 8.
- **Decide deliberately and document:** finding 9 (this is the third time exit 3 has been widened).
- **Opportunistic:** findings 10–18.
