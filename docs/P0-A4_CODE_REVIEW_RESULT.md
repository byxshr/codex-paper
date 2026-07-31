# P0-A4 Code Review Result

Reviewer pass over the PDF ingestion boundary described in
`docs/P0-A4_CODE_REVIEW_SUMMARY.md`. URLs, DNS answers, redirects, PDF bytes,
parser libraries and parser output were treated as adversarial.

## Verdict

The fail-closed ingestion boundary is sound and the claimed security properties
hold under inspection. All automated evidence reproduced locally:

- PDF ingestion security suite: **10/10 pass**.
- Repository Guard: **pass**, 167 tracked files inspected.

No blocking issues. Three findings below (two low-severity, one informational)
are hardening opportunities, not regressions against the P0-A4 scope.

## Confirmed strengths

- **SSRF / DNS pinning.** `resolveSafeTarget` resolves all answers with
  `verbatim: true`, rejects the whole set if *any* address is non-public, and
  `requestOnce` pins the connection to the selected address via a custom
  `lookup` while preserving the original `Host`/SNI. `remoteAddress` is
  re-checked against the pinned address after connect (`peer_mismatch`), closing
  the DNS-rebind window.
- **Redirect discipline.** Every hop is re-validated (`validateHttpsUrl`),
  re-resolved and re-pinned; redirect bodies are drained (`response.resume()`)
  and the redirect counter is enforced. HTTPS-only, no-credentials and
  hash-stripping are applied on each hop.
- **Two-sided size limit.** `Content-Length` is validated as digits-only and
  capped, and the live stream is independently capped byte-by-byte, so a lying
  or absent `Content-Length` cannot exceed 128 MiB.
- **Safe staging.** All staging uses `mkdtemp` + random filename +
  `O_EXCL | O_NOFOLLOW`, `0700` dirs and `0600`/`0400` files; `%PDF-` magic is
  checked via an `lstat`+`O_NOFOLLOW` fd (TOCTOU-resistant), and cleanup runs on
  every error path and in the `finally` of `preparePaper`.
- **Parser isolation.** In-process parsing is gated behind
  `CODEX_PAPER_PARSER_WORKER=1`; the worker refuses to run unless launched by the
  supervisor; the Python launcher applies `RLIMIT_CPU/FSIZE/NOFILE` and
  `execve`s with a scrubbed env; the supervisor enforces wall-clock, RSS
  sampling, stdout/stderr caps and process-group kill (`SIGKILL` to `-pid`).
- **Quarantine.** Private `0700` root with owner + permission assertions,
  retention + entry-count + byte-budget eviction, and metadata that strips the
  source path from reason strings (verified by test).
- **Repository Guard.** Regex sentinels prevent restoring HTTP, predictable
  shared staging, direct parser access, or dropping the rlimit/isolation
  primitives, and the policy JSON is pinned field-by-field.

## Findings

### F1 (Low) — IPv4-compatible IPv6 addresses bypass the private-range filter

`normalizeAddress` decompresses IPv4-*mapped* addresses (`::ffff:a.b.c.d`) back
to dotted IPv4 and blocks them correctly, but IPv4-*compatible* addresses
(`::/96`, e.g. `::169.254.169.254` == `::a9fe:a9fe`) are left as IPv6 and are not
covered by any `FORBIDDEN_V6` entry, so they classify as public:

```
::a9fe:a9fe   (== ::169.254.169.254)  isPublicAddress -> true
::ffff:a9fe:a9fe (mapped equivalent)  isPublicAddress -> false
```

Exploitability is low: IPv4-compatible addresses are deprecated (RFC 4291) and
are generally not routed to their embedded IPv4 destination by modern stacks, so
a connection to `::a9fe:a9fe` is unlikely to actually reach the metadata
endpoint. Still, the asymmetry with the mapped case is a real classification
gap. Recommend either adding `['::', 96]` to `FORBIDDEN_V6`, or extending the
`normalizeAddress` embedded-IPv4 extraction to cover the `::/96` prefix the same
way it handles `::ffff:/96`.

`download-pdf.cjs:52` (`mappedIpv4`), `download-pdf.cjs:84` (`FORBIDDEN_V6`).

### F2 (Low) — synchronous write failure during download skips staging cleanup

In the streaming loop, `fs.writeSync(fd, chunk)` runs inside the `response`
`'data'` handler (`download-pdf.cjs:223`). If the write throws synchronously
(e.g. `ENOSPC`), the throw escapes the event callback rather than rejecting the
surrounding promise, so `staging.cleanup()` in the `catch` does not run and the
partial temp file leaks (and the exception is unhandled). Recommend wrapping the
write in a `try/catch` that calls `response.destroy(err)` / `reject(err)` so the
existing cleanup path fires. This is an availability/hygiene issue, not a
confinement break — the file stays inside the private `0700` staging dir.

### F3 (Info) — full-body download shares the 30s connect deadline

`streamTimer` (`download-pdf.cjs:214`) applies `requestTimeoutMs` (30s) as a
single total deadline for downloading the entire body, up to 128 MiB. It is not
reset per chunk, so a legitimate large PDF over a slow link can hit
`download_timeout`. This fails closed (safe), but is worth noting as a
usability/tuning tradeoff; an idle/stall timeout that resets on progress would be
more forgiving while remaining bounded.

## Residual boundary (accepted, per summary)

The 1 GiB RSS ceiling is sampled every 100 ms rather than enforced by a cgroup;
Node heap, CPU, FSIZE and NOFILE remain the hard controls. Parser dependencies
and the host kernel stay in the trusted computing base. Containerized parsing is
explicitly out of P0-A4 scope. These match the summary's stated residual and are
acceptable for this milestone.

## Recommendation

Ship P0-A4. Track F1 and F2 as small follow-up hardening items; F3 is optional
tuning.
