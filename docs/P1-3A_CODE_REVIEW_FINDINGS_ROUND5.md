# P1-3a Code Review — Round 5 Findings and Conclusion

**Scope:** the remediation applied after `docs/P1-3A_CODE_REVIEW_FINDINGS_ROUND4.md`, as dispositioned in `docs/P1-3A_CODE_REVIEW_SUMMARY.md`.
**Reviewed at:** 2026-07-29, branch `codex/audit-optimizations-2026-07-10`.
**Method:** re-read every changed file, ran the engines and every affected suite, then repeated all prior-round probes verbatim — bootstrap removal, `pyvenv.cfg` tampering, both caller-moved-anchor variants — and added two new ones: full Mach-O load-command inspection and in-tree native library tampering.

## Conclusion: **PASS**

Every blocker and every medium finding from rounds 1–4 is closed, and each closure was confirmed by re-running the probe that originally failed rather than by reading the diff. Nothing found in this round is a defect in P1-3a code. Two conditions remain, both outside what local verification can settle:

1. **Remote CI must be green** — the Docker sandbox build/conformance job (never executed anywhere; Docker is unavailable on the review machine) and the Linux `runtime-setup` path, which fails closed by design if `actions/setup-python`'s CPython carries an absolute bootstrap `RPATH`/`RUNPATH`. No local test can determine which way that goes.
2. **A pre-existing flaky test should be tracked** — `concurrent atomic writers leave one complete schema-valid report` fails roughly 1 run in 10 under full-suite load. It is not P1-3a code and not a P1-3a regression, but it will red the pipeline through the new exact-count gate. Fix or quarantine it separately; it does not block this change.

Recommend merge once (1) is satisfied.

---

## Evidence collected

| Check | Result |
| --- | --- |
| `node scripts/supply-chain-check.mjs` | `pass` |
| `node scripts/secret-scan.mjs` | `pass`, 274 tracked files |
| `node scripts/dependency-audit.mjs` | `pass` — plugin 0/0; web 0 critical / 12 reviewed high |
| `node scripts/check-repository.mjs` | Repository contract passed (274 files) |
| repository/security suite | **204/204** — matches the gate's hardcoded 204 exactly |
| `check-repository.test.mjs` | **77/77** — matches the `repo-test` gate's 77 |
| study suite | **87/87** — matches the gate's 87 |
| `supply-chain.test.mjs` | 18/18 |
| `pdf-ingestion-security.test.mjs` | 12/12 |
| Runtime marker | schema 1.5.0; `runtime-status` checks all true except host `node`/`npm` (review host is 22.16.0/11.5.2) |

Every count the summary claims matches what I measured, including the three hardcoded gate expectations.

### Security properties re-verified by probe

| Probe | Result |
| --- | --- |
| Bootstrap directory removed → import `bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib, fitz` | succeeds |
| Bootstrap removed → full `parse-pdf.js` run | **succeeds** — the parser is genuinely independent of the bootstrap |
| Bootstrap removed → `runtime-status` | `python`, `nativeRuntimeSelfContained`, `managedRuntimeContained`, `marker` all true |
| `otool -l` over `bin/*`, `lib/*.dylib`, all `lib-dynload/*.so` | **0 files** reference the bootstrap prefix in any load command, dylib ID, or `LC_RPATH` |
| `CODEX_PAPER_PYTHON_BIN` moved | rejected: `Noncanonical parser runtime overrides are disabled.` |
| `CODEX_PAPER_PARSER_WORKER=1` + both anchor variables moved | rejected identically, before any execution |
| `pyvenv.cfg` `home` repointed out of tree | `marker: false`, `managedRuntimeContained: false`; parser rejects with `failed version or containment verification` |
| One byte appended to `lib/libz.1.dylib` | `marker: false` in `runtime-status`; parse still succeeds (see F3) |

---

## Findings

### F1 — A pre-existing flaky test will red the new exact-count gate roughly 1 run in 10 (LOW, not a P1-3a defect)

Round 4 reported an unattributable single failure. It is now identified:

```
run 3: # tests 87 # pass 86 # fail 1
not ok 87 - concurrent atomic writers leave one complete schema-valid report
```

Observed 1/6 in this round and 1/13 in round 4 when the full study suite runs; **0/12** when `validation-report.test.mjs` runs in isolation — so it is load/timing sensitive, not deterministically broken. Neither `validation-report.test.mjs` nor `validation-report.js` is modified by this change set (`git diff --stat` is empty for both), so this is pre-existing behaviour, not a regression.

It matters here only because `run_counted_test_suite` fails the build on any non-zero status, so `bash scripts/codex-paper.sh test` — and therefore CI — is flaky at that rate. That is worth noting rather than shrugging at, because the phase's whole posture is deterministic gates.

Credit where due: R4-L1 is why this is now diagnosable at all. The preserved-output path (`preserved output: $output`, with `rm -f` moved to the success branch only) is exactly the mechanism that let me name the test.

**Recommendation:** fix the test's concurrency assumption, or run `validation-report.test.mjs` in its own serialized invocation. Track separately from P1-3a.

### F2 — `nativeRuntimeSelfContained` is a derived label, not an independent check (LOW)

`runtime-policy.mjs:234` computes it as `facts.python?.nativeImports === true`, and `nativeImports` is the literal `True` in the probe's JSON payload (`:137`). So the flag is true precisely when the probe ran to completion — the same condition that makes `checks.python` non-null. It can never be false while `python` is true, and it adds no signal beyond it.

The property it names *is* genuinely enforced, and the chain is sound: `verifyNativeReferences` proves no absolute bootstrap reference at publication, and `managedTreeSha256` proves the tree has not changed since — which my byte-append probe confirms works. The issue is only that a reader of `runtime-status --json` will reasonably take a separately-named check as a separate status-time verification.

**Recommendation:** either rename it to reflect what it observes (the extension-module import set succeeded with loader overrides stripped — which is a real and useful thing to report), or make it independent by having the probe emit each module's `__file__` and asserting containment, as the existing `osModule` check already does for `os`.

### F3 — A modified in-tree native library is used by the parser while `runtime-status` rejects it (OBSERVATION — dispositioned, no action needed)

Appending one byte to `<runtime>/lib/libz.1.dylib` flips `marker` to false in `runtime-status`, but the subsequent parse still succeeded: `resolveParserPython` reads `pyvenv.cfg` and the marker's *contents* into its cache key and verifies version plus containment, but does not verify `managedTreeSha256` against the tree.

This is exactly the scenario the round-4 disposition considered and declined, on stated grounds: `CODEX_PAPER_RUNTIME_DIR` is a trusted same-UID operator input, the tree is `0700`, and rehashing 159 MiB per parse "would not create an independent same-UID trust boundary." That reasoning holds — an attacker who can write into the tree can also edit the plugin — so I am recording this as a verified characterisation of the boundary, not as a finding to fix.

One zero-cost option if you want operator-visible detection anyway: `SKILL.md` Step 1 currently preflights with a version-only `runtime-python.sh -c 'import fitz…'`. Making that preflight `codex-paper.sh runtime-status` instead surfaces tree tampering at the start of every study run using machinery that already exists, without claiming a new boundary.

### F4 — `observed()` does not forward `env` to the probe (NIT)

`runtime-policy.mjs:172` calls `pythonFacts(managedPythonPath(env))` with no second argument, so the interpreter path honours the caller's `env` while the probe runs under `process.env`. Harmless today — the probe needs no runtime-specific variables, and `runtimeProbeEnvironment` strips the dangerous ones either way — but `setupRuntime:632` passes `env` correctly, so the asymmetry is accidental and will bite if the probe ever needs caller context.

---

## Round-4 findings verified closed

| Item | Status |
| --- | --- |
| **R4-M1** `LC_RPATH` invisible to macOS verification | **Fixed.** `macRpaths` parses `otool -l` `LC_RPATH` entries; `rewriteMacNativeReferences` rewrites absolute rpaths via `install_name_tool -rpath` (failing closed if the target was not copied); `verifyNativeReferences` folds rpaths into the same bootstrap-prefix rejection as `-L` and `-D`. Verified: a full `otool -l` sweep of `bin/*`, all 53 `lib/*.dylib`, and every `lib-dynload/*.so` finds zero bootstrap references. |
| **R4-M2** Linux verification without relocation; containment unproven | **Addressed on all three sub-points.** Publication now verifies the runtime *in place* before publishing — `writeRelocatedVenvConfig(temporary, temporary)` at `:631` makes the pre-publication probe resolve its stdlib from the copied tree rather than the bootstrap — and `runtimeProbeEnvironment` strips `PYTHON*`, `DYLD_*`, `LD_LIBRARY_PATH`, and `LD_PRELOAD` so the imports cannot be helped by loader overrides. `readelf -d` covers the complete ELF dynamic section (`NEEDED`, `RPATH`, `RUNPATH`), which is where an absolute bootstrap path can appear, so the Linux static coverage is complete for declared references. The remaining decision — no ELF rewriting in P1-3a, fail closed on an absolute bootstrap `RPATH`/`RUNPATH` — is now explicit in `docs/dependency-runtime-supply-chain-policy.md` rather than implicit. That converts my finding from an unexamined gap into a documented scope boundary, which is the right resolution; it does leave the Linux install path as a genuine CI-only unknown (condition 1 above). |
| **R4-M3** count gating covered only two files | **Fixed, and better than proposed.** `run_counted_test_suite` now enforces per-suite totals: repository/security 204, study 87, static guard 77. I verified all three match reality exactly. |
| **R4-L1** flake undiagnosable | **Fixed** — and immediately useful; see F1. Output is preserved with its path reported on both failure and count drift, and removed only on success. |
| **R4-L2** undocumented native prerequisites | **Fixed.** README's System Requirements now lists Xcode Command Line Tools (`otool`, `install_name_tool`, `codesign`) for macOS and `binutils` for Linux, including the relocatable-bootstrap requirement; the policy doc carries the detail. |
| **R4-L3** `CODEX_PAPER_RUNTIME_DIR` relocates the trust root | **Dispositioned with reasoning, not silently dropped.** The summary states the boundary explicitly and explains why per-parse rehashing was rejected. See F3 — I accept the argument. |
| **R4-L4** `bootstrapFacts` weaker than `pythonFacts` | **Fixed.** Bootstrap discovery now imports the same extension-module set, so an unsuitable bootstrap is rejected before the venv, download, tree copy, and native rewrite. |
| **R4-L5** modes outside attestation, umask-dependent | **Fixed.** `copyDereferencedTree` normalizes modes with `chmodSync(target, info.mode & 0o777)` for both files and directories, and the policy doc records it. |

---

## Cumulative disposition across all five rounds

| Round | Blocking | Medium | Low | Outcome |
| --- | --- | --- | --- | --- |
| 1 | 3 | 6 | 9 | all closed (L9 deliberately not adopted, reasoned) |
| 2 | 2 | 5 | 8 | all closed |
| 3 | 1 | 3 | 6 | all closed |
| 4 | 0 | 3 | 5 | all closed |
| 5 | 0 | 0 | 2 + 1 nit + 1 dispositioned observation | no P1-3a defects |

The trajectory is the right shape: each round's blockers were real, each fix was structural rather than a patch over the symptom, and the fixes got progressively better than what the review asked for — the sandbox image inversion (round 2), removing the ambient test switches entirely instead of gating them (round 3), and per-suite rather than per-file count gates (round 5) were all stronger than the recommendations.

Three habits are worth keeping for P1-3b:

- **Guarding each new control with a mutation test.** 77 guard tests now fail if any of these controls is removed, which is what makes the contract durable rather than a snapshot.
- **Preferring structural fixes.** Making the sandbox's final stage the pinned CPython image, and copying the stdlib into the private tree, eliminated whole failure classes instead of detecting them.
- **Recording declined recommendations with reasons.** The `CODEX_PAPER_RUNTIME_DIR`, advisory-set-equality, and Linux-ELF decisions are all argued in the summary. That is what let me close them as dispositioned rather than re-raise them.

---

## Remaining pre-merge checklist

1. **Remote CI green**, with attention to two steps that have never run anywhere: `sandbox-setup`/`sandbox-test`/`sandbox-status`, and `codex-paper.sh install` on `ubuntu-latest` (the Linux `runtime-setup` path). If the second fails on an absolute bootstrap `RPATH`, that is the documented fail-closed behaviour, and the options are a relocatable bootstrap or lifting the Linux ELF-rewrite deferral.
2. **Track F1** (flaky `concurrent atomic writers`) as its own issue. Not a P1-3a blocker.
3. **Optional, cheap:** F2 rename or independent computation; F4 one-line `env` forwarding.

`PaperAnalysisHero.vue` remains untracked and unreferenced, deliberately left as an unrelated user file — unchanged from prior rounds and correctly out of scope.
