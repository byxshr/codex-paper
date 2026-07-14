# P0-B1 Code Review Result

Reviewer: Claude (independent review)
Date: 2026-07-14
Scope: The non-skippable deterministic PDF regression described in `docs/P0-B1_CODE_REVIEW_SUMMARY.md`.

## Verdict

**Approve with one recommended follow-up.** The change delivers what the handoff claims: a repository-owned, fail-closed regression that drives committed PDF bytes through `preparePaper` + the P0-A4 supervisor and both validators, freezing current defects as an explicit XPASS contract. All verification claims in the handoff reproduced locally. One latent fragility (finding #1 below) will make one of the ten frozen findings impossible to cleanly retire in P0-B2 and should be tightened now or explicitly acknowledged.

## Verification reproduced

All run locally against the working tree:

| Check | Result |
|---|---|
| `benchmark-mandatory` | declared=2, executed=2, completed=2, passed=2, failed=0; all 10 findings observed |
| `scripts/tests/mandatory-benchmark.test.mjs` | 8/8 pass |
| `scripts/tests/check-repository.test.mjs` | 45/45 pass |
| `repo-check` | passed (177 tracked files) |
| Committed PDF SHA-256 vs manifests | match for both fixtures |
| Generator `--check` | both PDFs byte-for-byte reproducible |
| Report path redaction | no `/Users`, `$HOME`, or temp paths leaked into the JSON report |

The core design goals hold up under inspection:

- **Fail-closed configuration.** Empty manifest, missing/symlinked fixture, hash drift, and generator-string drift all exit `2`; partial/zero execution and any failed fixture exit `1` via `mandatoryTotalsPass`. The empty-manifest CLI path is covered by a real subprocess test.
- **Bypass prevention.** `run-fixture.mjs` only reaches parsing through `preparePaper`, and the Guard statically rejects any reintroduction of `parsePdfDetailedWorkerInternal`, the parser-worker path, `CODEX_PAPER_PARSER_WORKER`, or the optional skip flag in the worker/runner.
- **Optional-skip isolation.** `CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS` cannot affect the mandatory path — verified by the dedicated test that sets the env var and still gets a fatal "PDF is missing".
- **Path safety.** `isSafeRepositoryPath` / `isSafeRepositoryRelativePath` reject absolute paths, backslashes, and `.`/`..` segments before any `join`; symlinks are rejected in both the runner and the Guard.
- **Redaction.** The worker replaces the temp paper dir in validator stdout/stderr and collapses multi-segment paths in error messages.

## Findings

### 1. (Medium) `FRONT_MATTER_NOISE_IN_ANALYSIS` matches metadata, not just contamination

`detectExpectedFindings` tests the front-matter-noise analysis finding with:

```js
const analysisText = JSON.stringify(analysis || {});
if (/Equal contribution|2017|2026/.test(analysisText)) detected.push('FRONT_MATTER_NOISE_IN_ANALYSIS');
```

`analysisText` is the *entire* serialized analysis object, which always contains:

- `analysis.parserVersion` = `2.0.0+codex.20260713121349` (matches `2026`)
- `analysis.generatedAt` = current wall-clock ISO timestamp (matches `2026` this year)

I confirmed both contaminate the match: with the genuine contaminated result values removed, `/2026/` still fires from `parserVersion` alone.

Today the finding is *supposed* to fire, so this is not a live failure. The problem is the XPASS contract intent. The handoff states P0-B2 must retire each frozen extraction finding by introducing a positive replacement, and the suite treats a disappearing finding as contract drift. But `FRONT_MATTER_NOISE_IN_ANALYSIS` can never disappear as long as `parserVersion` carries a `2026…` build stamp or the run happens in year 2026+ — even after the analysis is fully cleaned. So the one signal that is meant to force a deliberate B2 fix is pinned "on" by unrelated metadata, and a future engineer could believe the defect is frozen when the detector is really matching a version string.

Recommendation: scope the detector to the extracted content rather than the whole object — e.g. match against `analysis.resultsTable` values / `oneSentence` / `contributions` text, excluding `parserVersion` and `generatedAt`. This keeps the current detection (the fixture genuinely emits `2017`/`2026`/`Equal contribution` as result-table values and key results) while making the finding truly retireable in B2.

### 2. (Low) Manifest validation is duplicated across two modules and can drift

`validateMandatoryManifest` in `benchmarks/mandatory/contract.mjs` and the inline block in `scripts/check-repository.mjs` (lines ~314–360) independently re-implement overlapping checks: schemaVersion, fixture id uniqueness, path safety, license id/origin/redistributable/generator/sha256, gold identity, expectedFindings non-empty, reserved-target presence. They currently agree, but there is no shared source of truth, so a future change to one contract can silently pass the other. Consider having the Guard import and reuse the contract module's validator, or add a test asserting the two stay consistent.

### 3. (Low / informational) Determinism boundary is PDF-only, by design

The generator `--check` only compares committed PDF bytes; the authored `reasoning-analysis.json` and `analysis.json` embed `new Date()` timestamps and are regenerated per run into a temp dir. This is correct — those artifacts are never committed and are consumed only by validators in-process — but it means "deterministic regression" refers strictly to the fixture inputs and the finding contract, not to every produced artifact. Worth a one-line note in the contract doc so the wall-clock timestamps in generated files are not mistaken for a determinism leak.

### 4. (Nit) CI-order Guard is a substring position check

The Guard enforces mandatory-before-optional via `workflow.indexOf('benchmark-mandatory') < indexOf('CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS')`. This is adequate and cheap, but it is textual: a stray earlier mention of either token (e.g. in a comment) would satisfy or break it independently of real step order. Acceptable given the low churn of `ci.yml`; noting only so a future YAML refactor keeps the tokens ordered.

## Non-issues confirmed

- `CROSS_ARTIFACT_RESULT_MISMATCH_UNGATED` is gated on `validatorsPassed`, but an unrelated validator failure would independently flip the fixture to fail via `failedChecks`, so the finding cannot silently vanish without another failure surfacing.
- `resultClaims2_1.forbiddenValues` is validated as an array but not yet enforced against extracted values — correct for P0-B1, which only *reserves* the B2 target.
- Reserved ResultClaim values are checked to be present in fixture evidence text, so B2 targets are evidence-grounded rather than aspirational.
- Author/abstract phrase checks use case-insensitive `includesNormalized`; gold phrases resolve against the real extracted fields.

## Recommendation

Merge after addressing finding #1 (tighten the analysis-noise detector to content-only), which preserves current behavior while keeping the B2 retirement path honest. Findings #2–#4 are low priority and can be tracked as follow-ups. The security, fail-closed, and anti-bypass properties are sound and independently verified.
