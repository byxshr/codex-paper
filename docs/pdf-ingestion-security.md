# PDF ingestion security

P0-A4 treats remote hosts, redirects, DNS, PDF bytes, parser libraries and parser output as untrusted. The trusted boundary is the downloader policy, private staging code, parser supervisor/launcher, and quarantine manager.

The downloader's 30-second response timer is deliberately a total wall-clock budget, not an idle timeout. This can reject a legitimate large PDF on a slow link, but prevents an adversarial peer from retaining a worker indefinitely by sending a continuous trickle of bytes. A future tuning change must preserve both a finite total deadline and a separate bounded input size.

## Network boundary

- Remote inputs are HTTPS-only and cannot contain URL credentials.
- The initial URL and every redirect resolve independently. If any answer is private, loopback, link-local, carrier-grade NAT, metadata, benchmark, documentation, multicast, reserved, IPv6 ULA or IPv4-mapped forbidden space, the request fails.
- The connection uses a custom lookup pinned to one validated address while retaining the original Host and TLS SNI. The response socket peer must match that address.
- Redirects are limited to five. Request/stream time is limited to 30 seconds.
- `Content-Length` and actual bytes are independently capped at 128 MiB. MIME and filename are advisory; `%PDF-` is mandatory.

## Staging and parsing

Both local and downloaded inputs are copied into a fresh `0700` `mkdtemp` directory with a random `0600`, `O_EXCL` and `O_NOFOLLOW` file. `prepare-paper.js` owns the staging lifetime and removes it in `finally` after success or failure.

Production parsing always uses `parsePdfDetailed`, which creates a second no-follow, exclusive, read-only snapshot and starts a detached process group through `pdf-parser-launcher.py`. The launcher applies CPU, output-file and file-descriptor rlimits before `execve`; Node uses a 512 MiB heap cap, and the parent samples total process-group RSS against a 1 GiB budget. The parent also enforces a 60-second wall deadline, bounded stdout/stderr, a 64 MiB result file, and process-group termination. PyMuPDF rejects encrypted documents and checks the 2000-page cap before page extraction; the fallback result is checked against the same page contract.

The RSS watchdog is a sampled host-process control rather than a kernel container/cgroup boundary. Parser dependencies and the host kernel remain trusted computing-base components; a future containerized parser backend may narrow this residual boundary.

## Quarantine

Rejected inputs may be copied to `~/codex-papers/.quarantine/` for diagnosis:

- root and entry directories are `0700`; files are `0600`;
- metadata contains bounded reason, size and SHA-256, but no source URL credentials or absolute source path;
- maximum retention is seven days, 32 entries and 512 MiB, with oldest-first cleanup;
- inputs over the 128 MiB capture limit receive metadata only;
- quarantine files are never trusted evidence and are not exposed by the Viewer.

## Error behavior

HTTPS policy, DNS/peer mismatch, redirect limit, byte limit, magic failure, encrypted/malformed input, page limit, parser timeout, CPU/RSS/output limit and unsafe paths all fail closed. Staging and parser temporary directories are removed on every path; quarantine failure never turns a rejected PDF into an accepted one.
