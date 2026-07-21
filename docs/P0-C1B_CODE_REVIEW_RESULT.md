# P0-C1b Code Review Result

Reviewer: automated code review (Claude, with a consumer-side sub-review agent)
Date: 2026-07-21
Branch: `codex/audit-optimizations-2026-07-10`
Scope: multi-generation library layout — `src/shared/paper-library.mjs` (new resolver), `prepare-paper.js` integration, Viewer server routes/utils, skill-script consumers, schemas, and ADR 0003.

## Verdict

**Approve with one fix requested.** The design is implemented faithfully and the security posture (no-follow, realpath containment, symlink rejection, fail-closed current resolution, legacy read-only, overlay isolation) is strong and well-tested. I found **one real defect** (a `TypeError` on a rare route-slug fallback path, B1 below) that should be fixed before merge, plus one cross-cutting hardening gap and several nits. None of these block the core invariants, but B1 is a latent crash on an edge input.

## Verification (reproduced locally)

| Suite | Result | Notes |
| --- | --- | --- |
| `library-layout.test.mjs` | 2/6 pass locally; **4 fail environmentally** | tests 3 (legacy read-only) & 6 (reconciliation convergence) don't spawn the parser and pass; tests 1,2,4,5 fail only because PyMuPDF (`fitz`) is absent in this sandbox — confirmed via the `pdf_parse_failed: PyMuPDF unavailable / No module named 'fitz'` error. Not regressions. |

Same environmental caveat established in C1a review applies: `scripts/codex-paper.sh` guards these via `ensure_pymupdf`. The 6/6 claim is credible in a PyMuPDF-equipped environment.

## Findings

### B1 — `identity.generation.fingerprint.slice` throws (blocking-ish, requested fix)

`prepare-paper.js:361`
```js
const generationSuffix = identity.generation.fingerprint.slice(0, 12);
```
`identity.generation.fingerprint` is an **object** `{ algorithm, value }` (`paper-identity.js:263`), not a string. This line should be `identity.generation.fingerprint.value.slice(0, 12)`. As written it throws `TypeError: fingerprint.slice is not a function`.

- **Reachability:** third-tier route-slug fallback in `allocateRouteSlug` — reached only when the base slug is taken AND the `<baseSlug>-<sourceSha[:12]>` candidate is also taken. Rare, but reachable (same title + colliding source-hash prefix already in `used`). Instead of allocating the intended generation-suffixed slug, prepare crashes.
- **Not covered by any test** — the route-allocation tiers aren't exercised. Recommend fixing and adding a test that forces two collisions.

### H1 — Legacy read-only is bypassable via explicit absolute path (non-blocking, hardening)

`resolveExplicitPackage` (`paper-library.mjs:305-312`) returns `{ mode: 'explicit_path', readOnly: false }` for any input containing a path separator. If that absolute path points at an in-library **legacy** package (`~/codex-papers/papers/foo`), the descriptor is writable, so `scaffold-reasoning-analysis.js`, `render-from-analysis.js`, and `sandbox-code.js` would mutate/execute a legacy package — contradicting invariant "legacy packages are never mutated."

- The validation scripts are already protected: `canWriteValidationReport` independently rejects any path under `<library>/papers` (`validation-report.js`). This creates an **inconsistency** — validation is path-hardened, but scaffold/render/sandbox trust `descriptor.readOnly` alone.
- Reachable only via deliberate path addressing; slug-based access is safe. Recommend a `canWriteValidationReport`-style guard (or making `resolveExplicitPackage` detect in-library-legacy paths and mark them read-only) so the policy is uniform.

### Consumer-side integration — clean (verified by sub-review)

- All Viewer routes and skill scripts route through `resolveLibraryPaper` / `resolveExplicitPackage`; no direct `papers/<slug>` reconstruction remains. `paperAccess.ts` deletion left no dangling imports; descriptor fields (`packageDir` / `generationDir` / `paperRoot` / `overlayDir`) are used consistently.
- Overlay mutations (tags, chat notes) write only to `overlay/`; generation packages are never touched. `ask.post.ts`, `tags.patch.ts`, `chatNotes.ts` confirmed.
- Legacy packages are 409-blocked on write paths via `assertWritableDescriptor`; `render`/`scaffold`/`migrate` refuse legacy/managed appropriately; `sandbox-code.js` forces `nonconformant` on read-only and cannot obtain an approval token for legacy.
- Trash/restore correctly trashes the whole managed record (incl. overlay), uses containment checks, tombstone v2.0.0 rejects `..`, and keys index removal/restore on `storageKey`/route aliases. Lock order in `restore.post.ts` (`[paperLockKey, trash:<id>, index]`) is sound.

## Invariants — confirmed

- **Stable paperKey.** `derivePaperKey(paperId)` is called only on first creation; reconciliation spreads `...record` and never re-derives the key. Test 6 asserts local-first vs canonical-first keep distinct, stable keys while converging aliases/primary. ✓
- **`current.json` authoritative + fail-closed.** `validateCurrentRecord` recomputes the expected package path and rejects mismatches; `descriptorForRecord` cross-checks the on-disk identity against `current` and record aliases (`CURRENT_IDENTITY_MISMATCH`). Tests 2 & 5 confirm tamper/symlink rejection. ✓
- **Generation/overlay separation.** New generation becomes current without touching overlay or old package (test 4: old package snapshot unchanged, `tags:['preserved']` survives). ✓
- **Zero-write exact reuse; older reuse doesn't switch current.** `validateReusableGeneration` is read-only; `reused` returns before any write; test 4's `reusedOld` keeps `current` pointing at the newer generation. ✓
- **No-follow / realpath containment everywhere.** `requireNoFollowDirectory` walks each segment rejecting symlinks then realpath-contains; `readJsonNoFollow` uses `O_NOFOLLOW` + `fstat` regular-file check + size cap; writes are atomic temp+rename with post-rename symlink recheck. ✓
- **Explicit, bounded reconciliation.** Requires `--reconcile-identity <route>`; `reconciliations` capped at 256; audited entries; may promote a higher-`canonicalRank` primary (doi>arxiv>source) without moving storage. ✓
- **Atomic index write.** `writeIndexPreserveShape` switched to `O_EXCL` temp + `rename` (was `O_TRUNC` in place) — an improvement. ✓

## Nits (non-blocking)

- `librarySecurity.mjs`: `resolveWritablePaperFile` is now dead code (zero callers). `HIDDEN_MACHINE_FILES` still lists the old `.codex-paper-trash.json` after the rename to `tombstone.json` — stale, harmless.
- `tags.patch.ts` rollback writes a default overlay `state.json` even when none existed originally — benign.
- `canonicalRank` tie-break for two same-kind canonical IDs (e.g. two DOIs) keeps the first-pinned primary rather than a deterministic min; acceptable "first pin wins", but worth a one-line comment.
- `chatNotes.ts` assumes `overlayDir` exists (guaranteed by prepare creating it); a managed record missing its overlay dir would ENOENT rather than a typed error — minor.

## Scope discipline

Correctly defers cross-process locks, generation workspaces, shared transactional writer, manifest sealing, post-publication immutability, gate-driven publish, and crash recovery to P0-C2a/C2b; migration/doctor/reindex/backup to P1-2. ADR 0003 states these residual single-process multi-file crash windows explicitly. No scope leakage.

## Recommendation

Fix **B1** (one-character-class fix: `.fingerprint.value.slice`) and add a route-collision test before merge. Consider **H1** hardening now or track it as a P0-C2 follow-up with an explicit note (the validation-vs-scaffold inconsistency is the concerning part). Everything else is nits. After B1, this is merge-ready pending CI in a PyMuPDF-equipped environment. Parent P0-C1 should not be marked `Review 完成` until B1 is resolved.
