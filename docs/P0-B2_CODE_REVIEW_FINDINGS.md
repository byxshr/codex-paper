# P0-B2 Code Review Findings

- **Reviewer**: Claude Code (independent review gate)
- **Date**: 2026-07-14
- **Scope**: Working-tree diff for the P0-B2 `2.1.0` package contract (facts `resultClaims`, `keyResults` projection, shared package-compatibility layer, viewer/validator/benchmark wiring). The range diff `@{upstream}...HEAD` is empty; all changes are uncommitted in the working tree.
- **Method**: 8 finder angles (line-by-line, removed-behavior, cross-file, reuse, simplification, efficiency, altitude, conventions) + independent empirical verification via Node harnesses and a full `benchmark-mandatory` run.

## Verdict

The change is functionally sound at the fixture level: `benchmark-mandatory` passes 2/2, both gold files are internally consistent with the migrated `contract.mjs`/validator shape, the `41.8`+`table:2` coupling is legitimately satisfied (a `Table 2` evidence item merges into the prose claim), the `keyResults` projection is 1:1 with `resultClaims`, and no dangling references to the deleted `buildFacts`/`attachLedgerEvidenceRefs`/`__dirname` remain.

However, the new extractor emits several **schema-invalid or semantically wrong claims** that the fixtures do not exercise, and the writer's own validation gate does **not** catch them because `prepare-paper.js` never runs Ajv against `facts.json` (only the unit test does, on a hand-built fixture). These would ship silently in real packages. No CLAUDE.md governs the changed tree, so there are no convention findings.

## Findings (most severe first)

### 1. [Correctness · CONFIRMED] Digits in metric names become result values
`extract-facts.js:196` — The number regex `/(?<![A-Za-z0-9.])-?\d+.../g` rejects `-1` in `ROUGE-1` (lookbehind sees a letter) but then matches the bare `1` (preceded by `-`). `isMetricBound` returns true at distance 0, so `ROUGE-1` / `ROUGE-2` yield bogus claims `{metric:'ROUGE-1', value:1}`, `{metric:'ROUGE-2', value:2}`.

**Verified**: `'We evaluate using ROUGE-1 and ROUGE-2 metrics.'` → `[{ROUGE-1,1},{ROUGE-2,2}]`. Extremely common phrasing in NLP/summarization papers.

**Suggested fix**: exclude a numeric match when the char immediately before is a `-` that directly follows a metric token, or strip the metric-name suffix digits before number scanning.

### 2. [Correctness · CONFIRMED] Medium-confidence evidence silently promoted to high
`extract-facts.js:217` — `confidence: item.confidence === 'low' ? 'medium' : 'high'`. The evidence-ledger emits `'medium'` for most non-heading blocks (`build-evidence-ledger.js:195,200,257,328`), so almost every claim is upgraded to `'high'`, overstating certainty. Schema permits both values, so it passes validation undetected.

**Verified**: a `confidence:'medium'` 41.8 BLEU item yields `confidence:'high'`.

**Suggested fix**: map `low→medium`, `medium→medium`, `high→high` (i.e. preserve, only clamp).

### 3. [Correctness · CONFIRMED] Distinct results merged when a context field is null
`extract-facts.js:161` — `fieldsCompatible` returns true whenever either side is falsy (`!left[field] || !right[field]`). Two genuinely different results that share metric+value but differ because one has a null field get merged, pooling evidence and back-filling attribution.

**Verified**: two separate `28.4 BLEU` items (one `dataset:'WMT 2014'`, one `dataset:null`) collapse into one claim with both evidenceRefs and `dataset:'WMT 2014'`.

**Note**: this is the same mechanism that (correctly) merges the abstract 41.8 claim with the `Table 2` item, so the fix must distinguish "corroborating identical context" from "one side simply failed to extract." Consider requiring at least one shared non-null discriminating field before merging, or treating null as incompatible for datasets/model.

### 4. [Test-correctness · CONFIRMED] keyResultsProjection check false-fails on percent units
`run-fixture.mjs:71` — `Number(projection[index]?.value) === Number(claim.value)`. `projectKeyResults` renders percent claims as `"95.2%"`; `Number("95.2%")` is `NaN`, so the equality is always false.

**Verified**: a 95.2% accuracy claim → projection value `"95.2%"` → `NaN === 95.2` is false. Not triggered today (fixtures use score-unit BLEU), but any future percent-metric gold with `requiresKeyResultsProjection:true` makes a *correct* projection fail the non-skippable suite.

**Suggested fix**: strip a trailing `%` before `Number(...)`, or compare `parseFloat`.

### 5. [Correctness · CONFIRMED] `parseTableNumber` can emit `table:0`, violating the schema
`extract-facts.js:158` — `Number('0')` from `'Table 0'` is returned as `location.table`, but `facts-2.1.schema.json` requires `table` to be `null` or integer `>= 1`.

**Verified**: `'Table 0: ... 41.8 BLEU'` → claim with `table:0`. Because `prepare-paper.js` does not Ajv-validate `facts.json`, the invalid package is written silently.

**Suggested fix**: treat `< 1` as `null`.

### 6. [Correctness · CONFIRMED] Evidence-ref validator ignores the schema pattern
`extract-facts.js:274` — `validateFactsEvidenceRefs` only checks ledger membership, not the schema's `^ev-p\d{3,}-[a-z]+-[a-f0-9]{10}$` pattern or `uniqueItems`. A ledger id like `ev-1` passes the writer gate but fails Ajv downstream.

**Verified**: `valid:true` for a facts object whose ref `ev-1` is present in the ledger but pattern-invalid. Gives false assurance at the exact boundary the change relies on.

**Suggested fix**: also assert each ref matches the shared paper-evidence-id pattern (see finding 10 for the single-source-of-truth cleanup).

### 7. [Correctness · CONFIRMED] `readOnly` is never enforced for `compatible_2_0` writes
`render-from-analysis.js:538`, `build-analysis.js:621`, `scaffold-reasoning-analysis.js:182` — the writer guards throw only on `mode === 'unknown_read_only'`. `compatible_2_0` is classified `readOnly:true` yet re-running `render`/`build-analysis` overwrites `analysis.json` and rendered markdown in place. The handoff's claim that "compatibility reads cannot change files" holds for the viewer GET paths but not these writers.

**Suggested fix**: centralize an `assertWritablePackage(compatibility)` that throws when `compatibility.readOnly` is true (covers both unknown and 2.0), instead of special-casing one mode in three files.

### 8. [Correctness · PLAUSIBLE] Some formerly-v2 packages now skip reasoning validation
`validate-study-package.js:922` — old `isV2Package` returned true if `reasoning-analysis.json` **or** `evidence-ledger.json` merely existed. The new classifier only reaches `compatible_2_0` when `meta.packageVersion` is set **or** a reasoning/ledger `schemaVersion === '2.0.0'`. An externally-assembled package with reasoning files but no `meta.packageVersion` and a non-`2.0.0` schemaVersion is now `legacy_v1`, so `checkReasoningLayer` skips all v2 checks with only a warning.

**Scope**: narrow — `prepare-paper` always writes `meta.packageVersion` — but a real, silent coverage loss for hand-built or future-schema packages.

### 9. [Efficiency · CONFIRMED] Viewer endpoints parse the whole ledger for one fallback field
`facts.get.ts:9`, `analysis.get.ts:7`, `reasoning.get.ts:43` — each now `readOptionalInternalJson('evidence-ledger.json')` and passes it to `classifyPackageCompatibility`, which reads only `ledger?.schemaVersion` **and only as a fallback** when `meta.packageVersion` is absent (never for real 2.0/2.1 packages). The evidence ledger is the largest artifact (full per-page text). This is a per-request full parse on three hot endpoints for a field that is essentially never consulted.

**Suggested fix**: skip the ledger read when `meta.packageVersion` is present, or pass only `{ schemaVersion }`.

## Cleanup / maintainability (lower priority, not individually reported)

- **Duplicated `normalizeWhitespace`** in `extract-facts.js:28`, `build-analysis.js:18`, `render-from-analysis.js:100` — load-bearing for evidence matching; divergence would break cross-artifact quote matching. Extract to a shared util.
- **Duplicated ev-id regex** `^ev-p\d{3,}-[a-z]+-[a-f0-9]{10}$` in `package-compatibility.mjs:50`, `run-fixture.mjs:67-68`, `validate-reasoning.js:17`, and a variant in `librarySecurity.mjs:38`. The shared module is the natural single source of truth — export one `PAPER_EVIDENCE_ID_PATTERN`.
- **7× repeated ternary** `Array.isArray(x.evidenceRefs) && x.evidenceRefs.length > 0 ? x.evidenceRefs : [fallback]` in `build-analysis.js` (132, 317, 360, 410, 423, 484, 505) — one `resolveRefs(item, fallback)` helper.
- **Dead `_contexts` state** in `extract-facts.js` (built at 219, cloned/merged at 172/179, discarded at 230) — never read for any output. Delete it (`_charStart` is used by the sort and should stay).
- **Duplicated unknown-version throw** across three writer scripts — fold into the `assertWritablePackage` helper proposed in finding 7.
- **`directAnalysisEvidenceRefs` passes vacuously** (`run-fixture.mjs:68`): `[].every(...)` is true, so an analysis with zero refs would pass. Not currently exercised (analysis does carry refs), but the check should also assert non-empty when the target requires direct refs.

## What was checked and cleared

- `benchmark-mandatory`: 2/2 PASS (empirically run).
- `41.8`+`table:2` required claim is satisfiable via legitimate table/prose merge.
- `keyResults` projection is 1:1 and order-aligned with `resultClaims`.
- Gold files match `validateReservedTargets` (`requiredAssertions.resultClaims2_1` + `reservedTargets.validationReport1_0`, schemaVersion `1.1.0`).
- No dangling references to deleted `buildFacts` / `attachLedgerEvidenceRefs` / `__dirname`.
- Legacy ref resolution (`resolveLegacyEvidenceRef`) maps `claim→coreClaims`, `result→keyResults`, `limitation→limitations` correctly and passes direct `ev-*` refs through.
- Version decoupling (package/facts `2.1.0`; evidence/reasoning/plugin `2.0.0`) is correct.
- `metricOccurrences` shared-regex `lastIndex` reuse is safe (reset + run-to-null, no reentrancy).

## Recommended action before merge

Fix findings 1, 2, 5, 6 (extractor correctness + validator gap) and 4 (latent test false-fail) before this contract is relied on for real packages; they are cheap and the fixtures won't catch regressions. Findings 7–9 and the cleanup items can be batched. Strongly consider running Ajv against `facts.json` inside `prepare-paper.js` so the writer boundary actually enforces the schema it declares.
