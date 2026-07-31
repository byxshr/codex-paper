# P0-A1 Code Review Result

## Review metadata

- Work item: `P0-A1` — local service, destructive operations, and path boundaries
- Branch: `codex/audit-optimizations-2026-07-10`
- Review date: 2026-07-11
- Reviewer: independent security-focused code review (Claude)
- Baseline: committed S0-1 state at `e2c44eb`
- Scope: the files enumerated in `docs/P0-A1_CODE_REVIEW_SUMMARY.md`, read in full

## Verdict

**Approve with non-blocking findings.**

The security model is sound and matches the invariants the handoff claims. Loopback binding, Host/Origin gating, session + CSRF enforcement, single-use delete confirmation, shared no-follow path resolution, fail-fast locks, and recoverable trash are all implemented coherently and covered by tests. The findings below are hardening and robustness items, not exploitable holes within the stated single-user local threat model. None block delivery.

## What was verified independently

- Every `/api/**` route file was read; all read routes go through `librarySecurity.mjs` resolvers and all mutating routes (`ask`, `tags`, `delete`, `delete/prepare`, `trash restore`) are `POST`/`PATCH`/`DELETE` and therefore hit the CSRF branch of `middleware/00-security.ts`.
- `middleware/00-security.ts` allows exactly `GET /api/health` and `POST /api/session/pair` before a session; everything else requires the session cookie and populates `event.context.codexPaperSession`.
- `sessionSecurity.mjs` uses constant-time SHA-256 digest comparison for both the pairing token and CSRF token, generates 256-bit secrets, and enforces a per-window pairing failure bucket.
- `librarySecurity.mjs` performs double percent-decoding, rejects absolute paths / `.` / `..` / empty segments / backslash / NUL, does per-segment `lstat` symlink rejection, realpath containment, and `O_NOFOLLOW` reads. The triple-encoded case (`%252e%252e%252fsecret`) resolves to `../secret` on the second decode and is rejected.
- `operationLocks.mjs` sorts keys deterministically and fails immediately (409) on any conflict; `withOperationLocks` releases in `finally`.
- `trashManager.mjs` delete/restore transactions and both index shapes (array and `{papers:[]}`) behave as described.
- The existing test suite (`scripts/tests/viewer-security.test.mjs`) covers pairing, rate limit, one-use confirmation, traversal/symlink rejection, size/tree budgets, lock conflicts, and trash round-trips including the injected index-rename failure.

## Findings

### Non-blocking — recommended fix

**N1. Delete rollback is skipped if the tombstone write itself fails**
`plugins/codex-paper/src/web/server/utils/trashManager.mjs:53-63`

```js
fs.renameSync(paperDir, trashDir)
try {
  writeJsonAtomic(path.join(trashDir, TOMBSTONE), tombstone)   // (a)
  writeLibraryIndex(indexState, nextPapers, options)           // (b)
} catch (error) {
  try {
    fs.unlinkSync(path.join(trashDir, TOMBSTONE))              // throws ENOENT if (a) failed
    fs.renameSync(trashDir, paperDir)                          // never reached in that case
  } catch {}
  throw error
}
```

If step (a) fails (e.g. `ENOSPC`, or `trashDir` transiently not writable), the tombstone file does not exist. In the catch block, `fs.unlinkSync` then throws `ENOENT`, which aborts the inner `try` **before** the directory rename-back runs, and the inner `catch {}` swallows it. Result: the paper is stranded in `.trash/<trashId>` with no tombstone, and because `index.json` was not yet updated, the index still references a slug whose directory is gone. `listTrash` skips entries with an invalid/missing tombstone (`requireTrashEntry` → 422), so the paper is no longer visible or restorable through the UI — only recoverable by hand.

This is the only asymmetry with the restore path: `restoreTrashEntry` (`trashManager.mjs:125-131`) already guards its recreate with `if (!fs.existsSync(...))` and then renames back, so its rollback is robust. Mirror that pattern here — do not let a failed/absent tombstone unlink block the directory rename-back:

```js
} catch (error) {
  try { fs.unlinkSync(path.join(trashDir, TOMBSTONE)) } catch {}
  try { fs.renameSync(trashDir, paperDir) } catch {}
  throw error
}
```

Impact is bounded (rare failure, data not destroyed, manually recoverable), which is why it is non-blocking — but it is a genuine gap in the "delete is always rollback-safe" invariant and is worth fixing before this ships as the destructive-operation guarantee.

### Non-blocking — hardening

**N2. `writeFileAtomic` temp file is not opened exclusively / no-follow**
`plugins/codex-paper/src/web/server/utils/librarySecurity.mjs:226-236`

The temp file is written with `fs.writeFileSync(temporary, content, { mode })`. If a pre-existing symlink occupied the temp path, the write would follow it. The temp name includes `process.pid` and 8 random bytes, so this is not practically exploitable by a same-user attacker and irrelevant to the remote threat model, but for defense-in-depth consider `fs.openSync(temporary, 'wx' | O_NOFOLLOW)` (fail if exists / do not follow) to match the no-follow discipline used everywhere else.

**N3. `confirmations` map has no size cap (minor local DoS surface)**
`plugins/codex-paper/src/web/server/utils/sessionSecurity.mjs:115-122`

`sessions` is bounded to `MAX_SESSIONS = 8`, but `confirmations` is only pruned by expiry (`purgeConfirmations`). A paired client could call `delete/prepare` repeatedly and hold up to (creation rate × 120 s) live confirmation entries. This requires an already-valid session and self-inflicts only on the local process, so severity is low. A hard cap (evict oldest, as sessions does) would make the bound explicit. Reviewer focus area 3 asked for DoS bounds — this is the one place a bound is implicit rather than enforced.

**N4. Host/Origin check is exact on the configured port; non-default HTTP ports change the Host header shape**
`plugins/codex-paper/src/web/server/utils/sessionSecurity.mjs:54-63`

`isAllowedHost` compares against `127.0.0.1:<PORT>` / `localhost:<PORT>`. This is correct for the default 5815 deployment. Note for operators: if `PORT` were ever set to 80, browsers omit the port from the `Host` header (`127.0.0.1`, not `127.0.0.1:80`) and every API call would 403. Not a bug for the shipped configuration; worth a one-line comment or a normalization branch if configurable ports are a supported path.

### Informational — confirms stated exclusions

**I1. Notebook / HTML / SVG rendering is a live active-content sink (already assigned to P0-A2)**
`plugins/codex-paper/src/web/server/api/papers/[slug]/file.get.ts:66-121` and `raw.get.ts:9-19`

`renderNotebookToHtml` interpolates notebook `text/html`, `image/svg+xml`, and markdown cell `source` into the returned HTML string without sanitization; `raw.get.ts` serves `.svg` as `image/svg+xml`. A maliciously crafted paper package would achieve stored XSS in the Viewer. The handoff explicitly defers active-content sanitization to P0-A2, so this is **not** a P0-A1 defect — recording it here only to confirm the boundary is understood and that `raw.get.ts` sends `X-Content-Type-Options: nosniff` but no CSP or `Content-Disposition`, which P0-A2 should address.

**I2. Prerender bypass is build-time only**
`middleware/00-security.ts:15`, `plugins/security-init.ts:4`

`import.meta.prerender` is a compile-time constant; at runtime in the production server it is `false`, so the bypass is unreachable by HTTP. `session.get.ts` dereferences `event.context.codexPaperSession.csrfToken` unconditionally, which is safe because the middleware guarantees the session is set before that route runs (the only bypass, prerender, does not serve live API traffic). Confirms reviewer focus area 1.

## Checks independently reasoned through

- Traversal / encoding vectors in `normalizeRelativePath` (double-decode, backslash, absolute POSIX/Win32, empty/`.`/`..` segments) — all rejected.
- Symlink rejection at papers root, paper dir, each nested segment, final open (`O_NOFOLLOW` → `ELOOP` → 403), writable targets, index, trash root, trash entry, tombstone, and chat notes — all covered.
- One-use, session/slug-bound, TTL-bound delete confirmation; token deleted on consume regardless of match, preventing replay.
- Lock key ordering (`paper:<slug>` + `index` for delete/tags; `trash:<id>` + `index` for restore; `paper:<slug>` for ask) sorted deterministically → no lock-order interleave; conflicts fail fast at 409.
- Object-shaped vs array-shaped `index.json` preserved through delete and restore.

## Residual risks accepted or reassigned

- Sessions, confirmations, failure buckets, and locks are process-local and reset on restart (accepted; documented).
- Active-content sanitization (HTML/Markdown/Notebook/SVG/iframe) → **P0-A2** (see I1).
- Generated-code execution sandboxing → **P0-A3**.
- Cross-process locking and full multi-file transaction protocol → **P0-C2**.
- Trash retention / permanent purge → **P1-7**.
- Dependency (`npm audit`) remediation → **P1-3**.

## Recommendation

Ship after applying **N1** (delete rollback robustness). N2–N4 can be folded into P0-A2/P0-C2 hardening. The implementation otherwise meets every security invariant claimed in the handoff.
