# P0-A1 Code Review — Round 2

## Review metadata

- Work item: `P0-A1` — local service, destructive operations, and path boundaries
- Branch: `codex/audit-optimizations-2026-07-10`
- Review date: 2026-07-11
- Round: 2 (follow-up to `docs/P0-A1_CODE_REVIEW_RESULT.md`)
- Reviewer: independent security-focused code review (Claude)
- Scope: verification that Round 1 findings N1–N4 were correctly resolved, plus a fresh pass over the changed code for regressions introduced by the fixes

## Verdict

**Approve.**

All four Round 1 findings (N1–N4) are fixed correctly, each with a dedicated regression test. The fixes did not introduce new defects. No blocking or non-blocking findings remain. The remaining items below are informational only and are already assigned to later work items.

## Round 1 findings — resolution status

| ID | Round 1 finding | Status | Evidence |
|---|---|---|---|
| N1 | Delete rollback skipped when tombstone write fails | **Fixed** | `trashManager.mjs:58-61` — `unlink` and `rename` are now in independent `try/catch` blocks, so an absent tombstone can no longer block the directory rename-back. Restore path (`:124-131`) mirrors the same pattern and now uses `writeFileAtomic`. |
| N2 | `writeFileAtomic` temp file not opened exclusively / no-follow | **Fixed** | `librarySecurity.mjs:232-237` — temp file opened with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, written by descriptor, closed, then renamed. Covered by test `atomic writer uses exclusive and no-follow temporary files`. |
| N3 | `confirmations` map had no size cap | **Fixed** | `sessionSecurity.mjs:8,129-131` — `MAX_CONFIRMATIONS = 256` with oldest-first eviction, matching the `sessions` bound. Covered by the 257-entry eviction assertion in the pairing test. |
| N4 | Host/Origin exactness broke on non-default ports | **Fixed** | `sessionSecurity.mjs:55-71` — `isAllowedHost` adds bare `127.0.0.1`/`localhost` when `PORT === '80'`; `isAllowedOrigin` strips `:80` from the authority. Covered by the port-80 assertions in the pairing test. |

## Verification of the fixes (independent reasoning)

### N1 — delete/restore rollback

The corrected `movePaperToTrash` catch block:

```js
} catch (error) {
  try { fs.unlinkSync(path.join(trashDir, TOMBSTONE)) } catch {}
  try { fs.renameSync(trashDir, paperDir) } catch {}
  throw error
}
```

- If the tombstone write (step a) fails, `unlinkSync` throws `ENOENT`, is swallowed by its own `catch {}`, and the directory rename-back still runs. The stranded-paper scenario from Round 1 is closed.
- If the index write (step b) fails, the tombstone exists and is removed, then the directory is renamed back. Both failure points now converge on a clean baseline (paper restored, no tombstone, index unchanged), which matches the assertion in the injected-index-failure test.
- `restoreTrashEntry` now guards tombstone recreation with `if (!fs.existsSync(...))` and uses `writeFileAtomic`, so its rollback is consistent with the atomic-writer discipline. `originalTombstone` is a `Buffer` captured before the destructive rename; `writeFileAtomic` accepts a Buffer via `fs.writeFileSync(descriptor, content)`, so recreation is byte-exact.

### N2 — exclusive/no-follow atomic writer

`O_EXCL` guarantees the temp path is freshly created (a pre-existing symlink or file causes `EEXIST` and aborts the write), and `O_NOFOLLOW` prevents following a symlink at the temp path itself. The temp name still carries `pid` + 8 random bytes, so `O_EXCL` collisions are not a practical concern for the single-process local server. The `finally` block closes the descriptor if still open and unlinks the temp file, so a failed rename leaves no residue.

### N3 — bounded confirmations

Eviction is oldest-first (`confirmations.keys().next().value`). One behavioral note, not a defect: because eviction is insertion-order rather than true LRU, a user who prepares more than 256 concurrent deletes within the 120 s TTL would have their earliest still-valid confirmations silently evicted; a later `DELETE` for those would return 409 and require re-preparing. This is benign — the cap is a DoS backstop, real usage prepares one delete at a time, and the failure mode is "re-confirm", not data loss. No change recommended.

### N4 — port-80 authority handling

- `isAllowedHost('localhost')` / `isAllowedHost('127.0.0.1')` → true only when `PORT === '80'`; the default 5815 path is unchanged and still requires the explicit `:5815` authority.
- `isAllowedOrigin` strips a trailing `:80` from the host before building the expected `http://<authority>` string, matching what browsers actually send (Origin omits the default port). Test line 73 confirms an Origin that *does* carry `:80` is rejected, which is the correct strict behavior. Consistent on both header shapes.

## Fresh pass — no new findings

Re-read with attention to regressions the fixes could have introduced:

- **Lock ordering unchanged** — delete still takes `paper:<slug>` + `index`, restore `trash:<id>` + `index`, sorted deterministically; no new interleave.
- **Middleware unchanged** — every mutating route (`delete`, `delete/prepare`, `tags`, `trash restore`, `ask`) is still behind session + Origin + CSRF; `$fetch` in `usePapers.ts` sends same-origin requests carrying the CSRF header via `mutationHeaders()`.
- **Confirmation flow intact** — `removePaper` in `usePapers.ts:60-80` calls `delete/prepare` then `delete` with the returned token in `X-Codex-Paper-Confirmation`; the token is consumed exactly once server-side.
- **Slug/trashId validation unchanged** — user-controlled `slug`/`trashId` are still validated by regex before any filesystem use; frontend URL interpolation is therefore safe.
- **`writeFileAtomic` parent-symlink guard preserved** (`librarySecurity.mjs:228`) — still rejects writes into a symlinked parent directory before opening the temp file.

## Informational (unchanged from Round 1, deferred by design)

- **Active-content sinks** — `file.get.ts` notebook HTML/SVG rendering and `raw.get.ts` serving `image/svg+xml` remain unsanitized. Assigned to **P0-A2**; not in P0-A1 scope.
- **Process-local state** — sessions, confirmations, failure buckets, and locks reset on restart. Cross-process locking and full transaction protocol assigned to **P0-C2**.
- Generated-code sandboxing → **P0-A3**; trash retention/purge → **P1-7**; dependency remediation → **P1-3**.

## Recommendation

Ship. Round 1's N1–N4 are resolved with matching tests, and the fixes introduce no regressions. All residual risks are explicitly reassigned to P0-A2/A3/C2 and P1 items.
