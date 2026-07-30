# Dependency, Runtime, and Supply-chain Policy

## Trust boundaries

Generation content is affected by the host Node runtime, CPython, PyMuPDF, parser policy, and generation contract. Nuxt and Vue affect only the local Viewer. The Docker runtimes affect only explicitly approved generated-code execution reports. npm and pip are installation tooling.

The authoritative machine-readable classification is `security/runtime-baseline.json`. It is an input to P1-4 provenance, not a second generation manifest.

## Installation

The repository requires Node 22.23.1 and npm 10.9.8 on macOS or Linux. CI installs npm 10.9.8 explicitly after setting up Node. `runtime-setup` additionally requires a CPython 3.11.15 executable, supplied through `CODEX_PAPER_BOOTSTRAP_PYTHON` when it is not named `python3.11`; Windows is intentionally unsupported in P1-3a.

The command creates a private, self-contained CPython runtime under:

```text
${CODEX_PAPER_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-paper/runtime-v1}/python-3.11.15
```

PyMuPDF 1.28.0 is installed with `--only-binary`, `--no-deps`, and `--require-hashes`. Setup copies the CPython executable, standard library, and only the required top-level shared libraries into the private tree; every symlink is dereferenced and its resulting mode is normalized to the source mode. On macOS, absolute bootstrap install names and `LC_RPATH` entries are rewritten to loader-relative references and modified Mach-O files are ad-hoc signed. On Linux, bootstrap-contained `DT_RPATH`, `DT_RUNPATH`, and absolute `DT_NEEDED` values are rewritten in place to shorter `$ORIGIN`-relative values without changing ELF layout; unsupported entries, missing copied targets, or a replacement that does not fit fail closed. Publication then requires `otool -L` plus `otool -l` (macOS), or `readelf -d` (Linux), to confirm that no native dependency or search path still names the bootstrap prefix.

The venv metadata is rewritten first for verification in the initialization tree and then for the final target. Bootstrap discovery and post-install verification both import extension-backed modules (`bz2`, `ctypes`, `lzma`, `readline`, `sqlite3`, `ssl`, `uuid`, and `zlib`); post-install verification also imports PyMuPDF. Loader- and Python-path environment overrides are removed from the verification subprocess. Runtime status exposes a separate `nativeRuntimeSelfContained` check, while the parser use point independently requires `sys.base_prefix`, the standard library, and `os.__file__` to resolve inside the managed tree.

The marker hashes the executable, standard library, and complete managed tree—including file type, mode, path, `pyvenv.cfg`, native libraries, and `bin/`—while excluding only the marker itself and runtime-generated `__pycache__`, `.pyc`, and `.pyo` entries. Symlinks and special files make attestation fail closed. The resulting macOS runtime is approximately 159 MiB and remains usable after the bootstrap installation is removed.

The bootstrap is used only during setup. A bootstrap under a fixed ephemeral root such as `/tmp` or `/var/tmp` is rejected unless the operator explicitly names it through `CODEX_PAPER_BOOTSTRAP_PYTHON`; the selected prefix and standard library must be ordinary, root-or-current-user-owned, and not group- or world-writable. Unsafe implicit candidates are skipped while an explicitly selected unsafe bootstrap fails immediately. Linux relocation is deliberately narrow: it changes only dynamic strings that resolve inside the verified bootstrap prefix, requires the corresponding target to exist in the managed tree, preserves all system and already-relative entries, and is followed by both `readelf` inspection and the native-module import probe.

GitHub CI explicitly selects the interpreter installed by the pinned `actions/setup-python` revision. Because the hosted toolcache is provisioned with broader directory write modes than the bootstrap policy accepts, the ephemeral runner removes group/world write permission from the selected prefix and standard-library directory before setup. This is a permission normalization step, not a bootstrap-policy exemption; the ordinary-directory, owner, version, native-import, and ELF-reference checks still run unchanged.

On 64-bit Linux, `venv --copies` may still create the conventional `lib64 -> lib` symlink. Before native inspection and publication, setup removes that alias only when it resolves exactly to the same venv's `lib/` directory. A regular `lib64` entry, a broken link, or a link to any other target fails closed; the published managed runtime remains symlink-free.

Bootstrap identity is stored as hashes without exposing its local path. Global Python packages and noncanonical `CODEX_PAPER_PYTHON_BIN` or caller-moved parser anchors are never accepted as the production parser runtime. `CODEX_PAPER_RUNTIME_DIR` remains an explicit trusted-operator configuration input, not a cryptographic identity boundary; a caller able to replace that same-UID private tree is within the documented local trust boundary. The parser supervisor forwards the resolved managed runtime root to its worker, and the worker independently verifies the exact interpreter path, runtime metadata, native imports, version, and containment before parsing.

Runtime setup is serialized by `${CODEX_PAPER_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-paper/runtime-v1}/.runtime-setup.lock`. A lock owned by a dead process on the current host, or a lock older than 30 minutes, is reclaimed automatically. A live or recent lock fails with exit `3`. If setup was forcibly interrupted and automatic recovery cannot classify the lock, first confirm no setup process is running, then remove only that `.runtime-setup.lock` directory and rerun `runtime-setup`.

Plugin and Viewer dependency installation uses `npm install --ignore-scripts --legacy-peer-deps` until P1-3b introduces `npm ci` and a root workspace. Lifecycle scripts are disabled. The exact peer-resolver relaxation, reachability, mitigations, expiry, and removal decision are recorded in `security/dependency-policy.json`. Supply-chain verification runs both before and after installation; installation must leave reviewed lockfiles byte-for-byte unchanged.

## Advisory policy

- Critical advisories always block.
- High advisories block unless they exactly match the reviewed package/range set.
- Exceptions contain reachability, mitigation, and an absolute expiry date.
- A new, removed, or changed advisory causes contract drift and requires a fresh review.
- The current Nuxt exception expires on 2026-08-31.

Nuxt serves only the loopback Viewer behind Host, Origin, session, CSRF, CSP, and active-content controls. Archive/glob dependencies are build-time paths over trusted repository input.

## Secret and supply-chain policy

The scanner reports only rule ID, file, line, and a one-way content hash. Exact synthetic fixtures may be allowlisted by file, line, rule, hash, justification, and expiry. Tracked files larger than the configured 8 MiB scan budget fail closed and must be deliberately restructured or reviewed; missing tracked files are reported as configuration errors rather than uncaught failures.

GitHub Actions and Docker bases use immutable SHA pins. npm dependencies use exact versions and registry lockfile integrity. Python uses exact versions and wheel hashes. Changes to protected supply-chain artifacts require updating `security/supply-chain-review.json`.

The reviewed artifact hashes are a change-visibility control: they force policy engines, runtime gates, and their core tests into the review diff when changed. They are not independent tamper resistance because a coordinated source-and-review-file edit can update both sides. Repository review and branch protection remain the trust boundary.

For guard-only work that does not need Python, run:

```bash
bash scripts/codex-paper.sh repo-test
```

The source-text check for deleting the active runtime before publication is deliberately a regression canary. Rollback safety is implemented by `publishPreparedRuntime` and its failure-path tests, not inferred from that regex alone.

## Exit codes

- `0`: policy satisfied.
- `1`: security policy violation.
- `2`: invalid arguments or policy configuration.
- `3`: required runtime, npm audit service, or external capability unavailable.
