# P0-C2b Code Review — Round 2 Findings

**Scope:** the reworked P0-C2b publication subsystem after the Round-1 dispositions recorded in `docs/P0-C2B_CODE_REVIEW_SUMMARY.md` ("First review disposition").
**Reviewed at:** medium effort, focused finders on the reworked surfaces (staging re-entrancy, new manifest helpers, journal-diagnostic handling), plus manual verification of the two surviving findings.
**Round-1 result reference:** `docs/P0-C2B_CODE_REVIEW_RESULT.md`.

## Verdict

The Round-1 fixes hold. Both **critical** defects (C1 manifest sort order, C2 non-atomic staging) and the **high** availability-coupling defects (C3/C4/C5) are correctly addressed, and the medium items (C6/C7/C8) are resolved as claimed. Round 2 found **two residual defects** introduced/left by the rework — one high (a sealed-package invariant can be silently skipped on crash recovery), one medium (a corruption class still aborts the whole workspace listing). Neither can strand a payload permanently, but the high one violates the published read-only invariant.

---

## Round-1 fixes — verified correct

| ID | Claim | Verification |
|----|-------|--------------|
| C1 | Global path-sort of inventory | `inventoryGenerationFiles` now `sort`s by full path (`generation-manifest.mjs:54`); the `<`/`>` comparator matches `validateGenerationManifest`'s default `Array.sort` (both UTF-16 code-unit order) for every `safeSegments`-legal path. Dedicated regression test at `generation-publication.test.mjs:235`. **Confirmed.** |
| C2 | Re-entrant new-paper staging | The staging block (`generation-publication.mjs:431-479`) now guards each step on its own on-disk existence, validates a pre-existing staged payload/record/current instead of blindly re-staging, and tolerates a detached workspace. All six crash-window re-runs traced converge. New fault point `after_new_payload_staged` + test at `:249`. **Confirmed.** |
| C3/C7 | Corrupt journal isolated | `recoverPublications` (`:528-554`) wraps each journal read in try/catch and reports a failed result instead of aborting the batch; `descriptor()` marks parse/state failures `publicationInvalid` with a bounded diagnostic. Test at `:262`. **Confirmed** (except the symlink sub-case — see R2 below). |
| C4 | Index rebuild per-entry isolation | `buildManagedIndexEntries` (`:296-346`) wraps each record in try/catch, skips with a diagnostic in non-strict mode; `strict` is never set true by any in-repo caller. Test at `:288`. **Confirmed.** |
| C5 | Cheap listing tier | Index build now uses `verifyGenerationManifestBinding` (manifest-file hash only, `:303`) and `readManifestBoundFile` (hashes only `meta.json`, `:306`), not a full-package rehash. Full-content `verifyGenerationManifest` is reserved for authoritative resolution (`descriptorForRecord`, `resolveExplicitPackage`) — the deliberate drift boundary. **Confirmed.** |
| C6 | No journal state regression | The catch handler re-reads the newest persisted journal (`readJournal(workspace) || journal`, `:518`) before appending diagnostics, so an advanced state cannot be rewritten backward. `slice(-32)` keeps diagnostics within the validated bound. **Confirmed.** |
| C8 | Explicit unseal helper | `unsealGenerationPackageForLifecycle` (`generation-manifest.mjs:174`) requires `options.authorized === true`, rejects symlinks/special files, and restores `0o700`/`0o600`. Test at `:310`. **Confirmed** (minor path-canonicalization note under R2-b). |
| cleanup | Shared `deriveManifestId`, `manifestBinding`, `overlayState` | `sealWorkspacePackage` now calls `deriveManifestId` (`:161`); all binding sites route through `manifestBinding()`; the staging branch calls `overlayState(stagingDir, pendingTags)` (`:457`). Broad `stableJson`/`sha256` consolidation explicitly deferred to P1-3. **Confirmed.** |

---

## Residual findings

### R1 — `sealPermissions` is skipped on crash-recovery re-entry; a published package can stay world-mutable (HIGH)

`sealPermissions(target|targetInStaging)` runs **only inside** the `if (!fs.existsSync(target))` / `if (!fs.existsSync(targetInStaging))` rename block:

- recordExists branch: `generation-publication.mjs:413-419` (seal at `:418`).
- new-paper branch: `generation-publication.mjs:440-449` (seal at `:445`).

There is no fault-injection point — and, more importantly, no protection against a **real** crash (kill/power loss) — between `fs.renameSync(...)` and `sealPermissions(...)`. If the process dies in that window, the payload is renamed into place but left at its authoring permissions (`0o700`/`0o600`).

**Failure:** on re-run, `fs.existsSync(target|targetInStaging)` is now true, so the entire block — including `sealPermissions` — is skipped. Execution proceeds to `verifyGenerationManifest` (which only checks content, not mode) and commits `current.json`. The generation becomes Viewer-visible and authoritative while its files remain writable, permanently violating the "published packages are read-only / fail closed" contract (summary line 13). No code path ever re-seals an already-present package.

**Fix:** call `sealPermissions` unconditionally after ensuring the payload is in place (it is idempotent — re-chmod to `0o500`/`0o400` is harmless), i.e. move it out of the `if (!exists)` guard in both branches. A test that publishes, manually relaxes the package mode, then re-runs recovery and asserts the sealed mode would lock this.

### R2-a — Symlink/special-file publication journal aborts the entire workspace listing (MEDIUM)

In `descriptor()` the journal safety check sits **before** the try that classifies corruption:

```
generation-workspace.mjs:159   const journalStats = fs.lstatSync(publicationJournal)
generation-workspace.mjs:160   if (journalStats.isSymbolicLink() || !journalStats.isFile()) throw WORKSPACE_PATH_UNSAFE
generation-workspace.mjs:161   try { ...parse... } catch { publicationState = 'invalid'; ... }
```

**Failure:** if any one workspace has `publication.json` as a symlink or special file (fifo/device), `descriptor()` throws `WORKSPACE_PATH_UNSAFE` uncaught. `listGenerationWorkspaces` re-runs `descriptor()` for every workspace, so this aborts enumeration of *all* workspaces — and therefore `recoverPublications` (`:531`) fails as a batch before producing any per-item result. This is the same batch-abort failure mode that C3 fixed for corrupt/oversized journals, but the symlink/special-file class still escapes the soft-diagnostic path. Inconsistent handling of two corruption classes on the same file.

**Fix:** fold the symlink/non-regular-file check into the same soft path — mark it `publicationInvalid` with a diagnostic rather than throwing — so a poisoned journal file of any kind isolates to one workspace instead of aborting the listing.

### R2-b — `unsealGenerationPackageForLifecycle` does not canonicalize its root path (LOW / forward-looking)

`unsealGenerationPackageForLifecycle` (`generation-manifest.mjs:174-194`) `lstat`s only `packageDir` itself for a symlink; it does not canonicalize parent components the way `requireNoFollowDirectory` does elsewhere. If a future caller passes a path with a symlinked ancestor, the walk would chmod through the link. There is **no caller in the source tree today**, so practical impact is nil — flagging only for consistency with the no-follow discipline the rest of the module enforces. If/when P1-7 wires this into retention/GC, resolve the root through `requireNoFollowDirectory` first.

---

## Cleared during Round 2 (not defects)

- Inventory sort determinism (`<` vs `.sort()`) — identical order for all legal paths; build/validate/verify agree.
- Index build is now genuinely cheap and per-entry isolated; `strict` mode is never enabled by in-repo callers.
- `recoverPublications` no longer double-processes or batch-aborts on JSON/validate journal errors (only the R2-a symlink class escapes).
- Catch-handler diagnostics cannot overflow the validated bound or throw on re-persist.
- `'invalid'` publicationState is consistent between `descriptor()`/`isActiveGenerationWorkspace` and the eventual `readJournal` rejection during recovery.
- Staged `current.json` re-validation deliberately excludes `publishedAt` from equality, so retry timestamp drift does not cause a false `PUBLICATION_RECORD_CONFLICT`.
- Second-generation republish takes the recordExists branch; only the `package` leaf is sealed, so `recordDir` root and the `sources/<sha>/generations/<gen>` chain stay `0o700` and writable.

---

## Recommendation

R1 should be fixed before M2 closes — it is a silent breach of the published read-only invariant reachable by an ordinary crash, not just fault injection, and the one-line move of `sealPermissions` out of the existence guard is low-risk. R2-a is worth fixing in the same pass for corruption-handling consistency. R2-b is a forward-looking note for whoever wires the unseal helper into a real lifecycle path (P1-7).
