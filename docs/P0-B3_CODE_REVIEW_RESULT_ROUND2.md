# P0-B3 Validation Report 1.0 — Code Review Result (Round 2)

- Reviewer: Claude (independent code review, second pass)
- Date: 2026-07-20
- Branch: `codex/audit-optimizations-2026-07-10`
- Scope: verify remediation of round-1 findings F1–F4 and check for regressions/new defects
- Round-1 report: `docs/P0-B3_CODE_REVIEW_RESULT.md`

## Verdict

**All four round-1 findings are correctly fixed and verified by proof-of-concept.** No new
soundness defects were found. The remediation is minimal and targeted — it did not disturb the
already-correct invariants (standard/strict hash equality, atomic write, symlink rejection,
viewer degradation). Recommend proceeding to close M1 after the two minor notes below are
acknowledged.

## Round-1 finding disposition

### F1 — Conflict-disclosure integer false negative → **FIXED (verified)**

`validation-report.js:355` adds `containsExactNumericValue(text, expected)`, which tokenizes
complete numeric values with boundary guards `(?<![A-Za-z0-9_.]) … (?![A-Za-z0-9_.])` and compares
`Number(token) === expected`. The disclosure check at lines 600-605 now uses it for both the
reasoning-uncertainty and visible-material sides.

Verified by POC:
- Author discloses "inconsistent" but writes only `41.8` (hides `41.0`) → `RESULT_CONFLICT_UNDISCLOSED`
  now **fires** (round-1 false negative closed).
- Author discloses both `41.8` and `41.0` with conflict wording → finding correctly **absent**,
  `RESULT_VALUE_CONFLICT` still present.
- Edge probes: `"41"` matches `41.0`; `"41.00"` matches `41.0`; `"41.8"` does not match `41.0`;
  `"v41"` (letter-prefixed) correctly rejected; `"41.8%"` matches `41.8`.

A regression test was added: `validation-report.test.mjs:190` ("conflict disclosure requires both
exact numeric values, not a shared integer prefix").

Also note the same helper was applied to the corroborating-evidence path (`analysis.js` grounding,
line 559) — previously `text.includes(String(value))`, now `containsExactNumericValue`. This is a
consistent, correct extension of the fix beyond the strict F1 scope.

### F2 / F3 — Native-2.1 checks wrongly applied to compatible 2.0 → **FIXED (verified)**

`validation-report.js:528` introduces
`hasNativeResultClaims = compatibility.mode === 'native_2_1' && facts?.schemaVersion === '2.1.0'`,
and lines 529-637 wrap `projectionFindings`, analysis/reasoning grounding, conflict detection,
conflict disclosure, and visible grounding inside that guard. Facts schema validation is likewise
gated to `native_2_1` (line 470).

Verified by POC:
- Legit 2.0 package (`meta 2.0.0`, `facts 2.0.0`, `keyResults` present, no `resultClaims`) →
  `mode: compatible_2_0`, `canWriteReport: true`, findings = `[PACKAGE_COMPATIBILITY_LIMITED]` only.
  `KEY_RESULTS_PROJECTION_MISMATCH` and `VISIBLE_RESULT_UNGROUNDED` are **absent** (round-1
  false positive closed). Report is `pass_with_warnings` / publishable under standard policy.

**Safety-net confirmed:** a package that declares `meta 2.1.0` but ships a non-2.1 `facts.json`
does not silently skip the typed checks — `facts-2.1.schema.json` pins `schemaVersion` as
`{ "const": "2.1.0" }`, so schema validation fails first. There is no gate-bypass hole.

### F4 — Missing compatible-2.0 test → **FIXED (verified)**

`validation-report.test.mjs:215` ("compatible 2.0 packages skip native ResultClaim checks and
remain warning-only") asserts `mode === 'compatible_2_0'`, `canWriteReport === true`,
`codes` deepEquals `['PACKAGE_COMPATIBILITY_LIMITED']`, and publishable under standard. It even
seeds a `99.9 BLEU` visible number and a legacy `result:0` analysis row to prove those no longer
produce ungrounded errors on the 2.0 path.

## Regression / test evidence (this pass)

- `validation-test`: **20/20** pass (14 engine/cross-artifact + 6 reasoning). Reconciles with the
  summary's `20/20`.
- `viewer-validation.test.mjs`: 4/4 (run within the above group set).
- `check-repository.test.mjs`: **51/51** pass.
- `mandatory-benchmark.test.mjs`: **9/9** pass.
- `reasoning-test`: pass.
- Study scripts suite: 56/58; the **2 failures are environmental only** —
  `parse-pdf-compat.test.mjs` requires the Python `fitz` (PyMuPDF) module, which is not installed
  in this environment. They are unrelated to P0-B3 and predate this delivery.

## Minor notes (non-blocking)

1. **[Low] Thousands-separated values not tokenized.** `containsExactNumericValue` treats
   `"41,800"` as tokens `41` and `800`, so a ResultClaim value of `41800` written with a comma in
   visible material would not be recognized as disclosed/grounded. Metric values in this domain are
   almost always small decimals, so risk is negligible; worth a comment or a future normalization
   if large-magnitude metrics ever appear.

2. **[Info] Corroborating-evidence metric regex.** At line 560 the metric name is embedded into a
   `RegExp` after escaping (`String(row.metric).replace(/[.*+?^${}()|[\]\\]/g, ...)`), which is
   correctly escaped against ReDoS/injection. No action needed — flagged only to confirm it was
   reviewed.

## Recommendation

Round-1 F1–F4 are resolved with verified behavior and accompanying regression tests, and the fix
introduced no new gate-bypass or false-positive paths. **Approve** for M1 close pending remote CI.
The two notes above are optional follow-ups, not blockers.
