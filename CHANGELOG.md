# Changelog

## Unreleased

- Added package contract 2.1 with typed `resultClaims`, deterministic metric/value binding, and a backward-compatible `keyResults` projection.
- Switched newly generated facts and analysis to direct `ev-*` references while preserving read-only 2.0 legacy-reference compatibility across scripts and Viewer APIs.
- Migrated mandatory B2 defect signatures to positive ResultClaim assertions; only P0-B3 parser-contamination and conflict-warning findings remain expected.
- Hardened P0-B2 after independent review: reject metric-name digits and invalid table/evidence IDs, preserve evidence confidence, merge only corroborated contexts, schema-validate writer output, enforce 2.0 read-only writers, and avoid unnecessary Viewer ledger parsing.
- Hardened P0-B2 after the second review: make candidate merging order-independent, require explicit read-only legacy validation, unify cross-endpoint compatibility verdicts, reject unsupported migrations before writes, and tighten reference limits, membership, and error handling.
- Hardened P0-B2 after the third review: complete explicitly versioned 1.x migrations without partial writes, preserve readable core Viewer responses when ancillary compatibility JSON is corrupt, and surface fail-closed `PACKAGE_ARTIFACT_INVALID` diagnostics in readers and validators.
- Hardened P0-B2 after the fourth review: preflight every existing migration artifact before writes, normalize corrupt migration diagnostics, preserve facts/analysis across corrupt meta sidecars, and accurately identify mixed unsupported artifact versions.
- Added two byte-reproducible, MIT-licensed synthetic PDFs for front-matter contamination and conflicting translation-result regressions.
- Added a non-skippable mandatory PDF-to-prepare-to-validator benchmark that freezes current audited defects as explicit expected findings and reserves P0-B2/B3 target contracts.
- Split CI reporting between the mandatory synthetic gate and the optional allow-missing external paper corpus, with Repository Guard mutation coverage against zero execution and bypasses.
- Harden P0-A4 PDF ingestion after independent review: reject deprecated IPv4-compatible IPv6 destinations and ensure synchronous staging write failures are rejected through the normal private-temp cleanup path.
- Replaced the shared predictable PDF downloader with HTTPS-only, per-redirect SSRF validation, DNS-pinned/peer-verified connections, 128 MiB streaming limits, `%PDF-` verification, and private random staging.
- Moved production PDF parsing behind a bounded process-group supervisor with wall/CPU/RSS/output/file/page budgets and fail-closed encrypted/malformed handling.
- Added a private 7-day, 32-entry/512 MiB PDF quarantine plus deterministic downloader/parser security tests, Repository Guard rules, and a CI gate.
- Removed generated-code execution from package validation and the default paper-study workflow; legacy `--run-code`/`--run-artifacts` flags now fail closed.
- Added a digest-pinned Docker sandbox with capability/conformance gating, no network, read-only source, scrubbed credentials, bounded resources, and no host-execution fallback.
- Added code-hash-bound five-minute single-use approvals and persistent structured execution reports for explicitly requested demo runs.
- Added synthetic sandbox policy/authorization tests and a real Docker conformance gate in CI.
- Incorporated P0-A3 security review feedback by documenting the workflow-only human-consent boundary, sweeping expired approvals, and validating/marking container resource measurements as non-authoritative.
- Added bounded exit/stdout/stderr diagnostics for real Docker conformance failures and normalized temporary conformance paths across macOS/Linux.
- Fixed the sandbox image to include the Python 3 standard library required by its trusted entrypoint, with a repository guard against minimal-only regressions.
- Made file-size conformance recognize both Linux `SIGXFSZ` and the bounded `/tmp` filesystem reaching `ENOSPC`; the synthetic fixture frees its probe file so the trusted resource report can still be written.
- Converted the Viewer to a client-only SPA with a strict self-only script CSP and an externalized Nuxt bootstrap, removing remote fonts and inline executable scripts.
- Added one server-side active-content pipeline for Markdown, Ask answers, Notebook Markdown, static HTML previews, and paper metadata URLs.
- Replaced executable HTML previews with explicit scriptless static previews; Notebook HTML/SVG/JavaScript outputs are shown as blocked text, and SVG files are source/download only.
- Added active-content unit, static-source, real HTTP, and browser canary coverage for CSP, sanitization, rich-output downgrade, and safe raw headers.
- Incorporated independent P0-A2 review feedback by removing a misleading unused v-html policy export and preserving complex KaTeX layout classes through the sanitizer.
- Bound the Viewer to IPv4 loopback and added Host, pairing-session, Origin, and CSRF enforcement for library APIs.
- Added shared no-follow/realpath library resolution, public-file budgets, fail-fast operation locks, and safer tag/Ask boundaries.
- Replaced permanent paper deletion with session-bound confirmation tokens, persistent recoverable trash, and Viewer restore controls.
- Added unit and real HTTP security integration coverage using isolated temporary paper libraries.
- Made `plugins/codex-paper/` the only executable source tree and `.agents/plugins/marketplace.json` the only repository marketplace.
- Added an immutable 2.0 contract baseline, compatible 2.1 evolution ADR, and a dependency-free repository/CI contract gate.
- Updated plugin ingestion metadata to current Codex manifest and agent interface requirements.
- Removed the divergent legacy tree; it remains available through Git history.

## 2.0.0 - Evidence and Reasoning v2

- Added page-aware `evidence-ledger.json` with stable evidence IDs and parser quality flags.
- Added `reasoning-analysis.json`, reasoning scaffolding, paper profiles, self-review checklist, and semantic validation.
- Integrated v2 reasoning validation into study-package validation while preserving v1 `--legacy-ok` compatibility.
- Added reasoning and package benchmark suites alongside the existing parser benchmark.
- Added Web UI reasoning path, reviewer view, and evidence audit APIs with v1 fallback behavior.
- Added `paper-only`, `canonical`, and `literature` context modes with external evidence isolated in `.codex-paper/external-evidence.json`.
- Added v1 migration tooling, CI coverage, and v2 contract documentation.
