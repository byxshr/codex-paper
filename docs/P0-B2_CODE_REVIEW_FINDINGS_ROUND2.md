# P0-B2 Code Review Findings — Round 2

- **Reviewer**: Claude Code (independent review gate, round 2)
- **Date**: 2026-07-14
- **Scope**: The round-1 fixes recorded in `docs/P0-B2_CODE_REVIEW_SUMMARY.md` (§"Independent Review feedback resolution", items 1–9) plus any regressions or new issues those fixes introduced. Full working-tree diff (`git diff HEAD` + untracked `extract-facts.js`, `package-compatibility.mjs`, schema).
- **Method**: verified each of the 9 round-1 fixes empirically (Node harnesses), re-ran `test` (36/36), `benchmark-mandatory` (2/2), `repo-check` (196 files), then 3 finder angles hunting for regressions.

## Verdict

**All nine round-1 fixes are correctly applied and verified.** Summary:

| # | Round-1 issue | Fix | Verified |
|---|---|---|---|
| 1 | ROUGE-1/2 in-name digits → junk claims | number span inside metric span is skipped | `ROUGE-1 and ROUGE-2` → `[]`; `44.2 ROUGE-L` still captured |
| 2 | medium confidence promoted to high | `low` skipped, `high` preserved, else `medium` | medium→medium, low omitted |
| 3 | distinct results wrongly merged | merge requires shared ref OR shared non-null discriminator | two null-dataset 28.4 stay distinct; 41.8+Table2 still merge |
| 4 | percent projection false-fail | `parseProjectedResultValue` strips trailing `%` | `95.2%`→95.2 matches; junk suffixes rejected |
| 5 | `table:0` schema violation | `parseTableNumber` returns null for `<1` | `Table 0`→null |
| 6 | ref validator ignored schema pattern | checks `PAPER_EVIDENCE_ID_PATTERN` + uniqueness + membership; **prepare-paper now runs Ajv** before writing | invalid `ev-1` → valid:false; schema compiles under strict |
| 7 | `readOnly` unenforced for 2.0 writes | shared `assertWritablePackage` in build-analysis/render/scaffold; migrate uses a scoped `explicitV2Migration` exception | compatible_2_0 + unknown throw; exception not CLI-reachable |
| 8 | formerly-v2 pkgs skipped validation | classifier: artifacts must all be `2.0.0` else `unknown_read_only` | reasoning-without-schemaVersion → unknown_read_only |
| 9 | viewer parsed whole ledger per request | ledger read only when version metadata absent | native 2.1 classifies with `ledger:null` |

Also adopted: `PAPER_EVIDENCE_ID_PATTERN` exported from the shared module and imported by extract-facts; dead `_contexts` removed. Tests green.

The round-2 findings below are all **lower severity** than round 1 — they are robustness / consistency / behavior-change issues, several of them side effects of the fixes themselves, none breaking the fixture suite.

## Findings (most severe first)

### 1. [Correctness · CONFIRMED] Merge is order-dependent / intransitive
`extract-facts.js:172` (`mergeCandidates` + `fieldsCompatible:164`) — the round-1 fix (#3) requires a shared discriminator to merge, which makes the "compatible" relation **non-transitive**. Greedy first-match grouping then depends on candidate order.

**Verified**: three BLEU=28.4 candidates — A(dataset only), B(languagePair only), C(both) — yield 2 claims for order `[A,B,C]`, 1 claim for `[C,A,B]`, and 2-with-different-attribution for `[B,A,C]`.

**Impact**: output is stable *per PDF* (the evidence ledger is built deterministically, so the deterministic-regression contract holds), but the merge grouping and evidence attribution are fragile to any future change in ledger ordering. Consider a canonical pre-sort of candidates before merging, or a union-find grouping so the result is order-independent.

### 2. [Correctness · CONFIRMED] legacy_v1 packages can no longer be rendered (behavior change)
`build-analysis.js:621`, `render-from-analysis.js:538` — these paths had **no compatibility guard at HEAD**; the round-1 fix (#7) added `assertWritablePackage`, and `legacy_v1` is `readOnly:true`, so both now throw `PACKAGE_VERSION_READ_ONLY`.

**Verified**: a legacy package (facts+analysis+paper-data, no meta.packageVersion, no ledger) that previously rendered now throws. `migrate-package` only upgrades to `compatible_2_0` (also read-only), so **no path re-renders a non-2.1 package** — only a fresh `prepare-paper` (native 2.1) is writable.

**Recommendation**: if freezing legacy packages is intentional (it is consistent with the summary's "writers reject every read-only mode"), make it explicit — a `--legacy-ok`/migration escape on the writers matching the validator, and a test asserting the chosen behavior. Today there is no test either way.

### 3. [Correctness · CONFIRMED] Validate/write contract asymmetry for legacy_v1
`validate-study-package.js:386` — the validator treats `legacy_v1` as a soft informational skip (exit 0), signalling the package is acceptable, but the writers (finding 2) hard-throw on it. `--legacy-ok` is honored only by the validator.

**Impact**: a user who validates green then renders hits a hard failure with no escape hatch on the write path. The two contracts should agree.

### 4. [Correctness · CONFIRMED] Cross-endpoint compatibility classification split
`reasoning.get.ts:60` — the round-1 fix (#9) skips the ledger read when version metadata is present. But `reasoning.get` skips the ledger when `reasoning.schemaVersion` is truthy and classifies from reasoning alone, while `facts.get`/`analysis.get` skip reasoning and classify from the ledger alone. The classifier's multi-artifact agreement check (`artifactVersions.every(v===2.0.0)`) degrades to a single-artifact check.

**Verified**: package with no `meta.packageVersion`, reasoning `2.0.0`, ledger `3.0.0` → `reasoning.get`=`compatible_2_0`, `facts.get`/`analysis.get`=`unknown_read_only`. The same package reports different `compatibility.mode`/`readOnly` from different endpoints, and the reasoning endpoint's read-only guard is weakened.

**Impact**: read-only (GET metadata only), and it requires a mismatched/tampered package. But the whole point of the shared classifier is one consistent verdict. Prefer classifying from the same inputs everywhere (or keep reading both artifacts when meta is absent).

### 5. [Correctness · PLAUSIBLE] migratePackage can leave a half-migrated directory
`migrate-package.js:255` — no upfront version guard; it writes `paper-data.json` and `evidence-ledger.json`, then calls `scaffoldReasoningAnalysis`, which can throw.

**Scenario**: input with `meta.packageVersion` set to an unsupported value (e.g. `9.0.0`). migrate writes the new ledger + paper-data, then scaffold classifies `unknown_read_only` (the `explicitV2Migration` exception only bypasses `compatible_2_0`) and throws `PACKAGE_VERSION_UNSUPPORTED`. No rollback → the directory has a new ledger but stale `meta.json` and no `reasoning-analysis.json`. `writeJsonAtomic` protects single files, not the multi-file transaction.

**Recommendation**: guard the source version at the top of `migratePackage` (reject unsupported before writing anything), or stage writes and commit atomically.

### 6. [Correctness · CONFIRMED] findEvidenceRefs fallback branch ignores `limit`
`build-analysis.js:181` — the preferred-kind fallback does `fallback.push(...match.refs); return fallback;` with no `.slice(0, limit)`, while both the scored branch (:173) and the terminal `catalog[0]` branch (:189) slice.

**Impact**: a merged resultClaim carrying 2+ evidenceRefs, with analysis text lacking token overlap, makes `findEvidenceRefs(text, facts, ['result'], 1)` return 2 refs when 1 was requested. All refs are valid (no validation failure); the requested cap is silently violated only on this path. One-line fix: `return fallback.slice(0, limit)`.

### 7. [Correctness · CONFIRMED] resolveLegacyEvidenceRef passes format-valid nonexistent ids through
`package-compatibility.mjs:73` — `if (PAPER_EVIDENCE_ID_PATTERN.test(ref)) return [ref];` returns any syntactically-valid ev- id without checking it exists in `facts`/ledger, unlike the `claim:N` path which returns `[]` for out-of-bounds.

**Verified**: `resolveLegacyEvidenceRef('ev-p999-par-abcdef0123', facts)` returns the id even when it exists nowhere. Currently only exported/tested, not wired into a live resolving path — no user-facing impact yet, but the contract is unsound if a reader later uses it to gate evidence display.

### 8. [Robustness · CONFIRMED] validateFactsEvidenceRefs iterates a string char-by-char
`extract-facts.js:282` — when `evidenceRefs` is a non-array string, the guard correctly reports `requires evidenceRefs` but then `for (const ref of item.evidenceRefs)` iterates characters, emitting ~45 garbage per-character errors. Verdict is correct; the error list is noise. Add `continue` after the array-shape check.

## Cleanup (unchanged from round 1, still open, not reported)

The author deliberately deferred these as separate refactors with no demonstrated defect; noting for completeness: duplicated `normalizeWhitespace` across three files; the 7× `Array.isArray(x.evidenceRefs)...` ternary in build-analysis; the `librarySecurity.mjs` path-policy ev-id regex variant. These are acceptable to leave.

## Recommended action

None of the round-2 findings block the fixture contract. In priority order: (1) make the merge order-independent — it underpins a *deterministic* regression contract; (2)+(3) decide and make explicit whether legacy_v1 packages are renderable, and align validate/write; (4) unify viewer classification inputs; (5) guard migrate up front. (6)(7)(8) are one-line hardening fixes. The core round-1 corrections are all sound and verified.
