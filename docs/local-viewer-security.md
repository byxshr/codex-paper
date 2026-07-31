# Local Viewer Security

## Trust boundary

Codex Paper is a local-only HTTP application. Papers, generated materials, filenames, model answers, and package metadata are untrusted inputs. Loopback binding reduces network exposure but does not replace authentication, Host validation, CSRF protection, or filesystem containment.

## Pairing and session

Each server start creates a new high-entropy pairing token. The token is shown in the launching terminal and stored only in a mode-0600 temporary file so it can be re-displayed while the same server is running. It is never placed in a URL.

The Viewer asks the user to paste the token. A successful `POST /api/session/pair` creates a process-lifetime session in an HttpOnly, SameSite=Strict cookie and returns a CSRF token held only in page memory. Restarting the server invalidates all sessions and requires pairing again.

All API requests validate the Host header. Library APIs require the session cookie. Mutating methods additionally require a same-origin request and the `X-Codex-Paper-CSRF` header. Delete also requires a single-use `X-Codex-Paper-Confirmation` token bound to the session and paper slug.

## Filesystem policy

The configured library root is `PAPERS_DIR`, defaulting to `~/codex-papers`. Paper slugs and relative paths are validated before filesystem access. Existing targets are checked segment-by-segment with `lstat`, resolved with realpath containment, and final files are opened with no-follow semantics. Public file routes reject hidden and machine-only artifacts.

Current budgets are:

- public text and Notebook content: 16 MiB;
- internal JSON: 64 MiB;
- raw binary assets: 128 MiB;
- file tree: depth 12 and 5000 nodes.

## Recoverable deletion

Delete moves the resolved paper record (or an unchanged legacy payload) to `PAPERS_DIR/.trash/<trashId>/payload` on the same filesystem. A separate versioned `tombstone.json` preserves layout, stable paper lock key, aliases, original relative path, and index projections without modifying the payload. Restore refuses identity/route/target conflicts and rolls back its rename if index restoration fails.

Managed packages are resolved through Paper Library Layout 1.0 `current.json`. Tags and Chat notes are written only to the paper-level overlay; generation `meta.json`, validation reports, and study artifacts are not changed. Legacy flat packages remain readable, but tags, Ask persistence, validation writes, and sandbox execution fail closed until explicit migration.

Trash is persistent and has no automatic purge or permanent-delete API in P0-A1. Retention controls belong to P1-7.

## Residual boundaries

- Locks are process-local; shared filesystem locks belong to P0-C2.
- Browser-active content isolation and sanitization belong to P0-A2.
- Generated-code sandboxing belongs to P0-A3.
- Large-file streaming and request observability belong to P1-5.
