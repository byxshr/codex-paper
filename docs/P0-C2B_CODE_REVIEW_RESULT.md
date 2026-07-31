# P0-C2b Code Review — Findings

**Scope:** the uncommitted P0-C2b publication subsystem.
**Reviewed at:** medium effort, 8 finder angles → single-vote adversarial verify.
**Primary files:**

- `plugins/codex-paper/src/shared/generation-publication.mjs` (new)
- `plugins/codex-paper/src/shared/generation-manifest.mjs` (new)
- `plugins/codex-paper/skills/study/scripts/publication-cli.js` (new)
- `plugins/codex-paper/src/shared/paper-library.mjs` (changed)
- `plugins/codex-paper/src/shared/generation-workspace.mjs` (changed)
- `plugins/codex-paper/src/shared/workspace-writer.mjs` (changed)
- `plugins/codex-paper/skills/study/scripts/validation-report.js` (changed)

**Verdict:** the fs-driven idempotent design is sound in its general shape and handles the four injected `maybeFault` points, but two defects can make a legitimate generation **permanently unpublishable**, and three more create **library-wide availability coupling**. These should be fixed before M2 closes.

---

## Correctness (blocking)

### C1 — Manifest inventory order can never match the validator's required order (CRITICAL)

`generation-manifest.mjs:40` `inventoryGenerationFiles` walks the tree depth-first, sorting **entry names within each directory**. `generation-manifest.mjs:111` `validateGenerationManifest` then requires the emitted `files[].path` list to already equal its own **global lexicographic sort** (`paths.sort()`).

These two orders diverge whenever a directory name is a prefix of a sibling file name and the file's next character sorts below `/` (0x2F) — e.g. a `notes/` directory beside a `notes.md` file (`.` = 0x2E < `/`). Per-directory DFS emits `["notes/x", "notes.md"]`; the validator wants `["notes.md", "notes/x"]`.

**Failure:** a package containing `notes/` + `notes.md` (or `data/` + `data.json`, `figures/` + `figures.md` — all realistic in generated study output) throws `GENERATION_MANIFEST_INVALID` at `buildGenerationManifest`. That generation can **never** be sealed or published.

**Fix:** sort the assembled `files` array by full path (default string sort on `path`) before returning from `inventoryGenerationFiles`, so it matches the validator's invariant. Add a fixture with a dir/file-sibling ordering conflict.

### C2 — New-paper staging is non-atomic; a crash mid-staging strands the payload permanently (CRITICAL)

`generation-publication.mjs:417-433` (new-paper branch). The re-entry guard is `if (!fs.existsSync(stagingDir))`, but the block first renames the payload into staging (`:422`) and only *then* writes `paper.json`/`overlay`/`current.json` (`:426-428`). A real crash (kill/power loss) between `:422` and `:426` leaves `stagingDir` present but missing `paper.json`.

**Failure:** on re-run, `workspace.packageDir` is `null` (payload already moved → `publicationDetached`). `existsSync(stagingDir)` is true, so the population block is skipped; `:433` renames the incomplete staging to `recordDir`; `:436` `readPaperRecord(recordDir)` throws `ENOENT`. Every subsequent re-run hits `:412-414` (recordDir non-empty, no staging) → permanent `PUBLICATION_RECORD_CONFLICT`. The payload is detached and unrecoverable.

**Fix:** make staging population idempotent/repairable — e.g. treat a staging dir that lacks `paper.json` as re-populatable, or only rename the payload into staging *after* the record files are written, or complete the record files in-place on re-entry instead of guarding solely on `existsSync(stagingDir)`.

### C3 — One corrupt publication journal aborts recovery of every workspace (HIGH)

`generation-publication.mjs:477-480` `recoverPublications` calls `readJournal(item)?.state` **inside an `Array.filter` callback**. `readJournal` throws `PUBLICATION_JOURNAL_INVALID` on corrupt/oversized/schema-drifted journals.

**Failure:** one workspace with a poison `publication.json` makes the filter throw, so `recoverPublications` rejects before *any* healthy workspace is retried. Crash recovery is globally blocked until the bad journal is manually removed — the opposite of what a recovery routine should do.

**Fix:** wrap per-item journal reads in try/catch inside the filter (or the loop), classifying unreadable journals as failed results rather than propagating.

### C4 — One dirty managed paper blocks all publishing and all reindex (HIGH)

`generation-publication.mjs:294-327` `buildManagedIndexEntries` calls `verifyGenerationManifest` (full-content re-hash + `GENERATION_MANIFEST_DIRTY` on drift) for every managed record with **no per-entry isolation**. `commitPublicationLocked` rebuilds the whole index as its final step (`:443`), and `rebuildLibraryIndex` reuses the same path.

**Failure:** a single package that drifts from its manifest (a stray `.DS_Store`, AV/backup touch, etc.) throws and kills `writeRebuiltIndexLocked`. That means **no new paper can be published** and `reindex` fails library-wide until the one bad paper is repaired.

**Fix:** isolate per-entry failures — skip/quarantine a dirty record and surface it as a diagnostic, rather than aborting the entire index build. Consider verifying only `manifestFileSha256` (cheap) during index build (see C5).

### C5 — Managed reads full-hash the entire package on every access and fail closed (HIGH)

`paper-library.mjs:288` `descriptorForRecord` now runs `verifyGenerationManifest` (which re-reads and re-hashes all package bytes via `inventoryGenerationFiles`) on **every** managed-paper read. This is the web read hot path (`resolveLibraryPaper` → paper detail / meta / ask / file routes).

**Failure:** (a) latency — listing/reading N papers re-hashes O(total-bytes) of all packages, up to 5000 files × 512 MB each, on every request/reindex; (b) availability — any content drift makes *every* read **and** every overlay/annotation write of that paper fail with 409 `GENERATION_MANIFEST_DIRTY`.

**Fix:** split verification tiers. For listing/read, verify the small manifest file against `manifestFileSha256` (already recorded, cheap). Reserve full-content `inventoryGenerationFiles` verification for explicit integrity/resolve operations, not every read.

---

## Correctness (non-blocking, should fix)

### C6 — Failure handler regresses the on-disk journal state (MEDIUM)

`generation-publication.mjs:463-469`. `commitPublicationLocked` advances the journal on disk (`:402/:440/:444`) but only reassigns its **local** `journal` param; the outer `journal` in `publishGenerationWorkspace` stays at its pre-commit value. On any thrown error the catch writes `{...journal, diagnostics}` (`:468`), rewriting the disk journal **backward** (e.g. `current_committed` → `prepared`).

**Impact:** fs-driven recovery still converges, so this is not a convergence break, but `journal.state` becomes non-monotonic and unreliable for monitoring/observers, and diagnostics land on the wrong state. `validateTransaction` does not reject the regression.

**Fix:** re-read the journal before appending diagnostics, or have `commitPublicationLocked` return the latest journal and use it in the catch.

### C7 — Corrupt journal is silently misclassified as an active, recoverable workspace (MEDIUM)

`generation-workspace.mjs:155-158` `descriptor()` parses the journal state inside `try { ... } catch {}`, swallowing all errors and leaving `publicationState = null`. `isActiveGenerationWorkspace` (`:122-124`) then treats `null !== 'index_committed'` as active.

**Failure:** a truncated/oversized `publication.json` → `publicationState = null` → the workspace is reported active + read-only, blocks a fresh workspace with `WORKSPACE_EXISTS`, yet `recoverPublications`/`publishGenerationWorkspace` will later throw `PUBLICATION_JOURNAL_INVALID` via `readJournal`. The generation is wedged with no non-manual escape, and the corruption is hidden from listers.

**Fix:** don't swallow — on parse failure raise `WORKSPACE_PATH_UNSAFE`/an invalid-journal code (or surface a diagnostic), consistent with how `readJournal` treats the same file.

### C8 — Sealed packages (dirs at 0o500) cannot be deleted by later cleanup (MEDIUM)

`generation-publication.mjs:271-282` `sealPermissions` chmods every package directory to `0o500`. Removing entries inside a directory requires **write** on that directory, so recursive deletion of a sealed tree fails `EACCES`. No code un-seals a package.

**Impact:** forward-looking hazard for P1-7 retention/GC and for rollback of a failed transaction that left a sealed staging tree — cleanup must `chmod -R` first or it silently fails. Review-summary item #6 explicitly asks to confirm sealing "does not make test or retention cleanup silently destructive"; today it makes cleanup fail closed rather than destructive, but it does block it.

**Fix:** document/centralize an un-seal helper for lifecycle ops, or seal files (`0o400`) while leaving directory write intact if traversal-immutability is the only requirement.

---

## Cleanup / quality (non-blocking)

- **Duplicated manifest-id formula.** `generation-publication.mjs:159` inlines `` `gm-sha256-${sha256(stableJson({paperKey, generationId, validationReportHash}))}` `` instead of calling the exported `deriveManifestId` (`generation-manifest.mjs:57`) that computes the identical value. Silent drift risk if the id formula changes. Import and call `deriveManifestId`.
- **Triplicated `stableJson`/`sha256`/`stableValue`.** Defined in `generation-manifest.mjs:15-27`, again in `validation-report.js`, and the sha256 pattern in `paper-library.mjs`. Divergence silently invalidates cross-boundary hashes. Extract one shared stable-hash module.
- **Inline manifest-binding literals.** The `{manifestId, manifestHash, manifestFileSha256, paperKey, generationId}` binding is hand-written at `:173`, `:400`, `:461` although `manifestBinding()` (`:284`) already builds exactly this shape. Route all sites through it.
- **Duplicated default-overlay literal.** `:427` rebuilds `{schemaVersion:'1.0.0', tags, progress:{}, annotations:[]}` instead of calling `overlayState(stagingDir, pendingTags)` (`:227-235`). The two overlay shapes can drift.
- **Unreachable `'failed'` state.** `'failed'` is in `TRANSACTION_STATES` (`:41`) but nothing ever writes it, so a deterministically-failing publish is retried by `recoverPublications` forever with no terminal quarantine. Either wire a give-up path or drop the dead state.
- **Terminal residue leak.** After `index_committed` the workspace keeps `publication.json` (payload already moved), so it stays `publicationResidue`/`readOnly` forever and `assertRouteAvailable`'s pending scan (`:259-266`) still enumerates it. `recoverPublications` filters it out but never removes it. (P1-7 owns lifecycle, but worth an explicit note/TODO.)

---

## Cleared during review (not defects)

- `verifyGenerationManifest:149` `JSON.stringify(actual) !== JSON.stringify(manifest.files)` — safe: both sides come from `inventoryGenerationFiles` with identical key/array order, and `atomicWriteJson` preserves insertion order.
- `currentRecord`'s `packageRelativePath` (`:218`) equals `journal.targetPackageRelativePath` — both derive from the same validated `sourceRevisionId`/`generationId`.
- `.publish-*` staging-skip regex in `listManagedRecords:248` correctly matches the `existingPublicationState` naming; `rebuildLibraryIndex:498` independently filters to `^p-[a-f0-9]{64}$`, so both paths skip staging consistently.
- `validateCurrentRecord`'s all-or-nothing manifest-binding check correctly preserves back-compat for fully-absent bindings (a partial binding is intentionally rejected — see note below).
- New `publicationResidue` guards in `requireWritableWorkspace`, `updateWorkspaceRecordLocked`, `transitionWorkspaceToAuthoringLocked`, and `writeWorkspaceAuthoring` cover the nullable `packageDir` mutation call sites — no null-deref found.

> Note on `validateCurrentRecord` (`paper-library.mjs:206-216`): the "any-field-present → all-fields-required" rule means a record with a manifest id but a missing/malformed `publishedAt` becomes unresolvable rather than degrading. Acceptable given P0-C2b always writes the full binding, but worth confirming no migration path produces a partial record.

---

## Recommendation

Fix **C1** and **C2** before M2 closes — both can permanently strand a real generation. **C3–C5** are availability regressions where one bad record degrades the whole library; fix before relying on recovery/reindex in production. **C6–C8** and the cleanup items can follow but should not be lost.
