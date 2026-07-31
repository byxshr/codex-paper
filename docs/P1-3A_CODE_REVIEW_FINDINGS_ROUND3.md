# P1-3a Code Review — Round 3 Findings

**Scope:** the remediation applied after `docs/P1-3A_CODE_REVIEW_FINDINGS_ROUND2.md`, as dispositioned in `docs/P1-3A_CODE_REVIEW_SUMMARY.md`.
**Reviewed at:** 2026-07-28, branch `codex/audit-optimizations-2026-07-10`.
**Method:** re-read every changed file, ran the policy engines and affected suites, then probed the live managed runtime — including moving the bootstrap installation aside and tampering with individual runtime files under backup.

**Measurement caveat:** the review host runs Node 22.16.0 / npm 11.5.2, not the pinned 22.23.1 / 10.9.8. Everything below was reproduced by invoking the engines and suites directly; the two findings that depend on runner behaviour (R3-M2) or host toolchain must be re-confirmed on the pinned runtime.

**Verdict:** round 2's two blockers are addressed, and the central one is a real structural fix — the standard library, `sys.base_prefix`, `os`, and PyMuPDF now all resolve inside the private tree, verified directly. Every round-2 medium and low is closed, and the summary is now accurate and appropriately hedged about what artifact hashing does and does not buy.

One blocker remains, and it is the same class as R2-B1 rather than a new one: the tree is self-contained for *Python* but not for *native* code. Four copied dynamic libraries carry absolute references back into the `/tmp` bootstrap, and 1,037 absolute symlinks under `lib/pkgconfig` and `lib/terminfo` point there too. With the bootstrap moved aside, `import readline` fails hard while `runtime-status` reports every check green and PDF parsing still succeeds — a silent partial breakage of exactly the kind the sandbox fix eliminated by adding build-time import assertions. The host never got the symmetric check.

---

## Evidence collected

| Check | Result |
| --- | --- |
| `node scripts/supply-chain-check.mjs` | `pass`, exit 0 |
| `node scripts/secret-scan.mjs` | `pass`, 274 tracked files, exit 0 |
| `node scripts/dependency-audit.mjs` | `pass` — plugin 0 critical / 0 high; web 0 critical / 12 reviewed high |
| `node scripts/check-repository.mjs` | Repository contract passed (274 files) |
| `node --test scripts/tests/supply-chain.test.mjs` | 18/18 |
| `node --test scripts/tests/check-repository.test.mjs` | 74/74 |
| `node --test scripts/tests/pdf-ingestion-security.test.mjs` | 12/12 |
| `node --test .../parse-pdf-compat.test.mjs` | **5/5 executed, 6 registered** — see R3-M2 |
| `node scripts/runtime-policy.mjs status` | `nonconformant` on `node`/`npm` only; `python`, `managedRuntimeContained`, `marker` all true |
| `runtimeStatus` wall time | 226 ms; `sha256Directory(lib/python3.11)` 64–224 ms — no performance concern |

---

## Blocking

### R3-B1 — The runtime is not usable without the bootstrap: native libraries and 1,037 symlinks still resolve through `/tmp`, and every status check stays green (HIGH)

Review focus item 6 asks the reviewer to verify the runtime "remains usable after the bootstrap installation disappears". It does not. Moving the bootstrap aside and importing the extension-backed standard library:

```
$ mv /tmp/codex-paper-python-3.11.15 /tmp/codex-paper-python-3.11.15.hidden
$ <runtime>/bin/python -c "import ssl, readline, sqlite3, lzma, bz2, ctypes, fitz"
ImportError: dlopen(<runtime>/lib/python3.11/lib-dynload/readline.cpython-311-darwin.so, 0x0002):
  Library not loaded: /tmp/codex-paper-python-3.11.15/lib/libtinfow.6.dylib
  Referenced from: <runtime>/lib/libncursesw.6.dylib
```

Two distinct mechanisms, both verified:

**1. Absolute install names in copied native libraries.** `libtinfow.6.dylib` *was* copied into the tree, but the copy of `libncursesw.6.dylib` still names the bootstrap path in its Mach-O load commands, and copying a file cannot rewrite them:

```
$ otool -L <runtime>/lib/libncursesw.6.dylib
	@rpath/libncursesw.6.dylib
	/tmp/codex-paper-python-3.11.15/lib/libtinfow.6.dylib (reexport)
```

Four copied dylibs reference the bootstrap absolutely: `libncurses.6.dylib`, `libncurses.dylib`, `libncursesw.6.dylib`, `libncursesw.dylib`.

**2. `cpSync`'s `dereference` does not apply to nested entries.** `copySelfContainedRuntime` passes `{ recursive: true, dereference: true }`, but the published tree contains **1,037 symlinks**, every one of them absolute into the bootstrap:

```
$ find <runtime> -type l | wc -l
    1037
$ find <runtime> -type l -lname '/*' | wc -l
    1037
<runtime>/lib/pkgconfig/python3.pc     -> /private/tmp/codex-paper-python-3.11.15/lib/pkgconfig/python-3.11.pc
<runtime>/lib/terminfo/39/955-w        -> /private/tmp/codex-paper-python-3.11.15/share/terminfo/74/tvi955-w
```

All 1,037 are under `lib/pkgconfig` and `lib/terminfo`. `terminfo` is on the ncurses search path, so this is a live read path, not inert metadata.

**Why nothing detects it.** `pythonFacts` imports only `json, os, platform, sys, sysconfig` plus `fitz`, so the containment probe never touches an ncurses-backed module. With the bootstrap gone, `checks.python`, `checks.managedRuntimeContained`, and `checks.marker` all still pass, and a PDF parse still succeeds — PyMuPDF does not import `readline`. `sha256Directory` *would* catch mechanism 2, because it throws on any symlink, but it is applied only to `lib/python3.11`, which is the one subtree that happens to be symlink-free. Confirmed: `sha256Directory(<runtime>)` fails with `managed runtime contains an unsupported filesystem entry` after 59 ms.

**Impact.** Availability: any bootstrap removal (reboot clearing `/tmp`, tool-cache eviction, `brew upgrade`) leaves a runtime that reports conformant while part of its standard library is broken, and the breakage surfaces only when generated code happens to import the affected module. Integrity: `/tmp` is world-writable with the sticky bit, so if that directory is removed and recreated by another local user, they control `libtinfow.6.dylib` — a native library loaded into the parser process along any path that pulls in ncursesw. This is the narrowed remnant of R2-B1, not a new problem.

The underlying assumption — that the bootstrap's native libraries are relocatable — is never verified. Whether it holds depends on how the bootstrap was built; here it was built in `/tmp`, so its libraries carry absolute names.

**Fix, in priority order:**
1. **Mirror the sandbox check on the host.** The Dockerfile already runs `python3 -I -B -c 'import bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib'` at build time, and that is exactly why B2 is trustworthy. Add the identical assertion to `setupRuntime`'s post-install verification and to `runtimeStatus.checks`. It fails today, so it would have blocked this publication. The asymmetry between container and host is the actual bug.
2. **Reject residual bootstrap references at publication.** Run `sha256Directory` over the whole published tree in `publishPreparedRuntime`'s `verify` — it already throws on symlinks, so it closes mechanism 2 and simultaneously extends integrity coverage to `bin/`, `lib/*.dylib`, and `pyvenv.cfg` (see R3-L1). For mechanism 1, add a scan for absolute references into the bootstrap prefix (`otool -L` on macOS, `readelf -d` on Linux), or simply run check 1 in CI with the bootstrap renamed aside.
3. **Copy less.** `lib/pkgconfig`, `lib/terminfo`, `lib/cmake`, `lib/*.a`, and the Tk assets are not needed by a headless PDF parser; restricting the copy to `lib/python3.11` plus `lib/lib*.{so,dylib}*` removes all 1,037 symlinks, cuts the tree from 240 MB, and shrinks the trusted surface (see R3-L2).
4. If full native self-containment is not achievable for arbitrary bootstraps, say so: require a verified-relocatable bootstrap, or drop the "remains usable after the bootstrap disappears" claim and document that the bootstrap must persist. Either is defensible; the current state claims the stronger property without checking it.

---

## Medium

### R3-M1 — Containment is enforced only by `runtime-status`, never at the point of use, and `pyvenv.cfg` is covered by no hash

`pyvenv.cfg` lives at the runtime root, while `managedStdlibSha256` covers `lib/python3.11` and `managedExecutableSha256` covers `bin/python`. It is the one file that determines where the standard library comes from, and it is hashed by nothing. Verified by editing one line under backup:

```
# home = <runtime>/bin  ->  home = /tmp/outoftree3/bin
$ <runtime>/bin/python -c "import os,sys;print(sys.base_prefix);print(os.__file__)"
/tmp/outoftree3
/tmp/outoftree3/lib/python3.11/os.py

$ runtimeStatus() -> nonconformant  {"managedRuntimeContained": false, "marker": true}

$ node .../parse-pdf.js probe.pdf
{ "title": "Probe Paper …", "abstract": "A probe fixture." …   # parsed successfully, no warning
```

`managedRuntimeContained` correctly goes false — the new check works. But `marker` stays true, and `resolveParserPython` checks only path equality, ordinary-file, and a version probe, none of which is affected by substituting the standard library. So every subsequent parse silently uses the out-of-tree stdlib, and `ensure_pymupdf` (versions only) also passes.

This is a same-UID scenario against a `0700` tree, which the project has reasonably de-scoped as not a separate boundary. The finding is that the *newly claimed* invariant is verified in one command nobody runs on the parse path, and the fix is a few lines either way:

- Add `pyvenv.cfg` to the marker hash set, so `marker` also fails; and/or
- extend the probe `resolveParserPython` already spawns — it costs nothing to append `import sys, sysconfig; assert sys.base_prefix == <root>; assert sysconfig.get_path('stdlib').startswith(<root>)` to the existing one-shot script. That makes the parser enforce containment itself, memoized exactly as today.

### R3-M2 — One of six parser-compatibility tests silently does not execute, and the totals look clean

`parse-pdf-compat.test.mjs` registers six top-level tests. A full-file run executes five:

```
$ node --test --test-reporter=spec .../parse-pdf-compat.test.mjs
✔ metadata title split across layout blocks does not contaminate authors
✔ pdf-parse fallback preserves the bounded public contract
✔ moving both parser override and claimed canonical anchor cannot execute an out-of-tree interpreter
✔ parsePdf public JSON matches parsePdfDetailed.publicData and omits internal fields
✔ parse-pdf CLI continues to print only the public parser object
ℹ tests 5   pass 5   fail 0   skipped 0   todo 0
```

Missing: **`metadata title split across five front-matter blocks does not contaminate authors`** — the regression test for the round-1 L8 front-matter window. Nothing signals the loss: `skipped 0`, `todo 0`, `fail 0`.

Established by experiment:

- It passes when targeted: `--test-name-pattern="five front-matter"` → 1/1 pass.
- It passes when the file is truncated to just the two title tests → 2/2.
- Renaming it so the two title tests share no prefix does not help — still 5.
- Moving it to the end of the file makes it run and drops the *first* title test instead — still 5 of 6.
- Inserting a trivial synchronous canary test in that region drops the canary too — 7 registered, 5 executed.
- `--test-concurrency=1` changes nothing.
- Across the study suite this file is the only one affected: every other file's registered count matches its executed count, so the reported `86/86` should be 87.

So the drop is positional and content-independent, not a name collision. The mechanism (a `node:test` interaction specific to this file) is not root-caused here; the reviewable defect is that a regression test is silently absent and the totals conceal it. The repo already applies a "no skip mode: zero or partial execution is a failure" rule to benchmarks — the unit suites need the same treatment:

1. Assert expected per-suite test counts in `cmd_test`, so a silent drop fails the gate.
2. Split `parse-pdf-compat.test.mjs`; it currently mixes async PDF parsing, a test that mutates `process.env.CODEX_PAPER_PARSER_WORKER`, and a test that spawns the CLI. Re-verify counts after splitting.
3. Correct the summary's "Parser compatibility tests passed 6/6" — five ran.
4. Re-check on the pinned Node 22.23.1 before concluding anything about the runner.

### R3-M3 — `CODEX_PAPER_PARSER_WORKER=1` re-opens the caller-moved anchor

R2-B2 is fixed for the ordinary case — verified, and now covered by a test:

```
$ CODEX_PAPER_PYTHON_BIN=/tmp/outoftree3/bin/python \
  CODEX_PAPER_MANAGED_PYTHON_BIN=/tmp/outoftree3/bin/python node .../parse-pdf.js probe.pdf
Error parsing PDF: Noncanonical parser runtime overrides are disabled.
```

But the gate is `process.env.CODEX_PAPER_PARSER_WORKER === '1'`, which is itself an inheritable environment variable. Adding it restores the round-2 behaviour:

```
$ CODEX_PAPER_PARSER_WORKER=1 \
  CODEX_PAPER_PYTHON_BIN=/tmp/outoftree3/bin/python \
  CODEX_PAPER_MANAGED_PYTHON_BIN=/tmp/outoftree3/bin/python node .../parse-pdf.js probe.pdf
Error parsing PDF: PDF parser worker failed: parser_runtime_nonconformant: …
```

The parse aborts only because `runBoundedParser` hardcodes the true `MANAGED_PYTHON_PATH` for the child — but the parent already **executed** `/tmp/outoftree3/bin/python` as the supervisor to produce that message. The precondition rose from two caller-set variables to three, and `CODEX_PAPER_PARSER_WORKER` is a pre-existing internal flag that also bypasses the bounded-supervisor requirement, so this is not a new weakness so much as P1-3a taking on a new dependency on it.

**Fix:** stop trusting the string. Regardless of the worker flag, require the resolved interpreter to be contained in `MANAGED_RUNTIME_ROOT`:

```js
const relative = path.relative(MANAGED_RUNTIME_ROOT, path.resolve(requested));
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new PdfSecurityError(…);
```

The worker's canonical path is inside the root by construction, so the handoff keeps working. Extend the existing anchor test with the three-variable variant, asserting the fake interpreter is never executed.

---

## Low

### R3-L1 — The marker covers `lib/python3.11` but not the native libraries the interpreter actually loads

`managedStdlibSha256` covers 96 MB of `lib/python3.11`; the sibling `lib/` tree is 223 MB and unhashed, including `libcrypto.3.dylib`, `libssl.3.dylib`, `libbz2.dylib`, and `libncursesw.6.dylib`. Those are genuinely on the load path — `_ssl.cpython-311-darwin.so` resolves `@rpath/libssl.3.dylib`, and `@rpath` lands in `<runtime>/lib`. `bin/` and `pyvenv.cfg` are likewise uncovered. Fixing R3-B1 step 2 (hash the whole published tree) closes this in the same change; it currently throws only because of the symlinks R3-B1 describes.

### R3-L2 — `copySelfContainedRuntime` copies the bootstrap's entire `lib/`, producing a 240 MB tree

The copy excludes only the version directory, so the published runtime gains `cmake/`, `pkgconfig/`, `terminfo/`, `itcl4.3.0/`, `Tk.icns`, `Tk.tiff`, `libbz2.a`, `libtinfow.a`, `libc++.dylib`, and similar — none of which a headless PDF parser needs. Restricting the copy to `lib/python3.11` plus `lib/lib*.{so,dylib}*` shrinks the tree, removes every symlink, and reduces both the trusted surface and the hash cost.

### R3-L3 — The two package-manager cleanups disagree about `pkg_resources`

`removeInstallerArtifacts` strips `pip|setuptools|wheel|pkg_resources` from the venv, but the Dockerfile's `rm -rf` list omits `pkg_resources`, and neither the build-time nor the conformance `find_spec` assertion covers it (`("pip", "setuptools", "wheel")`). Add it to both so the two paths make the same guarantee.

### R3-L4 — One unsafe bootstrap candidate blocks discovery of a later safe one

`findBootstrapPython` calls `assertBootstrapSource`, which **throws**, inside the candidate loop. A `python3.11` on `PATH` whose prefix is group-writable therefore aborts discovery before `python3` is tried. Throwing is right for the explicitly requested interpreter; for implicit candidates, `continue` and report only if none qualifies.

### R3-L5 — `writeRelocatedVenvConfig` fabricates a provenance line

The rewritten `pyvenv.cfg` records `command = <target>/bin/python -m venv --copies <target>`, a command that was never run — the venv was created by the bootstrap in a temporary directory and then relocated. `home`, `version`, and `executable` must be rewritten for correctness, but `command` is provenance, and P1-4 is scheduled to consume runtime provenance. Either omit the line or record what actually happened.

### R3-L6 — Two engines still lack the entrypoint guard added to `runtime-policy.mjs`

`runtime-policy.mjs` now guards its `main()` detection with `existsSync(process.argv[1])` before `realpathSync`. `secret-scan.mjs` and `supply-chain-check.mjs` still call `realpathSync(process.argv[1])` unguarded, so an unusual invocation throws at import time. `dependency-audit.mjs` now imports `supply-chain-check.mjs` for `validateDependencyPolicy`, which widens the blast radius of that import-time throw. Apply the same guard to all four.

---

## Round-2 findings verified closed

| Item | Status |
| --- | --- |
| **R2-B1** stdlib in `/tmp` | **Fixed for Python.** Verified live: `sys.base_prefix`, `sysconfig.get_path('stdlib')`, `os.__file__`, and `fitz.__file__` all resolve inside `<runtime>`; `lib/python3.11` holds the real 207-entry standard library; `pyvenv.cfg home` points at the runtime's own `bin`. `managedRuntimeContained` and `managedStdlibSha256` are real checks that probe the interpreter rather than trusting a path, `__pycache__`/`.pyc` are excluded so normal use cannot invalidate the marker, and `ephemeralRoots()` now covers `/tmp`, `/var/tmp`, both `/private` aliases, and `os.tmpdir()`. `assertBootstrapSource` additionally rejects a stdlib outside its prefix and group/world-writable or foreign-owned bootstrap sources. Residual is native-only: R3-B1. |
| **R2-B2** caller-moved anchor | Fixed for the ordinary case and covered by a new test that asserts the fake interpreter is never executed. Residual: R3-M3. |
| **R2-M1** `/tmp` leak in diagnostics | Fixed: `sanitizeDiagnostic` now maps every ephemeral root plus the runtime root, home, and URL userinfo. |
| **R2-M2** finding precedence | Fixed: `findings.length ? 'fail' : configurationErrors.length ? 'configuration_error' : …`, so a real leak outranks a simultaneous configuration error and exits 1. |
| **R2-M3** stale lock | Fixed: `acquiredAtMs` plus a 30-minute TTL reclaims regardless of hostname, all three lock errors carry `exitCode = EXIT.UNAVAILABLE`, the lock is acquired inside the `try` so `finally` always releases, and the messages name the manual recovery path. |
| **R2-M4** Node pins uncross-checked | Fixed: `runtimeSites` now checks `NODE_REQUIRED="…"` in both `scripts/common.sh` and `start-webui.sh` against the baseline, with a per-site boundary label in the error. |
| **R2-M5** engines trusting own policy | Fixed: `dependency-audit` imports `validateDependencyPolicy` and returns `configuration_error` before auditing; `secret-scan` gained `validateSecretPolicy` plus a `policyLoadError` path, both surfacing as exit 2. |
| **R2-L1** hashing over-claimed | Fixed both ways: `scripts/common.sh`, `scripts/check-repository.mjs`, `scripts/tests/supply-chain.test.mjs`, and `start-webui.sh` were added to the reviewed artifacts, and the summary now states plainly that these hashes provide "review visibility, not independent tamper resistance". |
| **R2-L2** npm absence unasserted | Fixed: `shutil.which("npm") is None` in the Dockerfile build and in conformance, with both forms required by the Repository Guard. |
| **R2-L3** probe cost and conflated errors | Fixed: memoized on `path:dev:ino:size:mtimeMs`, `maxBuffer` raised to 64 KiB, and a distinct `parser_runtime_unavailable` code separates "probe could not run" from a version mismatch. |
| **R2-L4** ambient kill switches | Fixed better than proposed: both environment variables are gone. Failure injection is now an internal function parameter (`forcePyMuPdfFailureForTest`), and the Repository Guard rejects either variable name reappearing in `parse-pdf.js`. |
| **R2-L5** `cmd_test` needs Python | Fixed: `repo-test` added for Python-free static guard testing. |
| **R2-L6** `common.sh` roughness | Fixed: the containment check is a plain string comparison with no `cd` subshell, and `ensure_pymupdf` now asserts `python_implementation()`. |
| **R2-L7** destructive-rebuild canary | Improved: the regex is now scoped to the `setupRuntime` body up to the `publishPreparedRuntime` call, so it cannot be satisfied vacuously. Still a text canary, which is the right characterisation. |
| **R2-L8** summary defects | Fixed: orphaned bullets reattached, the sandbox composition description corrected to "final stage is the digest-pinned CPython image; it receives only the Node 20.20.2 binary", and the review-focus list rewritten around the new invariants. |

Also new and good, beyond what round 2 asked for:

- `publishPreparedRuntime` now takes a `verify` callback and rolls the previous runtime back if post-publication verification fails, so a tree that publishes but does not verify cannot persist.
- `setupRuntime` returns the verified `publishedStatus` instead of re-deriving it, avoiding a second full-tree hash.
- `sha256Directory` is a stable, ordered, type-tagged tree hash that refuses symlinks — a sound primitive, currently just aimed at too small a subtree (R3-L1).

---

## Recommended order of work

1. **R3-B1 step 1** — add the host-side extension-module import assertion to post-install verification and `runtimeStatus`. One line, fails today, and would have blocked this publication. Do this before anything else, since it converts the remaining problem from silent to loud.
2. **R3-B1 steps 2–3** — whole-tree hashing (which also closes R3-L1) and a narrowed copy (R3-L2). Then decide explicitly whether to claim native self-containment or to document the bootstrap as a persistent prerequisite.
3. **R3-M3** — containment check in `resolveParserPython`, plus the three-variable test.
4. **R3-M1** — append the two containment asserts to the probe the parser already runs, and add `pyvenv.cfg` to the marker.
5. **R3-M2** — assert per-suite test counts in `cmd_test`, split the compat file, correct the summary's 6/6, and re-verify on Node 22.23.1.
6. **R3-L3 – R3-L6** — cleanup.

**Still unverified anywhere:** the sandbox image. Docker remains unavailable locally. The image contract is now covered by static and mutation checks plus build-time assertions, so a green remote run would be meaningful — and R3-B1 is a direct argument for that gate's value, since the host-side equivalent of those same assertions is exactly what is missing.
