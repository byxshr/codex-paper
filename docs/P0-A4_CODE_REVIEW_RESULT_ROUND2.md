# P0-A4 Code Review Result — Round 2

Second reviewer pass after the round-1 findings (see
`docs/P0-A4_CODE_REVIEW_RESULT.md`) were addressed and
`docs/P0-A4_CODE_REVIEW_SUMMARY.md` was updated with the disposition.

## Verdict

**Ship.** Both actionable round-1 findings are fixed, verified empirically, and
locked in by new regression tests plus a Repository Guard sentinel. No new
blocking or non-blocking findings introduced by the changes.

Reproduced locally:

- PDF ingestion security suite: **12/12 pass** (was 10/10; +2 targeted
  regression tests).
- `check-repository` unit tests: **40/40 pass**.
- Repository Guard: **pass**, 167 tracked files inspected.

## Round-1 findings — disposition confirmed

### F1 (Low) — IPv4-compatible IPv6 bypass → **FIXED**

`FORBIDDEN_V6` now includes `['::', 96]` (`download-pdf.cjs:85`), so the
deprecated `::/96` IPv4-compatible range is rejected. Verified by direct probe:

```
::a9fe:a9fe (== ::169.254.169.254)   public? false   (was true)
::7f00:1    (== ::127.0.0.1)          public? false
::c0a8:1    (== ::192.168.0.1)        public? false
::ffff:169.254.169.254 (mapped)       public? false   (unchanged)
8.8.8.8 / 2606:4700:4700::1111        public? true    (no false-positive)
```

The mapped/compatible asymmetry from round 1 is closed, and legitimate public
addresses are not over-blocked. Covered by the new test *"SSRF address policy
rejects deprecated IPv4-compatible IPv6 addresses"*
(`pdf-ingestion-security.test.mjs:59`), which asserts both hex and
dotted-quad spellings (`::a9fe:a9fe`, `::169.254.169.254`, `::808:808`,
`::8.8.8.8`).

### F2 (Low) — synchronous write failure skipped cleanup → **FIXED**

The stream loop was restructured (`download-pdf.cjs:216-244`): a `settled`-guarded
`fail(error)` helper now destroys the response and rejects the managed Promise,
and the `'data'` handler wraps `writeChunk(fd, chunk)` in `try/catch` routing to
`fail`. A synchronous `writeSync` throw (e.g. `ENOSPC`) therefore rejects the
outer promise, so the existing `catch { staging.cleanup() }` fires. Verified by
simulation: injected `ENOSPC` → promise rejects with that exact error and no
`codex-paper-download-*` temp directory leaks. Covered by the new test
*"synchronous staging write failures reject and remove the private temp
directory"* (`pdf-ingestion-security.test.mjs:113`), which asserts the exact
error object propagates (`error === writeError`) and staging is removed.

The fix adds a `writeChunk` injection seam (`options.writeChunk || fs.writeSync`,
`download-pdf.cjs:214`). Production behavior is unchanged (default is
`fs.writeSync`); this is consistent with the pre-existing `lookup` /
`requestFactory` test seams and is acceptable.

### F3 (Info) — total-response deadline → **retained by design**

The 30s `streamTimer` remains a finite total-response budget that bounds
trickle/slowloris-style responses. The summary now documents this as an
intentional usability tradeoff. No change required; the behavior fails closed.

## Additional hardening observed this round

- **Repository Guard coverage extended.** The five PDF-ingestion scripts and the
  policy JSON are now sentinels (`check-repository.mjs:47-51`), and new content
  assertions pin: the policy field values, the downloader's secure-boundary
  tokens (`https.request`, `resolveSafeTarget`, `remoteAddress`, `O_EXCL`,
  `O_NOFOLLOW`, `%PDF-`) with a negative check against restoring HTTP / shared
  predictable staging, the parser's bounded-control tokens, the worker's
  supervisor-only gate, the launcher's rlimit primitives, and prepare-paper's
  use-and-clean staging without a downloader subprocess
  (`check-repository.mjs:355-406`). This makes a silent regression of the
  boundary a guard failure, not just a test failure.

## Re-verification of the untouched boundary

Spot-checked that the round-1 confirmed strengths still hold after the
refactor: DNS pinning + per-hop re-resolution, peer re-check, two-sided size
cap, `O_EXCL|O_NOFOLLOW` staging with cleanup on every error path, parser
isolation gate, rlimit launcher, and private bounded quarantine are all intact.
The stream-loop rewrite preserves the `settled` single-settlement invariant on
both success (`'end'`) and failure paths, so no double-resolve/reject or
double-cleanup is possible.

## Recommendation

Ship P0-A4. Round-1 findings are resolved with regression coverage and guard
enforcement; no follow-up items remain.
