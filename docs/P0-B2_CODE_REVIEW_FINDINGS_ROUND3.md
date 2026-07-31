# P0-B2 Code Review Findings — Round 3

- **Reviewer**: Claude Code (independent review gate, round 3)
- **Date**: 2026-07-16
- **Scope**: The round-2 fixes recorded in `docs/P0-B2_CODE_REVIEW_SUMMARY.md` (§"Round 2 Review feedback resolution", items 1–8) plus any regressions or new issues those fixes introduced. Full working-tree diff + untracked `extract-facts.js`, `package-compatibility.mjs`, `storedPackageCompatibility.mjs`, schema.
- **Method**: verified each round-2 fix empirically (Node harnesses, all-permutation merge tests), re-ran `test` (40/40), `benchmark-mandatory` (2/2), `repo-check` (196 files) — all green. Then 3 finder angles hunting for regressions and new issues.

## Verdict

**All eight round-2 fixes are correctly applied and verified.**

| # | Round-2 issue | Fix | Verified |
|---|---|---|---|
| 1 | merge order-dependent / intransitive | candidates sorted by specificity+semantic keys before greedy grouping | all permutations (bridge, no-bridge, two-incompatible-bridges, 4-link chain) yield identical output |
| 2 | legacy render read-only unclear | intentional: writers reject read-only; documented, no writer bypass added | consistent |
| 3 | validate/write asymmetry | legacy_v1 without `--legacy-ok` now errors `LEGACY_PACKAGE_REQUIRES_LEGACY_OK`; new package-benchmark fixture asserts it | tested |
| 4 | cross-endpoint classification split | one shared `classifyStoredPackageCompatibility`; all endpoints inspect both artifacts when meta absent | mismatch case now uniformly `unknown_read_only` |
| 5 | migrate partial-write | pre-write source-version guard rejects unsupported before first write | works for common cases (see finding 1 for the residual edge) |
| 6 | findEvidenceRefs fallback ignored limit | `.slice(0, limit)` added to the fallback branch | verified |
| 7 | resolver passed nonexistent ev-ids | `resolveLegacyEvidenceRef(ref, facts, ledger)` validates membership when ledger provided | verified (still dead code — no live caller) |
| 8 | validateFactsEvidenceRefs char-by-char | `continue` after array-shape check | verified fixed |

The nitro `externals.inline: [/package-compatibility\.mjs$/]` correctly targets the one shared file that lives outside the Nuxt build root; the camelCase server utils bundle normally. FIX 1's merge determinism is the strongest fix — I could not construct any permutation that breaks it.

The round-3 findings below are all **lower severity** — mostly residual edges of the round-2 fixes, none breaking the fixture suite.

## Findings (most severe first)

### 1. [Correctness · CONFIRMED] FIX 5 incomplete: declared-1.x migration still partial-writes
`migrate-package.js:241` (guard) + scaffold call — the new pre-write guard's regex `/^1(?:\.|$)/` intentionally whitelists v1 versions, but `classifyPackageCompatibility` maps a **declared** `1.0.0` to `unknown_read_only` (not `compatible_2_0`). So a v1 package that *declares* `packageVersion: '1.0.0'` passes the migrate guard, migrate writes `paper-data.json` + `evidence-ledger.json`, then `scaffoldReasoningAnalysis` classifies `unknown_read_only`, `explicitV2Migration` (which only bypasses `compatible_2_0`) is false, and `assertWritablePackage` throws `PACKAGE_VERSION_UNSUPPORTED` — the exact partial-write FIX 5 targeted.

**Verified**: directory left with a new ledger, stale `meta.json`, no `reasoning-analysis.json`. The two guards disagree on what "1.x" means.

**Scope**: the common v1 case (no `packageVersion` field at all) migrates fine — scaffold sees `compatible_2_0`. Only an explicitly-1.x-versioned legacy package hits this.

**Fix**: honor the migrate guard's whitelist downstream (pass a v1-migration escape into scaffold, or normalize `meta.packageVersion` before the scaffold call), or reject declared-1.x in the migrate guard too.

### 2. [Correctness · CONFIRMED] Corrupt ancillary artifact now breaks facts/analysis endpoints
`facts.get.ts:9`, `analysis.get.ts:9` — FIX 4 made these endpoints call `classifyStoredPackageCompatibility`, which (for no-`packageVersion` packages) reads `evidence-ledger.json` and `reasoning-analysis.json` via `readOptionalInternalJson`. That helper only swallows 404 — it **throws 422 on corrupt JSON**.

**Verified**: `readOptionalInternalJson` throws `statusCode 422` on `'{not-json'`. Before round-3, facts.get/analysis.get never read those files, so a corrupt ancillary artifact could not break the core endpoint. Now a legacy package with valid `facts.json` but a corrupt `evidence-ledger.json` returns HTTP 422 instead of serving facts.

**Fix**: wrap the ledger/reasoning reads in `classifyStoredPackageCompatibility` in try/catch, treating a parse failure as "no versioned artifact".

### 3. [Correctness · PLAUSIBLE] Corrupt ledger defeats reasoning.get graceful path
`reasoning.get.ts:54` — the `available:false` not-available branch now calls `classifyStoredPackageCompatibility(slug, {meta, reasoning:null})`, which still reads the ledger. A corrupt `evidence-ledger.json` throws 422 instead of returning the intended `{available:false,...}`. Same root cause as finding 2.

### 4. [Test-coverage · CONFIRMED] Corrupt-ledger 422 path is untested
`scripts/tests/viewer-security.integration.mjs:155` — the new corrupt-ledger assertions run only against a `2.1.0` sample, which hits the classifier's `meta.packageVersion` early-return and never reads the ledger. So findings 2–3 (the regression for no-meta packages) are not covered. The test passes precisely because the ledger is never read. Add a legacy/no-meta fixture with a corrupt ledger.

### 5. [Correctness · CONFIRMED, likely intended] Legacy validation exit-code change
`validate-study-package.js:386` — a legacy v1 package without `--legacy-ok` now emits `LEGACY_PACKAGE_REQUIRES_LEGACY_OK` as an **error (exit 1)**, where rounds 1–2 produced only a warning (exit 0). This is the intended contract from round 2 (the new `legacy-v1-requires-legacy-ok` package-benchmark fixture asserts it), but it is a hard behavioral change for any downstream automation that validated legacy packages without the flag. Flagged for explicit confirmation; no code change needed if intended.

### 6. [Correctness · PLAUSIBLE] Version inference recognizes only 2.0.0, not 2.1.0
`package-compatibility.mjs:43` — when `meta.packageVersion` is absent, the inference fallback (`artifactVersions.every(v === '2.0.0')`) only recognizes 2.0.0 artifacts. A package with no `meta.packageVersion` but 2.1.0 reasoning+ledger is classified `unknown_read_only`. Not reachable via the happy path (prepare-paper always writes `meta.packageVersion`), but the asymmetry (2.0.0 inferable, 2.1.0 not) is worth a deliberate decision.

### 7. [Correctness · PLAUSIBLE] Corrupt meta.json silently downgrades a 2.1 package to read-only 2.0
`package-compatibility.mjs:29-51` (via `validate-study-package.js` `compatibilityForPackage` and the viewer's stored classifier) — `readJsonIfExists`/`readOptionalInternalJson` swallow a JSON parse error to `null`. Since a genuine 2.1 package's frozen reasoning/evidence artifacts legitimately stay at `schemaVersion 2.0.0`, a native-2.1 package whose `meta.json` is corrupt is classified `compatible_2_0` (read-only, `PACKAGE_VERSION_INFERRED`) with no error about the unreadable meta.

**Verified**: `classifyPackageCompatibility({meta:null, reasoning:{schemaVersion:'2.0.0'}, ledger:{schemaVersion:'2.0.0'}})` → `compatible_2_0`. Low severity (corrupt meta is abnormal), but the failure is silent rather than diagnostic — writers are wrongly gated read-only and nothing surfaces the corruption.

## Round-2 finding confirmed resolved

Round-2 finding 8 (validateFactsEvidenceRefs iterating a string char-by-char) is **fixed** — a non-array `evidenceRefs` now yields a single `requires evidenceRefs` error and `continue`s. Verified.

## Recommended action

None of the round-3 findings block the fixture contract. Priority: (1) close the declared-1.x migration partial-write — it directly undermines FIX 5's guarantee; (2)+(3) wrap the classifier's ledger/reasoning reads so a corrupt ancillary artifact can't 422 the core endpoints; (4) add the missing corrupt-ledger test for no-meta packages; (5) confirm the legacy exit-code change is acceptable for downstream CI; (6) decide on 2.1.0 inference symmetry. The core round-2 corrections — merge determinism, shared viewer classifier, pre-write migration guard, legacy-ok enforcement — all verify as correct.
