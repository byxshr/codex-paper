# P0-A1 Implementation Record

- Work item: `P0-A1` — local service, destructive operations, and path boundaries
- Branch: `codex/audit-optimizations-2026-07-10`
- Started: 2026-07-11
- Development status: `Review 完成`
- Delivery status: `未推送`

## Decisions

- Bind the Viewer to IPv4 loopback only and accept API Host/Origin values for `127.0.0.1` and `localhost` on the configured port.
- Generate a 256-bit pairing token per server start. The browser exchanges a pasted token for an HttpOnly, SameSite=Strict process-lifetime session.
- Require authentication for every library API and add Origin plus CSRF checks for mutations.
- Resolve all library paths with shared slug, lexical, `lstat`, realpath, no-follow, hidden-file, and size policies.
- Replace recursive deletion with a persistent trash directory, one-time confirmation token, tombstone, listing, and restore flow.
- Use in-process fail-fast locks in P0-A1. Cross-process locks and full publication transactions remain P0-C2.
- Do not sanitize active HTML/Markdown/Notebook/SVG content in this work item; that remains P0-A2.

## Acceptance

- Unauthenticated requests cannot read library data.
- Cross-origin or CSRF-less requests cannot mutate library state.
- No route can follow a paper or nested file symlink outside the configured library.
- Delete requires a short-lived, session-bound confirmation token and is recoverable after refresh/restart.
- Security integration tests use a temporary `PAPERS_DIR` and never mutate the user's real library.
- Existing unit, benchmark, build, smoke, plugin validation, and repository contract checks remain green.

## Delivery workflow

Implementation remains unstaged and unpushed until independent review. On completion, record exact tests, cachebuster version, known residual risks, and rollback instructions here and in the audit tracker.

## Implementation result

- Viewer security: loopback-only bind, Host/Origin checks, per-start pairing token, HttpOnly Strict session, in-memory CSRF, and a public health endpoint are active.
- Filesystem boundary: all library routes use the shared resolver; public routes reject hidden/machine artifacts and symlinks and apply no-follow reads plus size/tree budgets.
- Mutations: Ask, tags, delete, and restore use fail-fast process-local locks; tags are bounded and deduplicated; Ask validates `selectedFile` within the current paper.
- Recovery: delete requires a session/slug-bound one-time token and atomically moves the paper to persistent trash with a tombstone; list and restore are available in both API and Viewer UI.
- Installed active plugin: `plugins/codex-paper/`, version `2.0.0+codex.20260711152652`.

## Verification result

- Repository contract: pass; 124 tracked files inspected before the final cachebuster update.
- Repository/security tests: 43/43 (`31` existing guard cases plus `12` P0-A1 cases).
- Study tests: 23/23.
- Parser benchmark: 5/5; reasoning benchmark: 12/12; package benchmark: 10/10.
- Production build: pass; only the pre-existing stale Browserslist data warning remains.
- Real HTTP security integration: pass against a temporary library, including authentication, Host/Origin/CSRF, traversal, symlink, delete-confirmation replay, trash, restore, and index recovery.
- Smoke test: pass against a temporary empty library and paired session.
- Browser QA: pairing gate, refresh-preserved session, tag mutation, recoverable delete, trash list, and restore passed. Ask crossed the security gate and started the local Codex worker; the minimal temporary package did not return an answer within the short UI QA window.
- Official plugin validator and reinstall: pass; `codex plugin list` resolves the active source to `plugins/codex-paper/` with the cachebuster above.

## Rollback

Revert the P0-A1 source changes and reinstall the preceding cachebuster from Git history. Do not recursively delete `PAPERS_DIR/.trash`; if rollback is needed after users have moved papers there, restore those entries with the P0-A1 Viewer/API first or preserve the directory for manual recovery.

## Residual risks

- Locks and session state are process-local; cross-process serialization remains P0-C2.
- Active content sanitization remains P0-A2, and generated-code sandbox policy remains P0-A3.
- Ask completion depends on the local Codex worker; P1-5 owns bounded queueing and deeper observability.
- Dependency audit remediation is deferred to P1-3 so P0-A1 does not introduce unrelated dependency churn.

## Code Review follow-up

The independent review in `docs/P0-A1_CODE_REVIEW_RESULT.md` returned “Approve with non-blocking findings.” The recommendations were handled as follows:

- `N1` accepted: delete rollback now unlinks the tombstone and renames the paper back in independent best-effort steps, so an absent tombstone cannot suppress directory rollback.
- `N2` accepted: atomic temporary files now use `O_EXCL` and `O_NOFOLLOW` before descriptor-based writes.
- `N3` accepted: live delete confirmations are capped at 256 with oldest-entry eviction after expiry pruning.
- `N4` accepted: `PORT=80` accepts both explicit `:80` and browser-default omitted-port Host forms while Origin remains canonical `http://<loopback-host>`.
- Symmetric restore hardening added: tombstone recreation and rename-back are independent, and index publication failure returns the paper to a valid trash entry whenever tombstone recreation succeeds.
- `I1` remains assigned to P0-A2; `I2` required no change.

New regression coverage injects tombstone creation failure and restore index failure, verifies exclusive/no-follow temporary opens, checks the confirmation cap, and covers default-port Host/Origin behavior.
