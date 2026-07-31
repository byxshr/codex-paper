# P1-3a Code Review — Round 4 Findings

**Scope:** the remediation applied after `docs/P1-3A_CODE_REVIEW_FINDINGS_ROUND3.md`, as dispositioned in `docs/P1-3A_CODE_REVIEW_SUMMARY.md`.
**Reviewed at:** 2026-07-28, branch `codex/audit-optimizations-2026-07-10`.
**Method:** re-read every changed file, ran the engines and all affected suites, then re-ran the round-3 probes verbatim — removing the bootstrap installation, tampering with `pyvenv.cfg` under backup, and attempting the caller-moved interpreter anchor — plus new Mach-O inspection of the published tree.

**Measurement caveat:** the review host runs Node 22.16.0 / npm 11.5.2, not the pinned 22.23.1 / 10.9.8, and is macOS. The Linux relocation path (R4-M2) cannot be exercised here at all.

**Verdict:** the round-3 blocker is genuinely closed, verified by the exact test that failed last round. With the bootstrap directory removed the managed interpreter now imports `bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib, fitz` cleanly, the tree contains zero symlinks (was 1,037), no native binary names the bootstrap prefix, and the tree shrank from 240 MB to 159 MB. Every round-3 medium and low is closed, each confirmed by direct probe rather than by reading the diff. The summary's numbers match my measurements exactly.

What remains is narrower and mostly about the *reach* of the new checks rather than their correctness: the macOS native verification cannot see `LC_RPATH`, Linux has verification without relocation and no local way to exercise it, and the execution-count gate covers only the two files where a drop was actually observed. Nothing here blocks merge on its own; R4-M2 does mean the remote CI run is a hard gate rather than a formality.

---

## Evidence collected

| Check | Result |
| --- | --- |
| `node scripts/supply-chain-check.mjs` | `pass` |
| `node scripts/secret-scan.mjs` | `pass`, 274 tracked files |
| `node scripts/dependency-audit.mjs` | `pass` — plugin 0/0; web 0 critical / 12 reviewed high |
| `node scripts/check-repository.mjs` | Repository contract passed (274 files) |
| `scripts/tests/*.test.mjs` (aggregate) | 203/203 |
| `scripts/tests/check-repository.test.mjs` | 76/76 |
| `scripts/tests/supply-chain.test.mjs` | 18/18 |
| `scripts/tests/pdf-ingestion-security.test.mjs` | 12/12 |
| study suite (12 files) | 87/87 — every file's registered count now equals its executed count |
| `parse-pdf-compat` / `parse-pdf-title` | 4/4 and 2/2 |

All match the summary's claims.

---

## Medium

### R4-M1 — macOS native verification cannot see `LC_RPATH`, so the clean result depends on the bootstrap's build flags rather than on the check

`verifyNativeReferences` scans `otool -L` output for the bootstrap prefix. `otool -L` lists `LC_LOAD_DYLIB` and `LC_ID_DYLIB` only — it does not list `LC_RPATH`. Demonstrated on the published tree:

```
$ otool -L <runtime>/lib/python3.11/lib-dynload/_ssl.cpython-311-darwin.so
	@rpath/libssl.3.dylib
	@rpath/libcrypto.3.dylib
	/usr/lib/libSystem.B.dylib

$ otool -l …/_ssl.cpython-311-darwin.so | awk '/LC_RPATH/{g=1} g&&/path /{print $2; g=0}'
@loader_path/../../          # invisible to the check that decides publication
```

Every `@rpath/...` reference in the tree resolves through an `LC_RPATH` the verifier never reads. In this tree all 129 rpath-carrying binaries are loader-relative (`@loader_path/`, `@loader_path/../lib/`, `@loader_path/../../`), so the gate passes correctly — but it passes because this bootstrap is a relocatable build, not because the check would have caught the alternative. A bootstrap configured with `LDFLAGS=-Wl,-rpath,<prefix>/lib` (ordinary for source builds, and used by some Homebrew formulations) would leave every `@rpath/...` reference resolving through the bootstrap directory with `verifyNativeReferences` reporting clean — reintroducing R3-B1 silently.

`rewriteMacNativeReferences` has the same blind spot: it rewrites `LC_LOAD_DYLIB` entries and the `LC_ID_DYLIB`, never `LC_RPATH`.

**Fix:** include `otool -l` `LC_RPATH` paths in the substring scan, and in the rewrite step replace or drop absolute rpaths with `install_name_tool -rpath <old> <new>` / `-delete_rpath`. Linux is already covered for this — `readelf -d` reports `RPATH`/`RUNPATH` — so the asymmetry is macOS-only and cheap to close.

### R4-M2 — Linux has verification without relocation, and verification cannot prove containment there

`rewriteMacNativeReferences` is called only `if (process.platform === 'darwin')`; `verifyNativeReferences` runs on both. So on Linux:

- Any absolute bootstrap reference makes `runtime-setup` **throw** rather than repair it. That is correctly fail-closed, but it means whether `runtime-setup` succeeds at all on `ubuntu-latest` depends entirely on how `actions/setup-python`'s 3.11.15 build was linked. `cmd_install` calls `runtime-policy.mjs setup`, so if that Python carries absolute `RUNPATH`s into `/opt/hostedtoolcache/...`, the CI install step fails outright. Nothing local can determine which way it goes.
- Conversely, a bare `NEEDED libssl.so.3` with no `RUNPATH` passes `readelf -d` cleanly while resolving through the system loader — so the copied library in `<runtime>/lib` may be dead weight and containment is unproven. Absence of an absolute reference is necessary, not sufficient.

The only test that actually proves the property is removing the bootstrap and importing the extension modules — which I ran by hand in round 3 (it failed) and round 4 (it passes), and which is not automated anywhere.

**Fix:**
1. Automate the proof: in `publishPreparedRuntime`'s `verify`, run the extension-module probe with the bootstrap prefix excluded from the loader path (or use `ldd` on Linux / `dyld` resolution on macOS and assert every resolved path is inside the tree or a system prefix). This is the check that would have caught R3-B1 without a human, and it generalises across platforms.
2. Add a Linux relocation path (`patchelf --set-rpath '$ORIGIN/../lib'`) or state explicitly in `docs/dependency-runtime-supply-chain-policy.md` that Linux requires an already-relocatable bootstrap and that `runtime-setup` fails closed otherwise.
3. Until 1 or 2 lands, treat the remote CI run as a gate on this specific step, not just on the Docker conformance job.

### R4-M3 — Execution-count gates cover only the two files where a drop was observed, and the drop was never root-caused

R3-M2 is fixed in effect: the file was split into `parse-pdf-compat.test.mjs` (4 tests) and `parse-pdf-title.test.mjs` (2), and I confirmed every one of the 12 study files now has `registered == ran`, totalling 87. The `run_counted_test_file` helper is a good addition, and the Repository Guard enforces both expected counts.

But the gate is applied to exactly those two files. The other ten study files run in a single unchecked `node --test "${regular_study_tests[@]}"` batch, and all eleven `scripts/tests/*.test.mjs` files have no count assertion at all. Since the underlying runner behaviour was worked around rather than diagnosed, any other file can acquire the same silent drop — with `skipped 0`, `todo 0`, `fail 0` and a clean-looking total, exactly as before.

**Fix:** route every test file through `run_counted_test_file`, or assert a per-directory expected total (one number per suite is enough and is cheaper to maintain than per-file counts). The repo already applies "zero or partial execution is a failure" to benchmarks; this extends the same rule to the unit suites, which is what made the round-3 finding possible to state at all.

---

## Low

### R4-L1 — An intermittent study-suite failure was observed once and not reproduced

The first combined study-suite run of this review reported `# tests 87 # pass 86 # fail 1`. Twelve subsequent runs (both reporters) were 87/87. The default reporter had already discarded the failing test's identity by the time I looked, and I could not recover it.

`run_counted_test_file` writes output to a temp file but `rm -f`s it unconditionally, and the unchecked batch captures nothing, so a CI recurrence would be equally undiagnosable. **Fix:** preserve captured output when the status is non-zero (skip the `rm -f` on failure) and apply the same capture to the batch run. Likely candidates given their profile are the concurrency-sensitive `concurrent atomic writers leave one complete schema-valid report` and the multi-second `prepare …` tests, but I am not asserting which — only that a flake exists at roughly 1-in-13 and is currently unattributable.

### R4-L2 — `runtime-setup` gained hard host prerequisites that README does not list

`verifyNativeReferences` throws `otool is required to verify native runtime relocation` when the tool is missing, and `rewriteMacNativeReferences` needs `install_name_tool` and `codesign`. So setup now requires Xcode Command Line Tools on macOS and `binutils` (`readelf`) on Linux — the latter is absent from many minimal Linux images, and `cmd_install` invokes setup. `docs/dependency-runtime-supply-chain-policy.md` describes the behaviour in prose, but README's **System Requirements** still lists only Node, npm, CPython, Codex, and poppler-utils. Add the native toolchain there.

### R4-L3 — `CODEX_PAPER_RUNTIME_DIR` still relocates the parser's whole trust root

`resolveParserPython` is much stronger now — the caller-movable anchor is gone, the interpreter must equal `MANAGED_PYTHON_PATH` *and* be contained in `MANAGED_VERSION_ROOT`, and the probe verifies `basePrefix`/`stdlib`/`osModule` containment at the point of use. But `MANAGED_RUNTIME_ROOT` is itself derived from `process.env.CODEX_PAPER_RUNTIME_DIR`, so a caller who points it at a fabricated-but-internally-consistent CPython 3.11.15 + PyMuPDF 1.28.0 tree satisfies every check: the parser verifies internal consistency, not identity.

This is a documented configuration knob (used by tests, described in the policy doc), so it is by design rather than an oversight. Worth noting because the plumbing for the stronger property is nearly in place: the probe cache key already reads `.codex-paper-runtime.json`'s contents, so having the parser validate `managedTreeSha256` — or refuse a runtime root under an ephemeral path — would close it without new machinery.

### R4-L4 — `bootstrapFacts` does not check what `pythonFacts` now requires

`pythonFacts` imports `bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib`; `bootstrapFacts` imports only `json, platform, sys, sysconfig`. A bootstrap with a broken extension module is therefore accepted at discovery and rejected much later by post-install verification, after a venv creation, a hash-locked download, a full tree copy, and a native rewrite — with the generic message `managed Python runtime failed post-install verification`. Importing the same module set in `bootstrapFacts` fails fast and points at the real cause.

### R4-L5 — The tree hash does not cover file modes, and copied modes are umask-dependent

`sha256Directory` hashes entry type, relative path, and content — not permissions. `copyDereferencedTree` passes `mode: info.mode & 0o777` to `mkdirSync`, which umask can reduce, and file modes come from `cpSync` defaults. So two publications of the same bootstrap under different umasks produce identical `managedTreeSha256` values with different directory permissions. Not a boundary problem — the runtime root is verified `0700` by `assertPrivateDirectory`, and `safeManagedExecutable` checks the interpreter's exec bit specifically — but if the marker is meant to attest the published tree, modes belong in it, and normalising them at copy time is the simpler half of the fix.

---

## Round-3 findings verified closed

| Item | Status |
| --- | --- |
| **R3-B1** runtime unusable without the bootstrap | **Fixed, verified by the failing test from round 3.** With `/tmp/codex-paper-python-3.11.15` moved aside: `import bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib, fitz` → `RUNTIME OK WITHOUT BOOTSTRAP: 3.11.15 1.28.0`, and `runtimeStatus` kept `python: true`, `managedRuntimeContained: true`, `marker: true`. Zero symlinks in the tree (was 1,037); zero native binaries reference the bootstrap prefix (was four dylibs plus 1,037 links). Four independent mechanisms did it: `copyDereferencedTree` resolves every nested symlink and detects cycles, `isSharedLibraryName` restricts the `lib/` copy to `lib*.dylib`/`lib*.so*` (240 MB → 159 MB, 53 entries), `rewriteMacNativeReferences` rewrites absolute install names to `@loader_path/...` and re-signs ad-hoc, and `verifyNativeReferences` fails publication on any residual reference. `pythonFacts` now imports the extension modules, so a broken tree cannot report conformant — the host/sandbox asymmetry that caused the finding is gone. |
| **R3-M1** containment unenforced at use; `pyvenv.cfg` unhashed | **Fixed, verified.** Repointing `pyvenv.cfg`'s `home` at an out-of-tree copy now yields `marker: false` (it is covered by `managedTreeSha256`) *and* `Error parsing PDF: Managed parser runtime failed version or containment verification` — where round 3 parsed the document silently. The probe returns JSON facts and checks `basePrefix`/`stdlib`/`osModule` containment; the cache key includes `pyvenv.cfg` and marker contents, so tampering invalidates memoization. |
| **R3-M2** silently dropped test | **Fixed.** File split; all 6 tests execute; every study file's registered count equals its executed count; total 87 (confirming round 3's arithmetic that 86 was one short). `run_counted_test_file` asserts 4 and 2, and the Repository Guard enforces both numbers. Residual scope: R4-M3. |
| **R3-M3** `CODEX_PAPER_PARSER_WORKER=1` re-opened the anchor | **Fixed, verified.** The three-variable attempt now returns `Noncanonical parser runtime overrides are disabled.` before any execution. `CANONICAL_PYTHON_PATH` is gone entirely; `runBoundedParser` forwards only the resolved `CODEX_PAPER_RUNTIME_DIR`. |
| **R3-L1** partial hash coverage | Fixed: `managedTreeSha256` covers the whole published tree — `bin/`, `lib/*.dylib`, stdlib, site-packages, `pyvenv.cfg` — with only the marker itself (top level only, so a planted nested copy is still hashed) and bytecode caches excluded. |
| **R3-L2** oversized copy | Fixed: `isSharedLibraryName` drops `cmake/`, `pkgconfig/`, `terminfo/`, `itcl`, Tk assets, and `.a` archives. This is also what eliminated the symlink source. |
| **R3-L3** `pkg_resources` asymmetry | Fixed in the Dockerfile `rm` list and in both `find_spec` assertions. |
| **R3-L4** unsafe candidate aborted discovery | Fixed: `assertBootstrapSource` is wrapped so implicit candidates `continue` while an explicitly requested one still throws. |
| **R3-L5** fabricated `pyvenv.cfg` provenance | Fixed: the `command =` line is gone, and the Repository Guard asserts its absence. |
| **R3-L6** entrypoint guards | Fixed: all three engines now guard with `existsSync(process.argv[1])` before `realpathSync`. |

Also good beyond what round 3 asked for:

- The marker's `temporaryPathExplicitlyApproved` is now honest — it reads `true` on this machine, matching the fact that the bootstrap really is under `/tmp` via the explicit approval path. In round 2 the same field read `false` while depending on `/tmp`.
- Mutation coverage was added for native relocation and verification, full-tree attestation, minimal native copying, parser root containment, and the execution-count gates — so each new control has a test that fails when it is removed. 76/76.
- The summary now reports what I measured, including the previously inflated counts, and records the bootstrap-absent experiment as evidence rather than as an assertion.

---

## Recommended order of work

1. **R4-M2 step 1** — automate the bootstrap-absent / resolved-dependency proof in `publishPreparedRuntime`'s verify. It is the one check that would have caught R3-B1 mechanically, it works on both platforms, and it subsumes most of R4-M1's risk.
2. **R4-M1** — add `LC_RPATH` to both the scan and the rewrite on macOS.
3. **R4-M2 steps 2–3** — Linux relocation or an explicit documented fail-closed policy, and a remote CI run gated on the install step specifically.
4. **R4-M3** — extend execution-count gating to every suite.
5. **R4-L1** — preserve failing test output so the flake becomes diagnosable.
6. **R4-L2 – R4-L5** — documentation and hardening cleanup.

**Still unverified anywhere:** the sandbox image, unchanged from previous rounds — Docker is unavailable locally. Two things now depend on a remote run rather than one: the Docker build/conformance job, and the Linux `runtime-setup` path in R4-M2. Both are ordinary CI work; neither is a reason to hold the change if the run is green.
