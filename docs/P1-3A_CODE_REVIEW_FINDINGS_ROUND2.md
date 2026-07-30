# P1-3a Code Review — Round 2 Findings

**Scope:** the P1-3a remediation applied after `docs/P1-3A_CODE_REVIEW_FINDINGS.md` (v1 + merged v2 items), as dispositioned in `docs/P1-3A_CODE_REVIEW_SUMMARY.md`.
**Reviewed at:** 2026-07-28, branch `codex/audit-optimizations-2026-07-10`.
**Method:** re-read every changed file, then executed the policy engines, the four affected suites, and targeted empirical probes against the real managed runtime on the review machine.

**Verdict:** all three round-1 blockers are genuinely closed, and the sandbox fix is better than what round 1 proposed — inverting the image so the final stage *is* the digest-pinned CPython, with build-time import and Node-version assertions, removes the entire failure class rather than papering over it. Two new blockers remain, both inside the runtime-containment story this remediation was specifically built to establish, and both reproduced on this machine: the managed runtime loads its whole standard library from `/tmp` while `runtime-status` attests containment, and the canonical-interpreter anchor is still movable by an environment variable, so the host executes an out-of-tree interpreter. Neither is a regression from round 1; both are gaps in the new controls, and both have small, targeted fixes.

---

## Evidence collected

| Check | Result |
| --- | --- |
| `node scripts/supply-chain-check.mjs` | `pass`, exit 0 |
| `node scripts/secret-scan.mjs` | `pass`, 274 tracked files, exit 0 |
| `node scripts/check-repository.mjs` | Repository contract passed (274 files) |
| `node --test scripts/tests/supply-chain.test.mjs` | 13/13 |
| `node --test scripts/tests/check-repository.test.mjs` | 71/71 |
| `node --test plugins/codex-paper/skills/study/scripts/tests/parse-pdf-compat.test.mjs` | 5/5 |
| `node --test scripts/tests/pdf-ingestion-security.test.mjs` | 12/12 |
| `node scripts/runtime-policy.mjs status` | `nonconformant` — only `node`/`npm` fail (host is 22.16.0 / 11.5.2) |

---

## Blocking

### R2-B1 — The managed runtime loads its entire standard library from `/tmp`, while `runtime-status` attests containment (HIGH)

`--copies` copies the *interpreter binary*, not the standard library. Verified against the runtime this machine actually has installed:

```
$ cat ~/.cache/codex-paper/runtime-v1/python-3.11.15/pyvenv.cfg
home = /tmp/codex-paper-python-3.11.15/bin
executable = /private/tmp/codex-paper-python-3.11.15/bin/python3.11

$ ls ~/.cache/codex-paper/runtime-v1/python-3.11.15/lib/python3.11/
site-packages                      # ← the stdlib is not here

$ .../python-3.11.15/bin/python -c "import os, sysconfig; print(os.__file__); print(sysconfig.get_path('stdlib'))"
/tmp/codex-paper-python-3.11.15/lib/python3.11/os.py
/tmp/codex-paper-python-3.11.15/lib/python3.11

$ ls -ld /tmp/codex-paper-python-3.11.15
drwxr-xr-x  10 bianyuxin  wheel  320  /tmp/codex-paper-python-3.11.15
```

Both checks added for S1 pass on this runtime:

```
checks = { platform: true, node: false, npm: false, python: true,
           managedExecutableContained: true, marker: true }
```

and the marker asserts the opposite of the truth:

```json
"bootstrap": { "version": "3.11.15", "temporaryPathExplicitlyApproved": false }
```

**Root cause of the false attestation.** `isTemporaryBootstrap` (`runtime-policy.mjs:200-203`) tests containment against `realpathSync(os.tmpdir())`. On macOS `os.tmpdir()` is `$TMPDIR` = `/var/folders/9n/…/T`, not `/tmp`, so `path.relative` between them starts with `..` and a `/tmp` bootstrap is classified non-temporary. On Linux `os.tmpdir()` *is* `/tmp` — but only while `TMPDIR` is unset, which is untrue in most containers, devcontainers, and CI images. So `/tmp` and `/var/tmp` are unguarded on macOS and conditionally unguarded on Linux, and the explicit-approval escape hatch was never even reached here.

**Failure — availability:** removing or upgrading the bootstrap installation (a `brew upgrade python@3.11`, a tool-cache eviction, a reboot that clears `/tmp`) breaks the parser, the mandatory benchmark, and two suites. `managedExecutableContained` and `marker` still report true; the failure only surfaces when the interpreter is actually spawned.

**Failure — integrity:** `/tmp` is world-writable with the sticky bit. Sticky protects *existing* entries; it does not stop anyone from creating `/tmp/codex-paper-python-3.11.15` after a cleaner or reboot removes it. Whoever wins that race owns every stdlib module the parser imports — `os`, `json`, `pathlib` — inside the process that then imports `fitz` and reads untrusted PDF bytes. That is a cross-user local boundary, not the same-UID scenario S1 explicitly de-scoped as "not a separate strong security boundary".

The `0700` runtime root, the `managedExecutableSha256` verification, and `assertNoSymlinkComponents` all protect the 6 MB binary. Nothing protects the ~200 modules it loads.

**Fix:**
1. Record `sys.base_prefix` and `sysconfig.get_path('stdlib')` in the marker, and add a `managedStdlibContained` check that requires the stdlib to resolve either inside the private runtime root or inside a non-world-writable, root-or-self-owned system prefix. Verify it in `runtimeStatus`, not only at setup.
2. Replace `os.tmpdir()`-relative detection with a fixed ephemeral-root set — `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var/tmp`, plus `os.tmpdir()` — and additionally reject any bootstrap prefix with a group- or world-writable component.
3. Rename `managedExecutableContained`; it promises less than any reader will assume alongside a `conformant` verdict.
4. Strongest option, and the one that makes the documented claim literally true: copy `lib/python3.11` from `base_prefix` into the runtime tree at setup so the tree is genuinely self-contained, and drop the bootstrap dependency entirely after publication.
5. Rebuild the review machine's runtime from a stable bootstrap before re-recording local verification — the currently recorded "Runtime status is conformant" was measured on the configuration this finding describes.

`docs/dependency-runtime-supply-chain-policy.md` should also state plainly that the bootstrap installation must remain present, or that it need not — whichever the fix chooses. Today it says only "builds with copied interpreter binaries", which reads as self-containment.

### R2-B2 — `CODEX_PAPER_MANAGED_PYTHON_BIN` moves the canonical anchor, so the host executes an out-of-tree interpreter (MEDIUM-HIGH)

`parse-pdf.js:26`:

```js
const CANONICAL_PYTHON_PATH = process.env.CODEX_PAPER_MANAGED_PYTHON_BIN || MANAGED_PYTHON_PATH;
```

`resolveParserPython` compares the requested interpreter against this anchor — which the caller supplies. Demonstrated with a byte-copy of the managed runtime placed outside the tree (`/tmp/outoftree`, genuinely CPython 3.11.15 + PyMuPDF 1.28.0, so it satisfies the version probe):

```
# A: override alone → correctly rejected before execution
$ CODEX_PAPER_PYTHON_BIN=/tmp/outoftree/bin/python node .../parse-pdf.js /tmp/probe.pdf
Error parsing PDF: Noncanonical parser runtime overrides are disabled.

# B: move the anchor too → parent accepts and EXECUTES it; only the worker aborts
$ CODEX_PAPER_PYTHON_BIN=/tmp/outoftree/bin/python \
  CODEX_PAPER_MANAGED_PYTHON_BIN=/tmp/outoftree/bin/python node .../parse-pdf.js /tmp/probe.pdf
Error parsing PDF: PDF parser worker failed: parser_runtime_nonconformant: Noncanonical parser runtime overrides are disabled.
```

In case B no test-override flag was set. The parent's `resolveParserPython` passed, so `runBoundedParser` reached `spawn(python, ['-I', '-B', PARSER_LAUNCHER_PATH, …])` and the out-of-tree binary **ran** — that is what produced the worker's stderr. The parse then failed only because `runBoundedParser:801` hardcodes `CODEX_PAPER_MANAGED_PYTHON_BIN: MANAGED_PYTHON_PATH` for the child, resetting the anchor the parent had honoured. Defense-in-depth saved the *result*; it did not prevent the *execution*.

This makes the policy doc's "noncanonical `CODEX_PAPER_PYTHON_BIN` overrides are never accepted as the production parser runtime" false for the outer process, and it is the one hole left in the S6 remediation.

**Fix:** the env variable exists only so the launcher can tell the worker its canonical path, and the launcher already sets `CODEX_PAPER_PARSER_WORKER=1` in `safe_env`. So gate it:

```js
const CANONICAL_PYTHON_PATH = process.env.CODEX_PAPER_PARSER_WORKER === '1'
  ? (process.env.CODEX_PAPER_MANAGED_PYTHON_BIN || MANAGED_PYTHON_PATH)
  : MANAGED_PYTHON_PATH;
```

Add a mutation test for exactly the case-B env pair; the existing suite covers case A only.

---

## Medium

### R2-M1 — `sanitizeDiagnostic` leaks `/tmp` paths on macOS

Same root cause as R2-B1. The replacement table covers `runtimeRoot`, `os.homedir()`, and `realpathSync(os.tmpdir())` / `os.tmpdir()` — none of which is `/tmp` on macOS, which is exactly where this machine's bootstrap lives:

```
$ sanitizeDiagnostic('pip failed for /tmp/codex-paper-python-3.11.15/bin/python and <tmpdir>/x and <home>/y')
pip failed for /tmp/codex-paper-python-3.11.15/bin/python and <temporary>/x and ~/y
```

The existing redaction test passes because it exercises `os.tmpdir()`-based paths. **Fix:** redact the same fixed ephemeral-root set proposed in R2-B1 step 2, and extend the test to assert a literal `/tmp/...` input is redacted.

### R2-M2 — Secret-scan status precedence masks a real leak behind a configuration error

`secret-scan.mjs:80`: `configurationErrors.length ? 'configuration_error' : findings.length || errors.length ? 'fail' : 'pass'`. One unreadable tracked file demotes a genuine secret finding to a configuration verdict:

```
status: configuration_error
findings: 1 github-token
configurationErrors: 1
=> CLI would exit 2
```

Both codes are non-zero so CI still fails, but the headline says "configuration_error", and any wrapper that treats exit 2 as a retryable environment problem will retry instead of escalating a leaked credential. The S7 remediation correctly separated the two classes; it just ordered them wrong.

**Fix:** findings take precedence — `findings.length ? 'fail' : configurationErrors.length ? 'configuration_error' : errors.length ? 'fail' : 'pass'` — and keep printing both lists.

### R2-M3 — The setup lock is unreclaimable after a crash on a different hostname, with no TTL and no documented recovery

`acquireSetupLock` (`runtime-policy.mjs:257`) reclaims a stale lock only when `owner.hostname === os.hostname() && !processAlive(owner.pid)`. Containers, devcontainers, and most CI runners get a new hostname per run, so a crashed or killed `runtime-setup` leaves a lock that can never be auto-cleared: every later attempt throws `runtime setup is already in progress`, a message that describes a transient state for a permanent one. The runtime directory persists across container rebuilds whenever `~/.cache` or `CODEX_PAPER_RUNTIME_DIR` is a mounted volume, which is the common developer setup.

Two smaller defects in the same function: the terminal `throw new Error('unable to acquire runtime setup lock')` carries no `exitCode`, and `acquireSetupLock` is called at `:343`, *before* `setupRuntime`'s `try` at `:345`, so the `error.exitCode ||= EXIT.UNAVAILABLE` default never applies — the lock failures surface as exit 2 (invalid configuration) rather than exit 3 (capability unavailable), contradicting the exit-code table in the policy doc.

**Fix:** stamp the lock with a monotonic creation time and reclaim past a TTL regardless of hostname; set `exitCode = EXIT.UNAVAILABLE` on every lock error; name the recovery path (`rm -rf "$RUNTIME_ROOT/.runtime-setup.lock"`) in both the message and the policy doc.

### R2-M4 — The new baseline cross-check covers the Python path sites but not the Node pins

The `runtimeSites` table in `check-repository.mjs` is a real improvement and closes the production half of round-1 M3 — `common.sh`, `runtime-python.sh`, `parse-pdf.js`, and `run-mandatory-benchmark.mjs` are now all compared against `security/runtime-baseline.json`. But `22.23.1` is still hardcoded with no comparison in:

- `scripts/common.sh:22` — `NODE_REQUIRED="22.23.1"`
- `plugins/codex-paper/scripts/start-webui.sh:26-27`

so bumping `host.node` updates the guard's own literals and `ci.yml` while leaving every `codex-paper.sh` subcommand and the Viewer launcher rejecting the new version. **Fix:** add both to `runtimeSites` keyed on `runtime?.host?.node`. Three test files (`parse-pdf-compat.test.mjs`, `pdf-ingestion-security.test.mjs`, `supply-chain.test.mjs`) also still hardcode `python-3.11.15`; those fail loudly rather than silently, so they are lower priority.

### R2-M5 — The audit and scan engines still trust their own policy files; only CI ordering makes that safe

`validateDependencyPolicy` is excellent, but it lives in `checkSupplyChain` and runs only under `supply-chain-test`. `dependency-audit` reads the same policy directly and does `[...item.nodes]` at `:61` — a `TypeError` if `nodes` is missing — and `secret-scan`'s `allowed()` compares `expiresOn` with no format validation. Running either command standalone against a malformed policy produces an unhandled exception whose exit code (1) collides with `EXIT.POLICY`, i.e. it looks like a policy violation rather than a configuration error. This is the same "safe only by step ordering" pattern round 1 flagged for `npm install`, and that one was fixed properly by re-running the gate.

**Fix:** call `validateDependencyPolicy` at the top of `auditDependencies` and validate the secret-scan policy in `scanRepository`, returning `kind: 'config'` / exit 2 on failure.

---

## Low

### R2-L1 — Hash-pinning the policy engines is review visibility, not tamper resistance

`security/supply-chain-review.json` now pins `runtime-policy.mjs`, `dependency-audit.mjs`, `secret-scan.mjs`, and `supply-chain-check.mjs` — a real improvement over round 1. But `supply-chain-check.mjs` computes the hash of itself, so a coordinated edit to engine + recorded hash passes cleanly; the control forces the review file into the diff rather than preventing the change. Still unpinned: `scripts/check-repository.mjs`, `scripts/tests/supply-chain.test.mjs`, and `scripts/common.sh` — the last of which now carries the version pins and the `ensure_python` containment check, so it can be weakened without any hash tripping. Worth restating precisely in the summary, which currently reads as though the engines are protected rather than merely watched.

### R2-L2 — Conformance asserts pip absence but not npm, though the review focus claims both

`sandbox-code.js` and the Dockerfile both assert `shutil.which("pip") is None` and that `pip`/`setuptools`/`wheel` have no importable spec. Review focus line 10 says "contains neither pip nor npm". npm cannot be present — only `/usr/local/bin/node` is copied from the node stage — but nothing asserts it, so the claim is not self-verifying. One `shutil.which("npm") is None` in both places closes it.

### R2-L3 — The interpreter probe re-runs per call with a 4 KiB buffer and conflates two failure modes

`resolveParserPython` spawns `python -I -B -c 'import fitz…'` on every invocation (`readWithPyMuPdf` and `runBoundedParser`) with `maxBuffer: 4096`. A Python traceback or warning stream over 4 KiB makes `spawnSync` return `status: null` with `ENOBUFS`, which reports the misleading "Managed parser runtime must be CPython 3.11.15 with PyMuPDF 1.28.0". **Fix:** memoize the probe per process, raise the buffer, and distinguish "probe could not run" from "probe reported a mismatch".

### R2-L4 — The test-only switches are ambient env vars reachable in production

`CODEX_PAPER_ALLOW_TEST_PYTHON_OVERRIDE=1` plus `CODEX_PAPER_FORCE_PYMUPDF_FAILURE=1` silently downgrades every parse to the `pdf-parse` fallback (no layout, weaker extraction), and the allow flag alone skips the `lstat` containment check in `resolveParserPython`. The version probe still applies unconditionally, and requiring two variables is a defensible design — but `pdf-parser-launcher.py` now forwards both into the bounded parser's previously 4-variable allowlisted `safe_env`, so the switches reach the most privileged part of the pipeline. Consider binding the flag to a test-only sentinel (a file under the repo test tree, or `CODEX_PAPER_PARSER_WORKER` plus that sentinel) rather than an inheritable environment variable.

### R2-L5 — `cmd_test` now requires a conformant Python runtime for purely static guard tests

Adding `ensure_pymupdf` to `cmd_test` is correct for S6, but `scripts/tests/*.test.mjs` includes the Repository Guard suite, which is static text analysis. A docs-only or guard-only change now needs a full managed runtime to run 71 tests that never touch Python. Consider a static-only path alongside `repo-check`.

### R2-L6 — Two small `common.sh` roughnesses

`ensure_python`'s containment comparison runs `cd "$(dirname "$MANAGED_PYTHON")"`; when the managed runtime does not exist that emits a spurious `cd: no such file or directory` to stderr before failing closed for the right reason. Separately, `ensure_pymupdf` asserts `platform.python_version()` and `fitz.__version__` but omits the `python_implementation()` assertion that `resolveParserPython` makes — harmless, but the two runtime gates should say the same thing.

### R2-L7 — The anti-destructive-rebuild guard is a source-text canary

`check-repository.mjs` rejects `/rmSync\(target,\s*\{\s*recursive:\s*true/` in `runtime-policy.mjs`. That catches a literal regression and nothing else — renaming the variable, or using `rmSync(path.join(root, name), …)`, passes. It is a reasonable canary; it should be labelled as one rather than read as a semantic guarantee, since the real protection is `publishPreparedRuntime`.

### R2-L8 — `docs/P1-3A_CODE_REVIEW_SUMMARY.md` has stranded and now-stale content

Lines 49-51 are three orphaned "Implemented surface" bullets left below the "Review remediation disposition" section, after the Docker paragraph. Line 50 also still describes the pre-remediation composition — "the sandbox now copies CPython 3.11.15 from a digest-pinned official image while retaining its separately pinned Node 20.20.2 runtime" — whereas the image was inverted: it now copies *Node* into the digest-pinned CPython image, which is the whole reason R2's sandbox fix works. Line 55 reports "Repository Guard mutation tests passed 69/69"; the suite is now 71.

---

## Round-1 findings verified closed

Each confirmed by reading the change and, where executable, by running it.

| Item | Status |
| --- | --- |
| **B1** Step 9 command | Fixed to `bash ../../scripts/runtime-python.sh ./scripts/extract-images.py`, with a Repository Guard mutation test that fails on the wrong form. Both pass. |
| **B2** Sandbox stdlib | Fixed better than proposed: the final stage is now `python:3.11.15-slim-bookworm`, so every Debian runtime library comes with it, and only `/usr/local/bin/node` is copied in. Build-time `python3 -I -B -c 'import bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib'` and `test "$(node -p 'process.versions.node')" = "20.20.2"` mean a broken composition fails at *build* rather than at a user's first demo; conformance re-checks at run time. Still needs the remote Docker gate to confirm — Docker remains unavailable here — but the blast radius moved from silent to build-breaking. |
| **B3** Destructive rebuild | Fixed: `publishPreparedRuntime` renames the old target to `.previous`, rolls back on rename failure, and `recoverInterruptedPublish` handles both interrupted states; `setupRuntime` re-verifies post-install before publishing; a guard forbids the old `rmSync(target, …)`. |
| **M1** Exception schema | Fixed: `validateDependencyPolicy` enforces a valid ISO `expiresOn` within `exceptionMaximumDays` of `reviewedAt`, unique lockfiles, non-empty `node_modules/`-prefixed nodes, and minimum-length reachability/mitigations/decision; `evaluateAudit` now treats an invalid `expiresOn` as an error rather than as absent. Tested. |
| **M2** Drift direction | Fixed: distinct `added` / `disappeared` / `shape changed` diagnostics, with exact equality deliberately retained as fail-closed. Tested, including the three-way case. |
| **M3** Version literals | Partially fixed — see R2-M4. The four production Python-path sites are now cross-checked against the baseline. |
| **M4** `npm install` vs pinned lockfiles | Fixed: CI re-runs `supply-chain-test` after `install`, and a guard test enforces both the second occurrence and its ordering relative to install. The policy doc states installation must leave reviewed lockfiles byte-for-byte unchanged. |
| **M5** `--legacy-peer-deps` | Fixed: `peerDependencyRelaxations` records flag, lockfile, expiry (2026-08-31), reason, reachability, mitigations, and `decision: remove_or_replace_in_p1-3b`, and is schema-validated with a mutation test. |
| **M6** Global `python3` | Fixed everywhere: the generator test, `benchmarks/README.md`, both fixture manifests, `contract.mjs`, and `check-repository.mjs` all now use `bash plugins/codex-paper/scripts/runtime-python.sh`. |
| **L1** Host version in container message | Fixed: `\${process.versions.node}` correctly escaped, and the guard asserts the escaped form so it cannot silently regress. |
| **L2 / S7** Path leakage | Fixed for the cases covered by `sanitizeDiagnostic` (runtime root, home, tmpdir, URL userinfo), applied in `main`'s catch and both setup failure messages. Residual: R2-M1. |
| **L3** pip in the sandbox | Fixed in both places: removed from the image and from the venv (`removeInstallerArtifacts`), asserted absent at build time and in conformance. |
| **L4 / S7** Secret-scan robustness | Fixed: missing/unreadable tracked files become `configurationErrors` with exit 2, and the 8 MiB fail-closed budget is now documented. Residual: R2-M2 precedence. |
| **L5** Windows | Fixed: `win32` branch removed, `SUPPORTED_PLATFORMS` check added to status and setup, and Windows documented as intentionally unsupported. |
| **L6** Engines unpinned | Fixed as change-detection — see R2-L1 for what that does and does not buy. |
| **L7** npm pin | Fixed: CI installs `npm@10.9.8 --ignore-scripts` explicitly, and the guard requires that step. |
| **L8** Title window | Fixed: `MAX_METADATA_TITLE_BLOCKS = 8`, `MAX_FRONT_MATTER_BLOCKS = 16`, search restricted to the front-matter region, plus a five-block-split regression test. Passes. |
| **L9** `PaperAnalysisHero.vue` | Deliberately not adopted as an unrelated untracked user file. Reasonable; it stays out of the P1-3a diff either way. |
| **S1** External interpreter | Partially — `--copies` and the containment check are real, but see R2-B1: the stdlib dependency is unaddressed and the temporary-path detector misses `/tmp`. |
| **S2** `uses:` parsing | Fixed: `checkWorkflowUses` parses every non-empty value, permits repository-local composite actions, requires 40-hex for external actions, requires a digest for `docker://`, and fails closed otherwise; duplicated in `check-repository.mjs`; mutation-tested for all four forms. |
| **S3** Parent symlinks | Fixed: `assertNoSymlinkComponents` walks every component from the filesystem root. Parent *permissions* remain unchecked — folded into R2-B1 step 2. |
| **S4** Relocated venv shebangs | Moot: with `--copies` all three `bin/python*` entries are real 6 MB copies (verified), and the pip console scripts are deleted, so no stale shebang survives. |
| **S5** `pdf-parse` fallback | Fixed, and it earned its keep — the work surfaced a real Node 22 defect and the fix is well-founded: `pdf(new Uint8Array(dataBuffer))` hands PDF.js a zero-offset copy instead of a pooled `Buffer` whose `byteOffset` the bundled PDF.js ignores. Test passes. |
| **S6** Override bypass | Partially — `resolveParserPython`, the `ensure_python` containment check, the launcher's runtime-identity requirement, and `cmd_test`'s `ensure_pymupdf` are all real. See R2-B2 for the remaining anchor hole. |

---

## Recommended order of work

1. **R2-B1** — restore real containment (or state honestly that the bootstrap must persist), fix the ephemeral-root detection, and add a `managedStdlibContained` check. Then rebuild the review machine's runtime and re-record local verification, since the current record was taken on the affected configuration.
2. **R2-B2** — three-line anchor fix plus the case-B mutation test.
3. **R2-M1** — same ephemeral-root set as B1; one shared helper covers both.
4. **R2-M2, R2-M3** — verdict precedence and lock reclaimability; both small and both affect how failures are read.
5. **R2-M4, R2-M5** — finish the cross-check table and make the engines validate their own inputs.
6. **R2-L1, R2-L8** — correct the two over-claims in the summary (engine hashing as tamper resistance; the stale sandbox-composition bullet) and reattach the orphaned bullets.
7. **R2-L2 – R2-L7** — cleanup.

**Still unverified anywhere:** the sandbox image. Docker remains unavailable locally and no CI run is recorded for this branch. Unlike round 1, a green remote run would now be meaningful rather than vacuous — the build-time import and Node-version assertions mean a broken composition cannot pass — so the remote gate is a genuine prerequisite rather than a formality.
