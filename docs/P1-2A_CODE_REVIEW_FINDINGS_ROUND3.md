# P1-2a Independent Code Review Findings — Round 3

- Review date: 2026-07-31
- Branch: `codex/audit-optimizations-2026-07-10`
- Reviewed artifact: `docs/P1-2A_CODE_REVIEW_SUMMARY.md` and `docs/P1-2A_IMPLEMENTATION_PLAN.md` (both updated)
- Prior rounds: `docs/P1-2A_CODE_REVIEW_FINDINGS.md`, `docs/P1-2A_CODE_REVIEW_FINDINGS_ROUND2.md`
- Method: re-ran all fourteen prior-round reproductions against the updated code, reviewed the round-3
  deltas (`library-maintenance.mjs`, `generation-publication.mjs`, `cli-error-format.mjs`, both affected
  schemas, guards, tests), and built four new reproductions targeting the new drift and cleanup logic.
  No user library was touched.

## Verdict

**Ready for handoff.** This is the first round with no blocking finding. All nine round-2 suggestions
were implemented, and I verified each one independently rather than trusting the new tests. The round-1
fixes remain intact. The per-authority index-drift rewrite is the substantive change, and it holds up
under edge cases the new tests do not cover (indexed-but-deleted paper, managed-record drift, junk index
entry) — each fails closed at the right scope.

The seven remaining observations below are all low: report-message precision, enum expressiveness, and
style. None changes behavior or blocks P1-2b.

## Round-2 findings: independently re-verified as fixed

### 1. Index-drift fail-open — fixed

Drift is now compared per projected authority (`library-maintenance.mjs:1268-1310`), keyed
`legacy:<slug>` / `managed:<paperKey>` (`:886-914`), with only the specific unprojectable authority
skipped (`:1275`, `:1296`). Re-running the round-2 reproduction:

```
[1] drift alone     -> [ LIBRARY_INDEX_DRIFT ]
[2] drift + sibling -> [ LEGACY_PACKAGE_INVALID@papers/_scratch,
                         LEGACY_INDEX_SOURCE_INVALID@papers/_scratch,
                         LIBRARY_INDEX_DRIFT_UNDETERMINED@papers/_scratch,
                         LIBRARY_INDEX_DRIFT@papers/healthy ]
    LIBRARY_INDEX_DRIFT still reported? true
    plan eligibility for the drifted paper: blocked | blockers: 1
```

I also probed three cases the new tests do not:

| case | result |
|---|---|
| index entry for a paper deleted from disk | `LIBRARY_INDEX_DRIFT@papers/ghost`; healthy sibling's plan unaffected |
| managed record with a drifted index entry | drift scoped to `.codex-paper/store-v1/papers/p-cccc…`; that paper's plan `blocked` |
| index entry with neither `slug` nor `storageKey` | `LIBRARY_INDEX_DRIFT@index.json` → global blocker (fail-closed, correct) |

### 2. Sealed payloads unremovable by production cleanup — fixed

`removeTreeForcingWritable` (`library-maintenance.mjs:146-157`) chmods top-down before recursing and is
wired into both removal sites (`:616` lost-rename, `:622` outer failure). My round-2 reproduction only
proved that a plain `rmSync` still cannot delete a sealed tree — which is OS behavior, not the fix — so I
exercised the production paths directly with fault injection against a fully sealed `0500` payload:

```
[1] lost-rename branch  -> threw BACKUP_NOT_FOUND | .init- residue: []
[2] post-copy failure   -> threw EIO             | .init- residue: []
```

Both previously stranded an un-removable residue, and site [1] previously threw `EACCES`. Symlinks are
handled correctly (`lstat` first, `chmod` skipped for links, the link itself unlinked).

### 3. `reportPath` encoding vs the blocker filter — fixed

`buildMigrationPlan` now normalizes the comparison key (`targetReportPath`, `:1363`, used at `:1368`).
The same 90-character slug that previously lost its blockers:

```
plan(90-char slug) doctor.blockers:
  LIBRARY_RECORD_INVALID@papers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-encoded-6b2ec79170f50ea57b886dc81a2cf787
  LIBRARY_INDEX_DRIFT_UNDETERMINED@papers/aaaaaaaa…-encoded-6b2ec79…
```

The encoded form is also idempotent under re-normalization (readable ≤32 + `-encoded-` + 32 hex = 73 ≤ 80
and only `[A-Za-z0-9._-]`), which matters because item diagnostics pass through `diagnostic()` twice.

### 4. Unrecorded verification depth — fixed

`payloadsVerified` is now part of the hashed intrinsic (`:1342`), required in both
`library-doctor-report-1.0.schema.json` and the plan's `doctor` object, and surfaced at `:1452`:

```
library-doctor    status: errors   hash: dc80a7a1…   payloadsVerified: true
library-inventory status: healthy  hash: 1de314e1…   payloadsVerified: false
plan doctor: matches doctor hash? false | matches inventory hash? true
```

The two hashes still differ for the same library, but the difference is now self-describing.

### 5. Exit-code widening — fixed, and scoped correctly

`cliExitCode` (`cli-error-format.mjs:39-45`) reserves `3` for lock codes, the `WORKSPACE_` prefix, and
the explicit `BACKUP_RESTORE_CONFLICT`. Re-measuring all nine previously reclassified codes against the
pre-P1-2a baseline:

```
CHANGED vs pre-P1-2a: BACKUP_RESTORE_CONFLICT 1 -> 3
(no other drift)
```

Only the intentional new P1-2a code moved. `prepare-paper.js` and `workspace-cli.js` keep their prior
contracts.

### 6. Planner hard-fail on a bad `--backup-id` — fixed

`:1384-1406` catches inspection/verification failure and maps it to `MIGRATION_BACKUP_NOT_FOUND` (404) or
`MIGRATION_BACKUP_INVALID`, keeping the plan emittable. A syntactically invalid ID still throws
`BACKUP_ID_INVALID` (exit 2), which is the right split: bad syntax is a usage error, bad state is a
blocker.

### 7. `strict` polarity — fixed

Both halves now default to tolerant with per-half overrides (`generation-publication.mjs:326`, `:379`),
and `writeRebuiltIndexLocked` explicitly restates the prior policy (`managedStrict: false`,
`legacyStrict: true`, `:418-421`) so `reindex` still fails closed on an unsafe legacy entry. The guard
pins it (`check-repository.mjs:792`). The one other caller,
`scripts/tests/generation-publication.test.mjs:266`, is unaffected.

### 8. Unactionable encoded identifiers — fixed

`reportSegment` (`:850-860`) keeps a sanitized 32-character prefix plus the hash.

### 9. Journal read outside the lock — fixed

`existingRestoreJournal` is now called inside `withStorageLocks` (`:713`), `restoreId` is derived
deterministically before the lock, and `check-repository.mjs:705-709` pins the source ordering.

## Round-1 findings: still fixed

All ten round-1 reproductions re-run clean: sealed `0500` directory modes and empty directories
preserved (sealed generation not writable), legacy directory mode `755` preserved, hostile names bounded
instead of aborting Doctor, corrupt backup quarantined and recreated, unrelated journal isolated, live
index envelope preserved, no-op restore preserving curated `tags`/`progress`, single managed-paper item,
`.DS_Store` tolerated, Doctor still zero-write on a fresh library.

## Validation reproduced locally

- maintenance suite **29/29**, guard-static **84/84**, migrate-package **12/12**.
- full `scripts/tests/*.test.mjs` **220/243**; all 23 failures are `PROVENANCE_RUNTIME_NONCONFORMANT`
  (14 direct + 9 assertion-wrapped) because this machine runs Node 22.16.0 against a content runtime
  pinned to 22.23.1 — the identical set and cause as rounds 1 and 2.
- Guards yield 0 errors both with the P1-2a tree untracked and with a simulated fully-tracked index.
- Directory-mode divergence is fail-closed in every position I tested: root directory, nested directory,
  and individual file modes each produce `BACKUP_RESTORE_CONFLICT` on an already-present target.

## Remaining observations (all low, none blocking)

1. **`LIBRARY_INDEX_DRIFT_UNDETERMINED` is emitted for sources that are not authorities.** When
   `sourceDiagnosticAuthority` returns `key: null` (`:913`, e.g. `papers/_scratch`), nothing is skipped
   from the drift comparison, so "drift cannot be determined" is not actually true for that source — and
   a single junk directory now produces three error diagnostics for the same path. Correctly scoped, so
   this is report precision: consider emitting the undetermined diagnostic only when
   `authority.key` is non-null.
2. **A permission-only divergence is reported as a content difference.** `:728` says "Restore target
   exists with different content." for any `inventoryMatchesManifest` mismatch, including a file or
   directory mode change with identical bytes. Detection is correct; the message misdirects the operator.
   Splitting into a distinct code or mentioning modes in the message would save a debugging cycle.
3. **`backup.status` cannot express not-found or invalid.** The enum is still
   `missing | verified | stale`, so a nonexistent backup reports `stale` and only the blocker code
   (`MIGRATION_BACKUP_NOT_FOUND`) carries the truth. This follows the round-2 recommendation, so it is
   not a defect — but if the enum is going to be frozen at 1.0, adding `not_found` and `invalid` now is
   cheaper than later.
4. **`plan.doctor.payloadsVerified` is structurally always `false`** because `buildMigrationPlan`
   hardcodes the shallow depth (`:1361`). That is the right depth — an unrelated corrupt backup is
   irrelevant to migrating this paper, and the selected backup is verified explicitly — but the field can
   only ever be read as documentation, never as a signal.
5. **Fault injection is inlined rather than following the established helper shape.** `:576-577` checks
   `options.faultAt === 'after_payload_copy'` directly, where `generation-publication.mjs:434` uses a
   reusable `maybeFault(options, point)`. Additional fault points will accrete ad hoc. I confirmed
   `faultAt` is unreachable from every CLI entry point, so this is style only.
6. **`removeTreeForcingWritable` chmods and then reads a directory without re-checking `lstat`.** A
   concurrent replacement of the directory with a symlink between the two calls would redirect the chmod
   and the recursive delete. It only ever runs on a `.init-*` tree inside a private `0700` registry while
   the paper and index locks are held, so this is a nit rather than a vulnerability — worth one comment
   recording why it is safe.
7. **The lost-rename branch mislabels the outcome.** After swallowing `EEXIST`/`ENOTEMPTY` (`:614-617`)
   the function proceeds to verify and returns `reused: false`, although the surviving directory was
   published by another process. Cosmetic.

## Documentation accuracy

The updated summary and plan match the implementation on every point I checked. Invariant 8 now states
the drift contract explicitly ("Doctor compares every successfully projected authority even when
unrelated sources are damaged; unknown regions are explicit"), the plan documents the `.init-*`
permission normalization and the deliberate quarantine retention, and the round-2 disposition list
matches what the code actually does — including the two items scoped down rather than dropped
(`library-doctor` remains the authoritative full-payload check; journal pruning stays deferred to P1-7).

## Suggested disposition

- Nothing blocks handoff.
- Worth folding in before the 1.0 formats are frozen: observation 3 (`backup.status` enum).
- Opportunistic, in any later pass: observations 1, 2, 4, 5, 6, 7.
