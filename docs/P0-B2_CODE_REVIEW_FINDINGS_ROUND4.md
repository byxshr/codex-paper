# P0-B2 Code Review Findings — Round 4

- **Reviewer**: Claude Code (independent review gate, round 4)
- **Date**: 2026-07-16
- **Scope**: The round-3 fixes recorded in `docs/P0-B2_CODE_REVIEW_SUMMARY.md` (§"Round 3 Review feedback resolution", items 1–7) plus any regressions or new issues those fixes introduced. Full working-tree diff + untracked `extract-facts.js`, `package-compatibility.mjs`, `storedPackageCompatibility.mjs`, schema, and the two new test files.
- **Method**: verified each round-3 fix empirically (Node harnesses, end-to-end migrate runs), re-ran `test` (42/42), `benchmark-mandatory` (2/2), `repo-check` (196 files) — all green. Then 3 finder angles hunting for regressions and new issues.

## Verdict

**All seven round-3 fixes are correctly applied and verified.**

| # | Round-3 issue | Fix | Verified |
|---|---|---|---|
| 1 | declared-1.x migration partial-write | shared `isLegacyMigrationSourceVersion` used in both migrate guard and scaffold's `explicitV2Migration` bypass | end-to-end migrate of a declared-`1.0.0` package now completes to 2.0.0 (new test 6) |
| 2/3 | corrupt ancillary artifact 422s viewer endpoints | `readCompatibilityArtifact` catches 422 → `classifyInvalidPackageArtifacts` (`PACKAGE_ARTIFACT_INVALID`), primary artifact still served | no-meta + corrupt ledger → 200 with `unknown_read_only` |
| 4 | corrupt-ledger path untested | new `corrupt-ledger-paper` fixture (no meta, no reasoning, corrupt ledger) across facts/analysis/reasoning | genuinely hits the no-meta path |
| 5 | legacy exit-code confirmed intentional | documented; new `legacy-v1-requires-legacy-ok` package-benchmark fixture | consistent |
| 6 | 2.1.0 inference asymmetry confirmed | deliberately not inferred; unit test freezes fail-closed | consistent |
| 7 | corrupt meta silently inferred 2.0 (validator) | validator `readJsonIfExists` collects invalidArtifacts → `PACKAGE_ARTIFACT_INVALID` | verified |

The shared `isLegacyMigrationSourceVersion` predicate is robust (`1abc`/`10.0.0`/`2.1.0`/`9.0.0` rejected, whitespace trimmed, null-safe). All three `readJsonIfExists` call sites were updated to the new 3-arg signature — no stale 1-arg call. `classifyInvalidPackageArtifacts([])` produces a sensible message with `diagnostics[0]` always present. check-repository guards protect all round-4 sentinels.

The round-4 findings below are all **lower severity** — residual edges of the round-3 fixes, none breaking the fixture suite.

## Findings (most severe first)

### 1. [Correctness · CONFIRMED] Migration partial-write hole persists via unsupported ancillary-artifact version
`migrate-package.js:241` — round-3 finding 1 was fixed for a package that *declares* `packageVersion: '1.x'`, but the pre-write guard only inspects `meta.packageVersion`. A legacy package with **no** `meta.packageVersion` but a pre-existing `evidence-ledger.json` declaring an unsupported `schemaVersion` (e.g. `3.0.0`) skips the guard entirely, writes `paper-data.json` + `.codex-paper/external-evidence.json`, then `scaffoldReasoningAnalysis` classifies `unknown_read_only` and `assertWritablePackage` throws `PACKAGE_VERSION_UNSUPPORTED`.

**Verified**: `migratePackage` on such a directory throws after writing paper-data + external-evidence — the same partial-write class round-3 finding 1 was meant to close, reached by a different input.

**`--force` asymmetry**: with `--force`, migrate rebuilds the ledger at `schemaVersion 2.0.0` *before* scaffold re-reads it, so `--force` silently succeeds while the default path partial-writes on the same input — a surprising divergence.

**Fix**: preflight the full classification (`classifyPackageCompatibility({meta, ledger, reasoning})`) at the top of `migratePackage` and reject any non-migratable version before the first write, rather than only checking `meta.packageVersion`.

### 1b. [Robustness · PLAUSIBLE] Corrupt meta.json crashes migrate with a raw SyntaxError
`migrate-package.js:240` — `readJson(metaPath)` does a bare `JSON.parse`, so a corrupt `meta.json` throws an opaque `SyntaxError` ("Unexpected token…") instead of the clean `PACKAGE_ARTIFACT_INVALID` / `MIGRATION_*` diagnostic the validator now emits. No partial write occurs (it's the first read), so this is cosmetic — but inconsistent with the round-4 corrupt-artifact handling elsewhere.

### 2. [Correctness · CONFIRMED] Corrupt meta.json now 422s the facts endpoint
`facts.get.ts:9` — round-4 added a `meta.json` read to facts.get (it did not read meta at HEAD). The read is `readOptionalInternalJson(slug,'meta.json') || {}` — the `|| {}` guards a *missing* file (returns null), but a *corrupt* file throws 422, which propagates out of the handler.

**Verified**: `readOptionalInternalJson` throws `statusCode 422` on corrupt JSON. So a package with valid `facts.json` but a truncated `meta.json` now returns HTTP 422 from the Facts tab, where at HEAD it returned 200. This is inconsistent with the round-4 philosophy (corrupt ancillary artifacts degrade to `unknown_read_only`, not 422) — meta.json is only used here for the compatibility sidecar, not directly required for facts.

**Fix**: wrap the meta read in the same 422-tolerant path, degrading to `classifyInvalidPackageArtifacts(['meta.json'])` while still serving the valid facts.

### 3. [Correctness · CONFIRMED] Corrupt meta.json now 422s the analysis endpoint
`analysis.get.ts:8` — identical root cause and fix as finding 2. analysis.get also did not read meta.json at HEAD; now a corrupt meta.json 422s the whole Analysis payload despite valid `analysis.json`.

**Note**: `reasoning.get.ts` read `meta.json` at HEAD already, so corrupt-meta → 422 there is *pre-existing*, not a round-4 regression — no finding for reasoning.get.

### 4. [Correctness · CONFIRMED] Misleading diagnostic on mixed artifact versions
`package-compatibility.mjs:61` — when `meta.packageVersion` is absent and the two artifacts disagree (e.g. reasoning `2.0.0` supported, ledger `3.0.0` unsupported), the classification is correctly `unknown_read_only`, but the diagnostic message uses `artifactVersions[0]`, which can be the *supported* version. It reads "...unsupported or missing version **2.0.0**..." when the actual offender is `3.0.0`.

**Verified**. Cosmetic — the fail-closed classification is right — but the operator-facing message points at the wrong version. Fix: name the version(s) that are not `PREVIOUS_PACKAGE_VERSION`.

### 5. [Correctness · CONFIRMED] Validator vs viewer divergence on corrupt artifact under a declared version
`storedPackageCompatibility.mjs:15` — the viewer short-circuits on `meta.packageVersion` **before** reading artifacts (the round-1 perf optimization), so a package with `meta.packageVersion: '2.1.0'` but a **corrupt** `evidence-ledger.json` is reported `native_2_1`, `readOnly: false` (writable). The CLI validator (`compatibilityForPackage`) reads all three artifacts and downgrades the **same** package to `unknown_read_only` / `PACKAGE_ARTIFACT_INVALID`.

**Verified**: viewer → `native_2_1` (writable); validator → `unknown_read_only`. The two paths are not equivalent for this input. The integration test's corrupt-ledger sub-test under a declared 2.1.0 meta asserts `native_2_1` stays — i.e. it *codifies* this divergence as intended rather than catching it.

**Judgment**: defensible as a deliberate trust boundary (the viewer trusts authoritative meta; the validator is exhaustive). But it contradicts the intent behind the shared classifier ("one consistent verdict"), and a consumer gating writes on `compatibility.readOnly` from the viewer would treat a package the validator flags corrupt as writable. Worth an explicit decision: either the viewer should also fail-closed on a corrupt ancillary artifact even under a declared version, or the "cross-endpoint classification" guarantee should be documented as not covering this case.

## Recommended action

None of the round-4 findings block the fixture contract, and all seven round-3 corrections are verified sound. Priority: (1) preflight the full compatibility classification in `migratePackage` before any write — this closes the last partial-write path and generalizes round-3 finding 1's fix; (2)+(3) wrap the viewer meta reads so a corrupt meta.json degrades to `PACKAGE_ARTIFACT_INVALID` instead of 422 (or, if the 422 is intended, correct the round-3 summary wording and pin it with a test); (4) fix the diagnostic to name the offending version. Findings 2–4 are all one-to-few-line changes.
