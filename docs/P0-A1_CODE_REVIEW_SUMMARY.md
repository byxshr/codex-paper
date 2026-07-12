# P0-A1 Code Review Summary

## Review metadata

- Work item: `P0-A1` — local service, destructive operations, and path boundaries
- Branch: `codex/audit-optimizations-2026-07-10`
- Date: 2026-07-11
- Development status: `开发完成`
- Delivery status: `未推送`
- Active plugin source: `plugins/codex-paper/`
- Installed version: `2.0.0+codex.20260711152652`
- Review baseline: committed S0-1 state at `e2c44eb`

This document is the handoff for an independent security-focused code review. The implementation is intentionally unstaged, uncommitted, and unpushed.

## Outcome

P0-A1 changes the local Viewer from an unauthenticated filesystem UI with permanent deletion into a loopback-only, paired application with authenticated library APIs, CSRF-protected mutations, shared no-follow path resolution, fail-fast process-local locks, and recoverable trash.

The work does not implement active-content sanitization, generated-code sandboxing, cross-process locks, retention, or permanent trash purge. Those remain assigned to P0-A2, P0-A3, P0-C2, and P1-7.

## Security invariants to review

1. The production server listens only on `127.0.0.1`.
2. Every `/api/**` request validates Host; only `127.0.0.1:<port>` and `localhost:<port>` are accepted.
3. Only `GET /api/health` and `POST /api/session/pair` are available without a session.
4. Pairing requires a same-origin request and a 256-bit per-start token supplied in the request body.
5. Library APIs require an HttpOnly, SameSite=Strict process-lifetime cookie.
6. POST, PUT, PATCH, and DELETE require an exact allowed Origin and `X-Codex-Paper-CSRF`.
7. Delete additionally requires a session/slug-bound, 120-second, single-use `X-Codex-Paper-Confirmation` token.
8. Paper directories, nested path segments, final files, index files, trash entries, tombstones, and writable targets must not traverse symlinks or escape `PAPERS_DIR`.
9. Delete never recursively removes a paper. It renames it into persistent trash and records a tombstone containing the original index entry.
10. Ask, tags, delete, and restore conflict immediately with another operation on the same lock keys rather than waiting indefinitely.

## Request flow

```text
Browser opens Viewer
  -> GET /api/session
     -> 401: show pairing gate
     -> 200: retain returned CSRF token in page memory

Pairing
  -> POST /api/session/pair { token }
  -> validate Host + exact Origin + rate limit + constant-time digest comparison
  -> set HttpOnly SameSite=Strict session cookie
  -> return CSRF token

Library read
  -> validate Host + session cookie
  -> resolve paper/file with shared no-follow boundary
  -> enforce public/internal policy and byte/tree budget

Library mutation
  -> validate Host + session + Origin + CSRF
  -> acquire fail-fast ordered operation locks
  -> re-resolve target inside lock
  -> perform atomic file/index operation or rollback
```

## Delete and restore transaction

### Delete

1. `POST /api/papers/:slug/delete/prepare` validates the current paper and creates a session/slug-bound confirmation.
2. `DELETE /api/papers/:slug/delete` consumes the confirmation exactly once.
3. The route acquires `paper:<slug>` and `index` locks in deterministic order.
4. The paper directory is revalidated and atomically renamed to `PAPERS_DIR/.trash/<trashId>`.
5. `.codex-paper-trash.json` records schema version, trash ID, slug, deletion time, original relative path, and complete index entry.
6. The library index is written through a temporary file and rename.
7. If the tombstone or index write fails, the directory is renamed back and the transient tombstone is removed.

### Restore

1. `GET /api/trash` lists only valid non-symlink trash entries with valid tombstones.
2. `POST /api/trash/:trashId/restore` acquires `trash:<trashId>` and `index` locks.
3. A pre-existing target, including a dangling symlink, returns 409.
4. The trash directory is renamed back to the paper root and its tombstone is removed.
5. The original index entry is restored while retaining the index's array or object shape.
6. If index publication fails, the tombstone is recreated and the directory is renamed back to trash.

## Main implementation areas

### Authentication and middleware

- `plugins/codex-paper/src/web/server/utils/sessionSecurity.mjs`
  - startup token validation/generation;
  - constant-time digest comparison;
  - process-local pairing rate limit;
  - session and CSRF lifecycle;
  - single-use delete confirmation lifecycle.
- `plugins/codex-paper/src/web/server/middleware/00-security.ts`
  - global API Host, session, Origin, and CSRF enforcement;
  - build-time prerender bypass only through `import.meta.prerender`.
- `plugins/codex-paper/src/web/server/plugins/security-init.ts`
  - production startup initialization and fail-closed token requirement.
- New public/session routes:
  - `server/api/health.get.ts`;
  - `server/api/session/pair.post.ts`;
  - `server/api/session.get.ts`.

### Filesystem and operation boundary

- `plugins/codex-paper/src/web/server/utils/librarySecurity.mjs`
  - canonical library paths and slug/path validation;
  - repeated percent-decoding and traversal rejection;
  - segment-by-segment `lstat` and realpath containment;
  - `O_NOFOLLOW` reads;
  - atomic JSON/file writers;
  - public file allow policy;
  - file size and tree budgets.
- `plugins/codex-paper/src/web/server/utils/operationLocks.mjs`
  - ordered, fail-fast, process-local locks.
- `plugins/codex-paper/src/web/server/utils/trashManager.mjs`
  - move, tombstone, index update, listing, restore, and rollback.
- `plugins/codex-paper/src/web/server/utils/chatNotes.ts`
  - no-follow bounded reads and atomic replacement for Ask notes.

All paper list/detail/facts/analysis/reasoning/evidence/files/file/raw/tags/delete/Ask routes were migrated away from route-local `homedir + join` logic to the shared boundary.

### Viewer and scripts

- `app.vue`, `components/AuthGate.vue`, and `composables/useSecuritySession.ts` implement the pairing gate and in-memory CSRF handling.
- `composables/usePapers.ts`, `pages/index.vue`, and `components/PaperCard.vue` implement confirmation preparation, “Move to Trash”, trash listing, and restore.
- The paper detail page adds CSRF to Ask requests.
- `plugins/codex-paper/scripts/start-webui.sh` creates a mode-0600 token file, prints the token only to the launching terminal, and passes loopback/security environment variables to the server.
- `scripts/codex-paper.sh` moves health checks to `/api/health`, isolates smoke tests in a temporary library, and exposes `security-test`.
- CI runs the real HTTP security integration test after the production build.

## Public API contract

| Endpoint | Authentication | Additional checks | Purpose |
|---|---|---|---|
| `GET /api/health` | none | Host | process health |
| `POST /api/session/pair` | none | Host + exact Origin + rate limit | exchange startup token for session |
| `GET /api/session` | session | Host | recover current CSRF token after refresh |
| existing library GET APIs | session | Host + filesystem boundary | read library data |
| existing mutation APIs | session | Host + Origin + CSRF + locks | Ask and tags |
| `POST /api/papers/:slug/delete/prepare` | session | Host + Origin + CSRF | create delete confirmation |
| `DELETE /api/papers/:slug/delete` | session | Host + Origin + CSRF + confirmation + locks | move paper to trash |
| `GET /api/trash` | session | Host + tombstone boundary | list recoverable entries |
| `POST /api/trash/:trashId/restore` | session | Host + Origin + CSRF + locks | restore paper and index entry |

Expected status classes are 400 for malformed input, 401 for missing/invalid sessions, 403 for Host/Origin/CSRF/symlink/boundary violations, 404 for missing resources, 409 for conflicts or invalid/replayed confirmation, 413 for resource budgets, and 422 for corrupted managed JSON/tombstones.

## Resource limits

| Resource | Limit |
|---|---:|
| Public text and Notebook | 16 MiB |
| Internal JSON | 64 MiB |
| Raw binary | 128 MiB |
| Public file-tree depth | 12 |
| Public file-tree nodes | 5000 |
| Tags | 32 entries |
| Tag length | 64 characters |
| Delete confirmation | 120 seconds, single use |

Hidden path segments, symlinks, machine JSON artifacts, and `node_modules` are excluded from public file APIs and the file tree.

## Verification evidence

| Check | Command | Result |
|---|---|---|
| Repository contract | `bash scripts/codex-paper.sh repo-check` | Passed; 124 tracked files inspected |
| Guard and P0-A1 tests | `bash scripts/codex-paper.sh test` | 43/43 repository/security; 23/23 study |
| Parser benchmark | `bash scripts/codex-paper.sh benchmark` | 5/5 |
| Reasoning benchmark | `bash scripts/codex-paper.sh reasoning-test` | 12/12 |
| Package benchmark | `bash scripts/codex-paper.sh package-test` | 10/10 |
| Production build | `bash scripts/codex-paper.sh build` | Passed |
| Real HTTP security | `bash scripts/codex-paper.sh security-test` | Passed against temporary `PAPERS_DIR` |
| Smoke | `bash scripts/codex-paper.sh smoke-test` | Passed against temporary `PAPERS_DIR` |
| Plugin validation | `validate_plugin.py plugins/codex-paper` | Passed |
| Plugin reinstall | `codex plugin add codex-paper@codex-paper` | Passed |
| Active plugin path | `codex plugin list` | `plugins/codex-paper/`, version `2.0.0+codex.20260711152652` |

The security integration covers unauthenticated library access, invalid Host, Origin and CSRF rejection, successful pairing, cookie attributes, tags mutation, traversal, hidden files, file symlinks, delete-without-prepare, confirmation replay, trash persistence, restore, repeated restore, and index recovery.

Browser QA used a temporary library and confirmed:

- initial pairing gate and token input;
- token absent from URL;
- session recovery after refresh;
- mandatory re-pair after server restart;
- tag mutation;
- “Move to Trash” wording and confirmation flow;
- persistent trash list and restore.

The Ask request passed the security middleware and started the local Codex worker. The minimal temporary package did not receive a completed answer inside the short UI QA window; Ask worker completion behavior was not changed by P0-A1 and remains covered separately from the new security boundary.

## Reviewer focus areas

1. Confirm the `import.meta.prerender` exception cannot be reached by normal production HTTP requests.
2. Inspect Host and Origin normalization for alternate authority forms, proxy behavior, and configured-port edge cases.
3. Check session/confirmation map lifecycle, failure-bucket cleanup, and denial-of-service bounds.
4. Look for TOCTOU gaps between `lstat`/realpath and final no-follow open or rename operations.
5. Review dangling-symlink handling for papers, writable targets, restore targets, index, trash, tombstones, and chat notes.
6. Verify every library route is behind middleware and every mutation supplies/validates CSRF.
7. Review lock-key ordering and whether Ask/tags/delete/restore combinations can still interleave incorrectly.
8. Exercise delete and restore rollback at every failure point, especially tombstone removal/recreation and both supported index shapes.
9. Confirm error responses do not expose absolute local paths; in particular inspect the sanitized Ask fallback prompt.
10. Confirm token material does not enter URLs, server access logs, generated HTML, shell history generated by scripts, or world-readable files.

## First review disposition

`docs/P0-A1_CODE_REVIEW_RESULT.md` concluded “Approve with non-blocking findings.” All four recommendations were evaluated and accepted because they are low-risk extensions of existing P0-A1 invariants:

| Finding | Disposition | Change |
|---|---|---|
| N1 delete rollback can skip rename | Accepted | unlink and rename-back are independent; tombstone-write failure has a dedicated test |
| N2 temporary file lacks exclusive/no-follow open | Accepted | descriptor opened with `O_EXCL` and `O_NOFOLLOW`; flags are regression-tested |
| N3 confirmation map has no cap | Accepted | capped at 256 live entries with oldest eviction |
| N4 default HTTP port Host form | Accepted | `PORT=80` supports omitted or explicit port and canonical omitted-port Origin |

The same rollback pattern was applied to restore: tombstone recreation cannot prevent rename-back, and injected index failure verifies that the entry remains recoverable. Active-content finding I1 remains explicitly deferred to P0-A2; prerender finding I2 was confirmation rather than a requested change.

## Known exclusions and residual risks

- Sessions, confirmations, failure buckets, and locks are process-local and reset on restart.
- Cross-process locking and a complete multi-file transaction protocol remain P0-C2.
- HTML, Markdown, Notebook rich output, iframe content, and SVG sanitization remain P0-A2.
- Generated-code execution consent and sandboxing remain P0-A3.
- Trash retention and permanent purge remain P1-7.
- Ask queueing, streaming, cancellation, and observability remain P1-5.
- Existing npm audit findings are not changed in this security item; dependency remediation remains P1-3.

## Rollback considerations

Code can be reverted to the S0-1 baseline and the preceding plugin version reinstalled. Before rollback, any entries already stored under `PAPERS_DIR/.trash` should be restored through the P0-A1 API/UI or preserved for manual recovery. Rollback must not recursively remove `.trash`, because it may contain the only recoverable copy of a paper.

## Worktree scope

No files were staged, committed, or pushed. Existing unrelated untracked documents and `plugins/codex-paper/src/web/components/PaperAnalysisHero.vue` were preserved and are not part of P0-A1. Reviewers should scope the diff to the files described above plus:

- `README.md`, `README.zh-CN.md`, and `CHANGELOG.md`;
- `docs/P0-A1_IMPLEMENTATION_PLAN.md`;
- `docs/local-viewer-security.md`;
- the P0-A1 status entries in `docs/codex-paper-audit-2026-07-10.md`.

## Suggested review verdict format

```text
Verdict: Approve | Approve with non-blocking findings | Request changes

Blocking findings:
- ...

Non-blocking findings:
- ...

Checks independently rerun:
- ...

Residual risks accepted or reassigned:
- ...
```
