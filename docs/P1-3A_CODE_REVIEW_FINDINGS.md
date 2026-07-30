# P1-3a Code Review — Findings

**Scope:** the uncommitted P1-3a runtime / dependency / supply-chain baseline, as described in `docs/P1-3A_CODE_REVIEW_SUMMARY.md`.
**Reviewed at:** 2026-07-28, branch `codex/audit-optimizations-2026-07-10`.
**Primary files:**

- `scripts/runtime-policy.mjs`, `scripts/dependency-audit.mjs`, `scripts/secret-scan.mjs`, `scripts/supply-chain-check.mjs` (new)
- `security/{runtime-baseline,dependency-policy,secret-scan-policy,supply-chain-review}.json` (new)
- `plugins/codex-paper/runtime/python/requirements.lock`, `plugins/codex-paper/scripts/runtime-python.sh` (new)
- `plugins/codex-paper/sandbox/Dockerfile`, `sandbox/policy.json`, `skills/study/scripts/sandbox-code.js` (changed)
- `scripts/common.sh`, `scripts/codex-paper.sh`, `scripts/check-repository.mjs`, `.github/workflows/ci.yml` (changed)
- `plugins/codex-paper/skills/study/scripts/parse-pdf.js`, `skills/study/SKILL.md` (changed)
- `plugins/codex-paper/src/web/{nuxt.config.ts,package.json}` (changed)

**Verdict:** the policy engines are well-shaped and genuinely fail-closed, and the four review-focus claims about redaction, non-retroactivity, exception exactness, and P0-A1/A2 boundaries hold. But three defects should be fixed before merge — a study-skill command that can never run, a sandbox image that silently loses parts of the Python standard library while conformance reports green, and a runtime rebuild that destroys a working interpreter on any transient failure. The sandbox image change is also the one item in this set that has never been executed anywhere: Docker was unavailable locally and no CI run for this branch is recorded.

---

## Blocking

### B1 — `SKILL.md` Step 9 image extraction command cannot resolve either of its paths (HIGH)

`plugins/codex-paper/skills/study/SKILL.md:437`:

```bash
bash ./scripts/runtime-python.sh ./skills/study/scripts/extract-images.py
```

The skill's working directory is `plugins/codex-paper/skills/study/` — every other command in the file uses `./scripts/<file>` for `prepare-paper.js`, `workspace-cli.js`, `validate-reasoning.js`, and those files live in `skills/study/scripts/`. The new Step 1 preflight at `:86` agrees, correctly reaching the launcher as `../../scripts/runtime-python.sh`.

So at `:437` both operands are wrong:

- `./scripts/runtime-python.sh` → `skills/study/scripts/runtime-python.sh`, which does not exist (the launcher is at `plugins/codex-paper/scripts/runtime-python.sh`).
- `./skills/study/scripts/extract-images.py` → `skills/study/skills/study/scripts/extract-images.py`, which does not exist. The pre-change line was `python3 ./scripts/extract-images.py`, i.e. correct.

**Failure:** every Step 9 run fails with `bash: ./scripts/runtime-python.sh: No such file or directory`. Figure extraction is dead for all papers. Nothing in `check-repository.mjs` greps SKILL.md command paths (verified: no `extract-images` or `runtime-python` reference in the guard), so no gate catches it.

**Fix:** `bash ../../scripts/runtime-python.sh ./scripts/extract-images.py`. Consider adding a Repository Guard check that every `bash|node ./scripts/…`/`../../scripts/…` path quoted in SKILL.md resolves relative to the skill directory — this class of drift has now appeared twice.

### B2 — Sandbox loses shared-library-backed stdlib modules, and conformance cannot see it (HIGH)

`plugins/codex-paper/sandbox/Dockerfile` replaces `apt-get install --yes --no-install-recommends python3` with:

```dockerfile
FROM ${PYTHON_BASE_IMAGE} AS python-runtime
FROM ${BASE_IMAGE}
COPY --from=python-runtime /usr/local /usr/local
```

Only `/usr/local` is copied. The official `python:3.11.15-slim-bookworm` image keeps its extension modules under `/usr/local/lib/python3.11/lib-dynload/`, but the Debian shared libraries those modules link against are installed by apt into `/usr/lib/<triplet>/` — `libffi8` (`ctypes`), `libsqlite3-0` (`sqlite3`), `liblzma5` (`lzma`), `libbz2-1.0` (`bz2`), `libreadline8`/`libncursesw6` (`readline`), `libuuid1` (`_uuid`). `node:20.20.2-bookworm-slim` does not ship that set. The previous `apt-get install python3` obtained them through Debian dependency resolution; the copy does not.

The new conformance assertion is `assert sys.version.split()[0] == "3.11.15"` (`sandbox-code.js:822`) plus the pre-existing env/path/socket checks. It imports only `os, pathlib, socket, sys`. A container where `import sqlite3` raises `ImportError: libsqlite3.so.0: cannot open shared object file` therefore passes conformance.

**Failure:** `sandbox-setup`/`sandbox-test`/`sandbox-status` report conformant while any generated demo doing `import sqlite3`, `import lzma`, `import ctypes`, or `import bz2` fails at execution time. `SKILL.md:392` explicitly instructs generated code to "use only Python/Node standard-library capabilities", so this is precisely the code path at risk. The trusted `entrypoint.py` itself is safe — it imports only `json, os, resource, subprocess, sys, time, pathlib`, all builtin — which is why nothing else surfaces the problem.

Compounding this, `check-repository.mjs:747` now rejects the Dockerfile if it contains `apt-get|apk add|yum install` at all, so the direct fix is blocked by the new contract.

**Fix:** (a) extend the conformance script to assert importability of the shared-library-backed stdlib modules demos may reasonably use; (b) either `COPY --from=python-runtime` the required `/usr/lib/<triplet>/lib{ffi,sqlite3,lzma,bz2,readline,ncursesw,uuid}*` alongside `/usr/local`, or narrow the Repository Guard rule to forbid *unpinned/mutable* package installs rather than all apt usage; (c) add `RUN python3 -c 'import ctypes, sqlite3, lzma, bz2, hashlib, ssl, zlib'` to the Dockerfile so a broken composition fails at build time instead of at a user's first demo run.

Concrete verification once Docker is available:

```bash
docker run --rm codex-paper-sandbox:p0-a3-v1 \
  python3 -c 'import ctypes, sqlite3, lzma, bz2, readline, uuid, ssl, zlib, hashlib; print("ok")'
```

### B3 — `setupRuntime` deletes the working interpreter before building its replacement (HIGH)

`scripts/runtime-policy.mjs:172-196`:

```js
if (existsSync(target)) { …safety checks…; rmSync(target, { recursive: true, force: true }) }
const temporary = mkdtempSync(path.join(root, '.python-init-'))
try { …venv…; …pip install…; renameSync(temporary, target) }
catch (error) { rmSync(temporary, …); throw }
```

The existing runtime is removed *before* the venv is created and the hash-locked wheel is fetched. `pip install` is a network operation.

**Failure:** running `runtime-setup` offline, behind a flaky proxy, or against a PyPI outage leaves the machine with **no** managed Python. Because `parse-pdf.js`, `run-mandatory-benchmark.mjs`, `pdf-ingestion-security.test.mjs`, and `parse-pdf-compat.test.mjs` all resolve the same fixed path, PDF parsing, the mandatory benchmark, and two suites break until the network returns — from a command whose only observable trigger was a policy version bump.

**Fix:** build and install into the temp directory first; only then `rmSync(target)` immediately before `renameSync`. Better: rename the old target aside (`target + '.old'`), rename the new one in, and delete the old one after success, so a failed rename is recoverable. Note the concurrency edge too: two simultaneous `runtime-setup` calls can `rmSync` a directory the other is about to rename onto.

---

## Medium

### M1 — Dependency exception schema is unvalidated; a missing `expiresOn` never expires, and `exceptionMaximumDays` is dead

`supply-chain-check.mjs:68-79` validates every secret-scan allowlist entry for exact file/line/rule, a 64-hex `contentSha256`, an ISO `expiresOn`, and a ≥10-character `reason`. There is no equivalent validation for `security/dependency-policy.json`.

`dependency-audit.mjs:48` is the only consumer of the expiry:

```js
if (exception.expiresOn < utcDay(now)) errors.push(…)
```

If `expiresOn` is absent or misspelled, `undefined < '2026-07-28'` evaluates to `false` (NaN comparison), so the branch never fires and the waiver becomes permanent. Nothing requires `packages[].nodes` to be non-empty, or `reachability`/`mitigations`/`decision` to be present, even though the review focus states exceptions must be "justified". `exceptionMaximumDays: 45` is declared in the policy and read by no code — the current entry happens to be 35 days from `reviewedAt: 2026-07-27`, but nothing enforces that.

**Fix:** validate exception entries in `checkSupplyChain` with the same rigour as the secret allowlist — ISO `expiresOn` within `exceptionMaximumDays` of `supply-chain-review.json`'s `reviewedAt`, non-empty `packages`/`nodes`, `reachability` and `decision` present — and in `evaluateAudit` treat a non-ISO `expiresOn` as expired rather than as absent.

### M2 — Exception drift is symmetric: the audit turns red when a vulnerability is *fixed*

`dependency-audit.mjs:57` requires the observed high set to equal the reviewed set exactly:

```js
if (JSON.stringify(high) !== JSON.stringify(expected)) errors.push('high vulnerability set drifted from the reviewed exception')
```

When upstream ships a Nitro or archiver fix and `npm audit` drops an entry, CI fails with the same message as a genuinely new vulnerability. Fail-closed is right, but the direction is indistinguishable, so the person reading a red build cannot tell "new exposure, investigate now" from "good news, prune the waiver".

**Fix:** diff the sets and report the two directions separately — unreviewed additions as a policy failure, disappearances as "exception is now over-broad; remove these entries".

### M3 — Runtime version literals are duplicated across ten files with only two of them cross-checked

`3.11.15` occurs 33 times in 10 non-doc files: `security/runtime-baseline.json`, `sandbox/policy.json`, `scripts/runtime-python.sh`, `parse-pdf.js`, `parse-pdf-compat.test.mjs`, `benchmarks/run-mandatory-benchmark.mjs`, `scripts/common.sh`, `scripts/codex-paper.sh`, `scripts/check-repository.mjs`, `scripts/tests/pdf-ingestion-security.test.mjs`. `22.23.1` occurs in 6 files including `common.sh:20`, `start-webui.sh:26`, and `ci.yml`.

Only `check-repository.mjs:761` cross-validates its literals against `security/runtime-baseline.json`. The interpreter *path* constructions do not participate: `parse-pdf.js:18-25`, `common.sh:21`, `runtime-python.sh:5`, `run-mandatory-benchmark.mjs:55` each independently hardcode the `python-3.11.15` directory segment.

**Failure:** bumping `host.python` in the baseline updates the Repository Guard and `runtime-setup`, which will then create `python-3.11.16/`, while the parser keeps spawning `…/python-3.11.15/bin/python` → `ENOENT` on every PDF. The failure surfaces at parse time, not at `runtime-status`, which would report conformant.

**Fix:** resolve the managed interpreter from `security/runtime-baseline.json` in one place — `parse-pdf.js` already reads `plugin.json` at startup, so reading one more small JSON is consistent — or add a Repository Guard check that every hardcoded site matches the baseline.

### M4 — `cmd_install` uses `npm install`, which mutates the lockfiles the supply-chain gate hash-pins

`codex-paper.sh:14-19` runs `npm install --ignore-scripts --legacy-peer-deps`, while `supply-chain-review.json` pins the sha256 of both `package-lock.json` files. These two are in direct tension, and the drift is already present in the working tree: `plugins/codex-paper/package-lock.json` shows `fast-uri` moving 3.1.2 → 3.1.4 with no manifest change, i.e. an install rewrote it.

CI is safe only by ordering — `supply-chain-test` is step 3 and `install` is step 6 — so the hashes are checked against the pre-install tree. A developer running `install` then `supply-chain-test` locally, in that order, gets `supply-chain artifact changed without review` for a change they did not author.

**Fix:** `npm ci` is deferred to P1-3b per the summary; until then document the ordering constraint in `docs/dependency-runtime-supply-chain-policy.md`, and add a CI step that re-runs `supply-chain-test` *after* `install` to prove the install is lockfile-neutral. That also converts the current accidental pass into a real invariant.

### M5 — `--legacy-peer-deps` is an undocumented relaxation of the same policy this phase tightens

`--ignore-scripts` is a real supply-chain win and deserves to be stated. `--legacy-peer-deps`, added in the same line, suppresses peer-dependency conflict resolution — it means the Nuxt 4.5.1 tree contains peer conflicts npm would otherwise reject, and it makes the installed tree differ from what a strict resolver produces. It appears in neither `docs/P1-3A_CODE_REVIEW_SUMMARY.md`, nor `CHANGELOG.md`, nor `docs/dependency-runtime-supply-chain-policy.md`, while the *audit* exceptions it sits next to are documented down to node paths and expiry dates.

**Fix:** record the specific peer conflict that requires the flag, with a reachability statement and an expiry, in `security/dependency-policy.json` alongside the audit exceptions — same standard, same review surface.

### M6 — The test suite and the fixture provenance strings still name global `python3`

`scripts/tests/mandatory-benchmark.test.mjs:105` spawns bare `python3`, and it runs inside `cmd_test` (`codex-paper.sh:160` globs `scripts/tests/*.test.mjs`). On this machine that resolves to CPython 3.13.5 with PyMuPDF 1.27.2.2 — both outside policy. It happens to work because `generate-pdf-fixtures.py` imports only `argparse, hashlib, tempfile, pathlib` and writes raw PDF bytes, so byte-for-byte reproduction is unaffected; but the review-focus claim that no path accepts global Python is not true of the suite, and the test fails outright on a host without `python3`.

Relatedly, `benchmarks/mandatory/contract.mjs:117` and `check-repository.mjs:435` still *require* each fixture manifest's `generator` field to read `python3 benchmarks/fixtures/generate-pdf-fixtures.py --fixture <id>`. The recorded provenance command therefore names an interpreter the policy now forbids, which matters because P1-4 will consume these records.

**Fix:** route the generator through the managed interpreter in the test and update the manifest `generator` strings plus both guards. The fixtures themselves need no regeneration.

---

## Low

### L1 — Sandbox conformance's Node failure message bakes in the *host* version

`sandbox-code.js:838`:

```js
`if (process.versions.node !== ${JSON.stringify(POLICY.runtime.node)}) failures.push(\`unexpected Node=${process.versions.node}\`)`
```

The inner backticks are escaped but `${process.versions.node}` is not, so the host interpolates it while generating the file. The emitted container script reads `failures.push(\`unexpected Node=22.16.0\`)` — whatever Node ran `sandbox-setup`. The `!==` comparison is correct; only the diagnostic is wrong, and it will actively mislead whoever debugs a real mismatch. The adjacent `HOME` line avoids this by being a plain single-quoted string.

**Fix:** escape as `\${process.versions.node}`, or concatenate instead of interpolating.

### L2 — `runtime-setup` failures leak absolute home paths, unlike `runtime-status`

The redaction claim holds for `status`: `runtimeStatus` returns only versions, checks, and the policy object, and `printStatus` prints no paths — the supply-chain test's assertion is genuine. But `runtime-policy.mjs:194` embeds raw `result.stderr` from pip into the thrown message, and `main`'s catch prints it (and emits it under `--json`). pip's output contains the temp venv path, so a failed `runtime-setup` writes `/Users/<name>/.cache/codex-paper/runtime-v1/.python-init-XXXX/…` into terminal and CI logs.

**Fix:** replace the user's home prefix with `~` in the message, or keep raw pip output behind an explicit `--verbose`.

### L3 — The sandbox image now ships pip, setuptools, wheel, and ensurepip

The `/usr/local` copy brings `/usr/local/bin/pip3`, `site-packages/{pip,setuptools,wheel,pkg_resources}`, and `lib/python3.11/ensurepip` into the sandbox; the cleanup `RUN` removes only npm. The container has no network so nothing can be fetched, but the previous image had no Python package manager at all, and npm is removed precisely on this reasoning.

**Fix:** delete them in the same `RUN` and assert their absence in the conformance script, mirroring the npm treatment.

### L4 — `secret-scan.mjs` crashes on tracked-but-missing files, and treats oversize files as failures

`secret-scan.mjs:55` calls `statSync` without a guard. `git ls-files` lists files that may be absent from the working tree (deleted-but-unstaged, sparse checkout), so the scan dies with an unhandled `ENOENT` instead of reporting a result. Separately, `:57` records a file over `maxFileBytes` (8 MiB) as an *error* that fails the gate — committing one large binary fixture turns the secret scan red with no secret involved. That may be the intended fail-closed stance, but it is not stated anywhere.

**Fix:** try/catch around `statSync` and skip missing files; document (or allowlist) the oversize policy explicitly.

### L5 — Windows is half-supported: a code path exists that the wheel set cannot satisfy

`runtime-policy.mjs:48` branches on `win32` for `Scripts/python.exe`, but `requirements.lock` pins exactly four wheel hashes under `--only-binary=:all: --require-hashes`, so a Windows install can never resolve. Meanwhile `parse-pdf.js`, `common.sh`, `runtime-python.sh`, and the benchmark all hardcode `bin/python` with no win32 branch at all.

**Fix:** drop the win32 branch or add the `win_amd64` wheel hash, and state the supported platform set in `docs/dependency-runtime-supply-chain-policy.md`.

### L6 — The supply-chain review pins the artifacts but not the engines that check them

`security/supply-chain-review.json` hash-pins 11 artifacts and does not include `scripts/{supply-chain-check,dependency-audit,secret-scan,runtime-policy}.mjs`. Weakening `evaluateAudit` — say, dropping the critical check — is invisible to every automated gate. The review file also cannot attest to itself; only `artifacts.length === 0` is rejected. `check-repository.mjs` does keep all four scripts as existence sentinels, so deletion is caught, but not modification.

**Fix:** add the four engines to the pinned set. That makes editing them require a deliberate review bump — the same trade-off already accepted for `ci.yml`.

### L7 — Pinning npm to exactly `10.9.8` couples the build to something nothing installs

`ensure_npm` (`common.sh:98-108`) and `runtimeStatus` both require exactly `10.9.8`, but no step installs npm: CI relies on whatever npm `actions/setup-node@…` bundles with Node 22.23.1, and setup-node does not pin npm independently. If the bundled npm is not exactly 10.9.8, `dependency-audit` fails on a fresh runner for a reason unrelated to any change. `security/runtime-baseline.json` already classifies `host.npm` under `toolingOnly`, which argues against treating it as a hard gate.

Note this makes the toolchain unusable on any non-conforming host: this machine has Node 22.16.0 / npm 11.5.2, so every `codex-paper.sh` subcommand exits 3.

**Fix:** either add an explicit `npm i -g npm@10.9.8` step so the pin is self-fulfilling, or warn rather than fail for tooling-only components.

### L8 — Title-block matching window is a bare `4` with no constant or stated bound

`parse-pdf.js:189`: `for (let end = start; end < Math.min(blocks.length, start + 4); …)`. A metadata title split across five or more layout blocks falls back to `titleBlockEnd: -1`, re-opening the author-contamination bug the new compat test covers. The prefix pruning itself is sound — `normalizeForMatch` collapses non-alphanumerics to single spaces, so `normalize(a + ' ' + b)` always extends `normalize(a)`. But the search still scans every start index, so a metadata title equal to a later body block (a section heading, say) can set `titleBlockEnd` deep into the document; that is pre-existing behaviour, now able to consume up to four blocks instead of one.

**Fix:** name the constant, and restrict the search to the front-matter region rather than the whole block list.

### L9 — `PaperAnalysisHero.vue` is 311 lines of unreferenced, out-of-scope code

The new untracked `plugins/codex-paper/src/web/components/PaperAnalysisHero.vue` has zero references anywhere in the web tree. Nuxt auto-registers components by filename, so it enters the component graph and the build without ever rendering. It is unrelated to P1-3a.

**Fix:** remove it from this change set, or wire it up deliberately in its own change.

---

## Verified as claimed

Checks run directly against the working tree:

- `node scripts/supply-chain-check.mjs` → `Supply-chain review: pass` (exit 0). All 11 pinned artifact hashes match.
- `node scripts/secret-scan.mjs` → `Secret scan: pass; tracked files=274` (exit 0).

Claim-by-claim against the review focus:

- **Secret findings never contain the matched value.** Confirmed: `scanContent` returns only `{rule, file, line, contentSha256}`, and the CLI prints `rule: file:line`. The single allowlist entry is live, not stale — recomputing sha256 of `pdf-ingestion-security.test.mjs:75` yields `7748f1c3cb167c4d7bbfbe36daaa5eb396a94da9281a10cca98864eace8aa4e4`, matching the policy exactly, and the entry is genuinely exercised (removing it would fail the scan).
- **No unpinned `pip install` on any parser path.** Confirmed. `ensure_pymupdf`'s old `pip install pymupdf` is gone, replaced by a fail-closed version assertion; the only remaining `pip install` is `runtime-policy.mjs:186-193` with `--no-deps --only-binary=:all: --require-hashes --requirement <lock>`. Repo-wide grep finds no other install. All three parser spawn sites (`parse-pdf.js:460`, `:740`, plus `CODEX_PAPER_PYTHON_BIN` forwarded to the worker at `:759`) use the managed interpreter. Caveat: M6 above, for the test suite.
- **Runtime status is path-redacted and P1-3a does not rewrite existing generations or manifests.** Confirmed for `status` (see L2 for the `setup` error path). `retroactiveManifestRewrite: false` and `provenanceConsumer: 'P1-4'` are both contract-checked in `check-repository.mjs:766`, and no code in this change set touches generation or manifest content.
- **Exceptions cannot cover critical findings.** Confirmed: `dependency-audit.mjs:43` rejects any critical unconditionally, before the exception lookup, and the test suite covers it. Exactness over package/range/installed-nodes is real and tested (see M1 for the schema gaps around it).
- **Nuxt 4 preserves the P0-A1/A2 boundaries.** Confirmed: `nuxt.config.ts` retains `ssr: false`, the `127.0.0.1` devServer, and the nitro inline externals. The only additions are the legacy-layout `srcDir: '.'` / `serverDir: 'server'` and `devtools: false` / `telemetry: false`. Removing `@nuxt/content` and `@vue/devtools-api` is clean — zero references to `queryContent`, `ContentDoc`, `ContentRenderer`, or `@vue/devtools-api` in the web tree, and no `content/` directory exists.
- **Both sandbox runtimes come from digest-pinned official images.** Confirmed for the pinning mechanics: `ARG` declarations precede `FROM`, `setupSandbox` now passes `--build-arg PYTHON_BASE_IMAGE`, so the digest is actually used rather than silently defaulting, and both digests are cross-checked in `check-repository.mjs` and `policy.json`. **Not confirmed for "conformance checks exact versions"** — see B2: the version assertion is present but the composition it is meant to validate has a hole the assertion cannot see.

Also good:

- Repository Guard mutation coverage was genuinely extended, not just relabelled — new tests for baseline tampering, wheel-hash weakening, and CI gate removal, and the digest test was tightened to strip only `BASE_IMAGE` so it no longer passes vacuously.
- `assertPrivateDirectory` is a real check, not decorative: symlink, ownership, and `0700` are all enforced on the runtime root.

---

## Recommended order of work

1. B1 — one-line path fix; Step 9 is currently dead.
2. B2 — extend conformance, then verify the composed image; this gates whether the Dockerfile change is safe to merge at all.
3. B3 — reorder the rebuild so a network failure is non-destructive.
4. M1, M2 — close the exception-schema gaps while the policy is still fresh.
5. M3, M6 — remove the version-literal and `python3` drift before P1-4 starts consuming this as provenance.
6. M4, M5 — document the `npm install` / `--legacy-peer-deps` posture, or defer explicitly to P1-3b in writing.
7. L1–L9 as cleanup; L9 should simply leave this change set.

**Not yet verified anywhere:** the sandbox image. Docker was unavailable locally, and no CI run is recorded for this branch. The CI job does cover it (`ci.yml:52-56` runs `sandbox-setup`/`sandbox-test`/`sandbox-status` on `ubuntu-latest`), so a green remote run is a hard prerequisite — but per B2 that run would pass today even if the standard library is broken.

---

## Supplemental findings incorporated from v2

The findings above are preserved from v1. The following items add v2 findings that are not already covered, or materially strengthen a v1 finding. Severity is normalized against the P1-3a contract rather than copied mechanically from v2.

### S1 — The managed venv can depend on an interpreter outside the private runtime tree (MEDIUM)

`scripts/runtime-policy.mjs:183` creates the managed environment with the default:

```js
run(bootstrap, ['-I', '-B', '-m', 'venv', temporary], env)
```

Default `venv` creation may symlink its interpreter. The installed runtime on the reviewed machine resolves back to a bootstrap under `/tmp`, so deleting that bootstrap or normal temporary-directory cleanup can break an otherwise marker-valid managed runtime. The private `0700` runtime root protects installed packages but does not make the interpreter self-contained.

The same-UID code-substitution scenario described by v2 is not a separate strong security boundary—an attacker with that authority can also modify the plugin and runtime tree—but the external interpreter dependency is a real availability and provenance problem.

**Fix:** create the venv with `--copies`; reject bootstrap interpreters under unsafe or ephemeral locations unless explicitly approved; record a bounded bootstrap identity in the marker; and make `runtime-status` verify that the managed interpreter is an ordinary executable contained in the runtime tree.

### S2 — GitHub Action pinning checks skip `uses:` values without `@` (MEDIUM)

Both `scripts/check-repository.mjs` and `scripts/supply-chain-check.mjs` only inspect values matching:

```regex
uses: <name>@<ref>
```

A value with no `@` is never checked. This permits a mutable `docker://...:tag` action reference to bypass the claimed immutable-source gate.

**Fix:** parse every non-empty `uses:` value first, then apply explicit policy:

- repository-local `./.github/actions/...` references are allowed because they are part of the reviewed commit;
- external GitHub Actions require `@<40-hex-commit>`;
- `docker://` references require an immutable digest;
- all other forms fail closed.

Add mutation tests for missing `@`, mutable Docker tags, valid Docker digests, and local composite actions.

### S3 — Parent components of the runtime root are not checked for symlinks (LOW)

`assertPrivateDirectory` validates only the final runtime-root node. `mkdirSync(..., { recursive: true })`, `existsSync`, and later filesystem calls may follow a pre-existing symlink in a parent component such as `${XDG_CACHE_HOME}/codex-paper`.

The default location is under the current user's home and this generally requires local control of that user's filesystem, so this is defense-in-depth rather than a primary cross-user boundary.

**Fix:** walk the path from the trusted cache/home anchor to the runtime root with `lstat`, reject symlink or non-directory components, and verify ownership and containment before creation or replacement.

### S4 — Relocating a freshly created venv leaves generated console-script shebangs stale (LOW)

The environment is created under `.python-init-*` and then renamed to `python-3.11.15`. Console scripts such as `bin/pip` keep an absolute shebang pointing to the former initialization directory. `python -m pip` still works and is what the current implementation uses, so the production pipeline is not currently broken, but the resulting venv is internally inconsistent.

**Fix:** avoid relocating a completed venv, create it at its final path behind a runtime setup lock, or rewrite and verify generated shebangs before publication. This should be solved together with B3 and S1 rather than as an isolated patch.

### S5 — The upgraded `pdf-parse` fallback path has no focused compatibility test (LOW)

`pdf-parse` is upgraded to `1.1.4`, but current parser compatibility tests exercise the managed PyMuPDF path. The fallback in `parse-pdf.js` therefore lacks a regression proving that its public JSON remains compatible after the dependency upgrade.

**Fix:** add a deterministic fixture and force only the PyMuPDF extraction attempt to fail, then assert that the `pdf-parse` fallback returns the expected bounded public shape, warnings, and parser metadata without weakening the bounded supervisor or quarantine policy.

### S6 — `CODEX_PAPER_PYTHON_BIN` can bypass the managed runtime version contract (MEDIUM)

`scripts/common.sh` accepts an externally supplied executable path, while `ensure_python` only checks that it is executable. Several parser paths also prefer `process.env.CODEX_PAPER_PYTHON_BIN` directly. `cmd_test` does not invoke the exact CPython/PyMuPDF version assertion before parser-reaching tests.

The override is useful for controlled tests, but silently accepting it in production contradicts the claim that parser execution is uniformly bound to CPython 3.11.15 and PyMuPDF 1.28.0.

**Fix:** validate the interpreter implementation, Python version, and PyMuPDF version before every production parser entry; require an explicit test-only opt-in for noncanonical paths; and make `cmd_test` call the same runtime validation used by parser and benchmark commands.

### S7 — v2 strengthens two existing diagnostic findings

Two v2 observations should be folded into the existing v1 fixes:

- For L2, redact not only the runtime/home path from pip stderr but also URLs containing userinfo or credentials. Raw pip stderr should only be available through an explicit local verbose mode and never in JSON or CI output.
- For L4, convert missing tracked files into structured configuration diagnostics with exit `2`, rather than allowing an unhandled exception to collide with the policy-violation exit `1`.

These strengthen the remedies without changing the underlying v1 findings.

---

## Consolidated disposition and priority

The merged review deliberately retains exact advisory-set drift as fail-closed. A removed or repaired advisory must still invalidate the current exception, as required by `docs/dependency-runtime-supply-chain-policy.md`; the implementation should improve the diagnostic rather than weaken equality to a subset test.

Recommended implementation order:

1. B1: repair the dead Step 9 command and add a path-resolution guard.
2. B2: make the composed sandbox Python runtime complete, remove package managers, and extend build-time plus runtime conformance.
3. B3 + S1 + S4: introduce locked, non-destructive, self-contained runtime replacement.
4. M1 + M2: validate the complete exception schema and distinguish added, changed, removed, and fixed advisories while continuing to block all drift.
5. S2: close the `uses:` parsing hole for external and Docker actions.
6. M3 + M6 + S6: centralize the managed interpreter contract and remove global/unchecked Python paths before P1-4 consumes provenance.
7. L2 + L4 + S7: make failures redacted, structured, and mapped to the correct exit class.
8. S5: add focused fallback-parser coverage.
9. M4/M5 and the remaining Low items: document or explicitly defer them, preserving unrelated user files such as `PaperAnalysisHero.vue`.

Items intentionally not adopted from v2:

- Do not change the reviewed advisory contract to `observed ⊆ expected`; repaired or removed advisories must trigger a fresh review and exception update.
- Do not classify the presence of offline pip/setuptools/wheel as a standalone High sandbox escape. Remove them and assert absence as defense-in-depth while treating the missing shared libraries as the real blocking sandbox defect.
- Do not treat same-UID modification of an external bootstrap as a separate sandbox boundary. Address the concrete self-containment, integrity, and temporary-path availability problem.
