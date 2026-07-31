# P0-A3 Code Review Handoff

## Review target

P0-A3 removes the remaining generated-code bare-host execution path and introduces an explicitly approved, fail-closed Docker sandbox. Review should treat generated packages and output as adversarial.

## Security invariants

1. `validate-study-package.js` cannot spawn a process; legacy execution flags exit `2`.
2. `sandbox-plan` can inspect code while unavailable, but cannot issue a token unless engine, image and conformance stamp match.
3. The token is single-use, five-minute, 256-bit and bound to code-tree hashes, fixed argv, limits, policy hash and image ID. It proves plan integrity, not human identity; explicit consent remains a skill/workflow boundary.
4. The runner passes argv arrays directly to Docker and never uses a shell or host interpreter fallback.
5. Containers are per-artifact, offline, non-root, capability-free, read-only except bounded `/tmp`, resource-limited and forcibly removed.
6. Reports use a no-follow preflight reservation and atomic final publication; authorization and host credentials are excluded.
7. Viewer behavior is unchanged and has no execution API.

## Primary review surfaces

- Sandbox host runner and policy under `plugins/codex-paper/skills/study/scripts/sandbox-code.js` and `plugins/codex-paper/sandbox/`.
- Static-only package validator and study instructions.
- Repository/security tests, package benchmark and CI sandbox gate.

## Verification status

- Local non-container verification: passed — Repository Guard 37/37, repository/security 75/75, study 23/23, parser 5/5, reasoning 12/12 and package 11/11.
- Production build, Viewer HTTP security integration and smoke test: passed.
- Missing-Docker contract: `sandbox-status=unavailable`, exit `3`; no approval is issued and run fails closed.
- Real Docker conformance: passed in [GitHub Actions run 29244582383](https://github.com/byxshr/codex-paper/actions/runs/29244582383); this Mac intentionally remains on the tested fail-closed missing-Docker path.
- Official plugin validator and reinstall: passed; active source `plugins/codex-paper/`, version `2.0.0+codex.20260713105712`.
- Real-Docker follow-up: diagnostics identified a minimal-only Python image missing `json`; after that fix, CI showed the 64 MiB `/tmp` cap can raise `ENOSPC` before `RLIMIT_FSIZE` raises `SIGXFSZ`. The synthetic probe now removes its own oversized file after `ENOSPC` so the trusted wrapper can write its report; the signal path still requires matching exit `153` plus resource status `-25`.
- Independent review rounds 1 and 2: all findings resolved, no new defects; mandatory real-Docker conformance and the complete CI pipeline passed.

## Requested reviewer focus

- approval TOCTOU, replay and state-directory safety;
- Docker argv/mount/env/resource policy and cleanup on timeout/output overflow;
- report-path symlink or overwrite opportunities;
- any path that could silently execute code outside the supported backend;
- whether CI can ever skip or falsely pass real conformance.

## Review findings resolution

- Accepted design finding: the CLI cannot authenticate human consent. The plan output, security guide and skill now state this explicitly; the skill must stop and wait for a new user reply before consuming the token.
- Fixed approval-file hygiene: creating a new approval safely sweeps expired private token files.
- Fixed resource-report trust ambiguity: the host validates size, type, numeric shape and exit-code consistency, and labels accepted container-wrapper measurements as non-authoritative.
- No change for output byte accounting: storage already remains bounded and the limit callback fires on the first crossing chunk.
- Round-2 report clarification: its note that `consent` and `boundary` are excluded from `planBinding` is stale; the committed runner includes both in the binding hash, which strengthens rather than weakens the reviewed invariant.
