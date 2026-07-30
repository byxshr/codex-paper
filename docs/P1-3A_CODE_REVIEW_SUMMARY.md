# P1-3a Code Review Handoff

## Review focus

- Verify the production parser accepts only the canonical managed CPython runtime and cannot move that anchor through caller environment variables.
- Verify the private runtime contains its executable, standard library, and PyMuPDF, and remains usable after the bootstrap installation disappears.
- Verify runtime replacement is serialized, rollback-safe, recoverable after stale locks, and path-redacted on failure.
- Verify dependency and secret-scan commands validate their own policy inputs and preserve security-finding precedence.
- Verify dependency exceptions are exact, justified, expiring, and cannot cover critical findings.
- Verify the sandbox contains neither pip nor npm and imports shared-library-backed standard-library modules.
- Verify Nuxt 4 preserves the P0-A1/A2 loopback, authentication, CSP, and active-content boundaries.
- Verify both sandbox runtimes come from digest-pinned official images and conformance checks exact versions.

## Intended outcomes

- Plugin npm audit: zero vulnerabilities.
- Web npm audit: only the reviewed temporary Nuxt ecosystem high set; zero critical.
- Mandatory deterministic PDF benchmark: 2/2 under the managed PyMuPDF 1.28.0 runtime.
- Existing identity, storage, publication, validation, Viewer security, and smoke contracts remain unchanged.
- Existing generations and generation manifests remain untouched; P1-4 consumes the machine-readable runtime baseline later.

## Implemented surface

- Host policy is fixed at Node 22.23.1, npm 10.9.8, CPython 3.11.15, and PyMuPDF 1.28.0.
- `runtime-setup` creates a private, self-contained CPython tree, copies the executable, standard library, and a minimal native-library set without symlinks, relocates native references, installs PyMuPDF from four hash-locked wheels, and verifies the complete published tree before discarding the previous runtime.
- Parser, benchmark, image extraction, and PDF-producing tests use the managed interpreter rather than a global `fitz`.
- Nuxt is upgraded to 4.5.1 with an explicit legacy source layout; SSR, DevTools, telemetry, `@nuxt/content`, and the unused DevTools API are disabled or removed.
- Dependency exceptions bind exact packages, vulnerable ranges, installed node paths, reachability, mitigations, and expiration.
- Secret scanning covers tracked text and budget-bounded binary content without printing matched values.
- Supply-chain checks cover npm sources/integrity, Python wheel hashes, Docker digests, GitHub Action SHAs, and reviewed artifact hashes.
- The sandbox final stage is the digest-pinned CPython 3.11.15 image; it receives only the Node 20.20.2 binary from the separately pinned Node stage.

## Review remediation disposition

Adopted from round 1:

- Corrected the study image-extraction command and added a repository mutation guard.
- Rebased the sandbox final image on digest-pinned Python and added build-time/runtime imports for extension-backed standard-library modules.
- Added locked, rollback-safe runtime publication, interrupted-publication recovery, dependency-policy schema validation, advisory-shape diagnostics, immutable workflow references, and a post-install supply-chain gate.
- Routed fixture provenance through the managed interpreter, closed unchecked production overrides, added a Node 22 `pdf-parse` fallback test, and bounded title matching to the front-matter window.
- Converted missing tracked secret-scan inputs into configuration errors and documented the fail-closed oversized-file policy.

Adopted from round 2:

- Replaced executable-only containment with self-contained runtime verification: the executable, `sys.base_prefix`, standard library, representative modules, executable hash, and stable standard-library tree hash must all match the private published tree. Runtime bytecode caches are excluded so normal use cannot invalidate the marker.
- Expanded ephemeral-root detection and diagnostic redaction to `/tmp`, `/var/tmp`, their macOS aliases, and the platform temp directory.
- Prevented parent parser processes from accepting a caller-moved `CODEX_PAPER_MANAGED_PYTHON_BIN`; the variable is accepted only inside the already supervised worker boundary.
- Removed ambient production test switches. Focused tests inject parser failure through an internal test-only function parameter.
- Memoized interpreter conformance probes, increased the output budget, and separated unavailable-runtime diagnostics from version mismatch diagnostics.
- Made real secret findings outrank simultaneous configuration errors, and made dependency/secret engines validate their own policies when invoked directly.
- Added a 30-minute stale-lock recovery boundary, consistent exit `3` classification, and documented manual recovery.
- Cross-checked production Node pins against the runtime baseline and added `repo-test` for Python-free static guard testing.
- Added explicit sandbox assertions for both pip and npm absence.
- Added `scripts/common.sh`, Repository Guard, and the supply-chain tests to reviewed artifact hashes. These hashes provide review visibility, not independent tamper resistance.
- Added mutation/failure tests for the caller-moved parser anchor, runtime containment controls, destructive-rebuild canary, lock recovery, policy self-validation, finding precedence, and post-publication verification rollback.

Adopted from round 3:

- Made native self-containment part of the host contract: setup and status import extension-backed standard-library modules, copy only required top-level shared libraries, dereference nested symlinks, rewrite macOS bootstrap install names, and reject residual bootstrap references with `otool`/`readelf`.
- Replaced partial attestation with a complete managed-tree hash covering `pyvenv.cfg`, `bin/`, standard-library files, extension modules, PyMuPDF, and native libraries; only the marker and generated bytecode caches are excluded.
- Enforced version and containment again at the parser use point and forwarded only the resolved runtime root through the bounded launcher. The obsolete caller-movable canonical interpreter variable is no longer part of the handoff.
- Split title extraction from parser compatibility tests and added exact per-file execution-count gates, closing the silent Node test-runner drop on both the local and pinned Node versions.
- Aligned host and sandbox installer cleanup for `pkg_resources`, skipped unsafe implicit bootstrap candidates while preserving explicit fail-closed behavior, removed fabricated `pyvenv.cfg` command provenance, and added safe import entrypoint guards to all policy engines.
- Added mutation coverage for native relocation/verification, full-tree attestation, minimal native copying, parser root containment, and exact parser test counts.

Adopted from round 4:

- Extended macOS relocation and verification to `LC_RPATH` entries using `otool -l` and `install_name_tool -rpath`; load commands, dylib IDs, and search paths now share one bootstrap-prefix rejection boundary.
- Made native publication verification explicit and environment-independent: native imports run with Python and loader overrides removed, `runtimeStatus` exposes `nativeRuntimeSelfContained`, and Linux fails closed when `readelf -d` finds an absolute bootstrap RPATH/RUNPATH. Linux ELF rewriting is intentionally not introduced in P1-3a.
- Extended exact execution-count gates to the complete repository/security and study suites. Any test failure or count drift preserves its TAP output in a named temporary file for diagnosis.
- Added native-module checks to bootstrap discovery, included file modes in complete-tree attestation, normalized copied modes after umask-sensitive creation, and documented the required macOS/Linux inspection tools.
- Clarified that `CODEX_PAPER_RUNTIME_DIR` is a trusted same-UID operator configuration input, not a cryptographic runtime identity. Rehashing the 159 MiB tree at every parse was not adopted because it would not create an independent same-UID trust boundary.

Round 5 independent review conclusion:

- PASS: every blocker and medium finding from rounds 1–4 was closed and re-verified with the original failing probes. Round 5 found no P1-3a defect.
- The pre-existing, load-sensitive `concurrent atomic writers leave one complete schema-valid report` test flake is tracked separately from P1-3a. The exact-count gate intentionally continues to surface it, and preserved TAP output makes any occurrence diagnosable.
- The review's `nativeRuntimeSelfContained` naming refinement and `observed()` environment-forwarding note are optional cleanup, not correctness or security gaps. The existing probe runs with loader/Python overrides removed, while native-reference verification and complete-tree attestation enforce the underlying property.
- Linux runtime publication and real Docker dual-runtime conformance remain required remote CI evidence before the stage is considered delivered.

Not adopted:

- `PaperAnalysisHero.vue` remains untouched because it is an unrelated untracked user file outside P1-3a.
- Exact advisory-set equality remains fail-closed. A repaired advisory requires removal of the obsolete exception instead of silently passing.
- Docker is not installed on the review Mac. Static and mutation checks cover the image contract locally; real image build and conformance remain a required remote CI gate.
- The round-5 optional renaming/environment-plumbing nits are deferred to P1-3b because they do not change the verified runtime boundary.

## Local verification

- Managed runtime status is conformant under Node 22.23.1/npm 10.9.8. CPython 3.11.15, its standard library, extension-backed modules, native libraries, and PyMuPDF 1.28.0 resolve inside the private runtime.
- With the bootstrap directory temporarily moved aside, the managed interpreter still imported `bz2`, `ctypes`, `lzma`, `readline`, `sqlite3`, `ssl`, `uuid`, `zlib`, and `fitz`; runtime status stayed conformant. The tree contains zero symlinks and no native dependency names the bootstrap prefix.
- Repository Guard mutation tests passed 77/77. Parser compatibility tests passed 4/4 and the split title regression passed 2/2, including caller-moved-anchor rejection and bounded `pdf-parse` fallback.
- The exact-count aggregate repository/security suite now passes 207/207 and the exact-count study suite passes 87/87 under Node 22.23.1/npm 10.9.8; supply-chain tests pass 21/21 and PDF ingestion security passes 12/12. The three-count increase is the reviewed Linux venv-alias plus ELF relocation coverage added from remote CI evidence.
- Runtime marker 1.5 is conformant. A bootstrap-absent probe with hostile `DYLD_LIBRARY_PATH`, `LD_LIBRARY_PATH`, and `PYTHONPATH` values still reported `nativeRuntimeSelfContained=true`, `managedRuntimeContained=true`, and `marker=true`; no Mach-O load command or `LC_RPATH` contained the bootstrap prefix.
- Mandatory regression passed 2/2; external parser corpus passed 5/5; reasoning and package benchmarks passed 12/12 each.
- Dependency audit passed: plugin 0 vulnerabilities; Web 12 reviewed high and 0 critical, with the exception expiring 2026-08-31. Secret scan passed over 274 tracked files.
- Nuxt 4 production build, Viewer HTTP security integration, smoke test, official plugin validation, marketplace reinstall, and post-install supply-chain verification passed.
- Active plugin path is `plugins/codex-paper`; cachebuster version is `2.0.0+codex.20260728114120`.
- Docker remains unavailable locally; full dual-runtime conformance must pass in remote CI.
- The fifth independent review passed with no P1-3a defects; delivery remains conditional on green remote Linux/runtime and Docker jobs.

## Deliberate deferrals

P1-3b owns the root npm workspace, `npm ci`, strict TypeScript/lint, coverage, dependency automation, second runtime/OS matrix, and storage engineering debt. P1-4 owns authoritative provenance integration.
