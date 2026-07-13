# P0-A4 Code Review Handoff

## Review scope

P0-A4 replaces unrestricted PDF fetching and in-process parsing with a fail-closed ingestion boundary. Review should treat URLs, DNS answers, redirects, PDF bytes, parser libraries and parser output as adversarial.

Primary files:

- `plugins/codex-paper/skills/study/scripts/download-pdf.cjs`
- `plugins/codex-paper/skills/study/scripts/pdf-security.js`
- `plugins/codex-paper/skills/study/scripts/pdf-security-policy.json`
- `plugins/codex-paper/skills/study/scripts/parse-pdf.js`
- `plugins/codex-paper/skills/study/scripts/pdf-parser-launcher.py`
- `plugins/codex-paper/skills/study/scripts/pdf-parser-worker.js`
- `plugins/codex-paper/skills/study/scripts/prepare-paper.js`
- `scripts/tests/pdf-ingestion-security.test.mjs`
- `scripts/check-repository.mjs`

## Security properties

- HTTPS only; no URL credentials; all DNS answers and every redirect must remain public.
- Connection is pinned to a validated address with original Host/SNI and exact peer verification.
- Content-Length and actual stream are independently limited to 128 MiB; `%PDF-` and bounded parser success are mandatory.
- Local and remote inputs use private random no-follow staging and unconditional cleanup.
- Parser worker runs in a detached process group with wall/CPU/RSS/heap/file/output/fd/page budgets and group kill.
- Encrypted, malformed, oversized and over-page inputs fail closed into private quota/retention-limited quarantine.
- Repository Guard prevents restoring HTTP, predictable shared staging, direct parser access or missing resource gates.

## Review disposition

- Verdict: ship; no blocking findings.
- F1 accepted and fixed: deprecated IPv4-compatible IPv6 (`::/96`) is rejected instead of being classified as public.
- F2 accepted and fixed: synchronous stream writes reject through the managed Promise path, terminate the response and trigger private staging cleanup.
- F3 retained by design: the 30-second timer is a finite total-response budget that prevents indefinite trickle responses; the usability tradeoff is documented.
- Round 2 independently reproduced both fixes and the repository guard, found no new blocking or non-blocking issues, and recommended shipping with no remaining follow-up items.

## Verification

- Repository Guard 40/40; repository/security 90/90; PDF ingestion security 12/12; study 23/23.
- Parser 5/5; reasoning 12/12; package 11/11.
- Production build, Viewer HTTP security and smoke test passed.
- Real W3C HTTPS PDF download passed DNS pin, TLS/SNI, peer, streaming, magic and cleanup checks.
- Official plugin validator and marketplace reinstall passed; active version `2.0.0+codex.20260713121349`.

## Reviewer focus

- IPv4/IPv6 classification completeness and Node custom-lookup behavior.
- Redirect response cleanup, stream deadline/byte-limit races and staging cleanup on every error path.
- Process-group kill, RSS sampling semantics and worker/launcher bypass resistance.
- Quarantine ownership, permissions, quota eviction and metadata privacy.
- Whether any preparation/migration path can still invoke the parser in-process or consume an unstaged input.

## Residual boundary

The 1 GiB RSS limit is sampled every 100ms rather than enforced by a cgroup. Node heap, CPU, file size and file-descriptor limits are separate hard controls. Parser dependencies and the host kernel remain in the trusted computing base; containerized parsing is not part of P0-A4.
