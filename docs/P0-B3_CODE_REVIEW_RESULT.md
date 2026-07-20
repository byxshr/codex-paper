# P0-B3 Validation Report 1.0 — Code Review Result

- Reviewer: Claude (independent code review)
- Date: 2026-07-20
- Branch: `codex/audit-optimizations-2026-07-10`
- Scope reviewed: engine, schema, both CLIs, viewer API/parser/UI, contract tests, repository gate

## Verdict

The implementation is well-structured and the headline invariant (standard vs. strict runs
produce identical intrinsic status/findings/publishability/report hash) holds. Report writes
are correctly confined to `.codex-paper/validation-report.json`, symlink boundaries are rejected,
the atomic writer survives concurrent writers, unsupported/corrupt packages fail closed without
mutation, and the viewer parser degrades missing/legacy/corrupt reports into safe diagnostics
without leaking the library path or requiring a valid reasoning artifact.

However, I found **two soundness defects** where the gate silently passes or wrongly fails.
Both are reproduced with proof-of-concept below. Recommend fixing #1 and #2 before closing M1.

---

## Findings

### F1 — [High] Conflict-disclosure check is defeated by integer-valued results (`RESULT_CONFLICT_UNDISCLOSED` false negative)

**File:** `plugins/codex-paper/skills/study/scripts/validation-report.js:590-596`

The disclosure gate tests whether both conflicting values appear in the visible text and in
reasoning uncertainty:

```js
const visibleDisclosed = visibleText.includes(String(pair.left.value))
  && visibleText.includes(String(pair.right.value))
  && CONFLICT_DISCLOSURE.test(visibleText);
```

`pair.right.value` is a JS number, so `String(41.0)` is `"41"`. `visibleText.includes("41")`
matches any occurrence of the digits `41` — including inside the *other* value `41.8`
("...41.8..." contains "41"). Consequently an author who discloses the conflict wording but
writes **only** the `41.8` figure (dropping `41.0` entirely) is treated as having disclosed both
values, and `RESULT_CONFLICT_UNDISCLOSED` never fires. This is exactly the invariant the summary
calls out as most important ("A conflict must be … explicitly disclosed with both values").

**Failure scenario (POC, verified):** ResultClaims `41.8` (Table) and `41.0` (prose); README says
*"Our 41.8 BLEU result is inconsistent with figures elsewhere."*; reasoning uncertaintyZone reason
mentions only `41.8`. Engine emits `RESULT_VALUE_CONFLICT` (warning) but **not**
`RESULT_CONFLICT_UNDISCLOSED`. The package publishes under standard policy while hiding the
`41.0` value — the precise scenario the gate exists to block.

The same substring weakness affects the metric-grounding maps (`supported.get(`${metric}:${value}`)`)
but there the key includes the metric and exact numeric string, so the risk is lower; the
disclosure check is the material one because it drives a blocking `error`.

**Suggested fix:** compare against word-boundary numeric tokens (e.g. match
`\b41\.0\b` / `\b41\b` with a negative-fraction lookahead) rather than raw `String.includes`,
and reuse the same tokenizer already present in `validate-reasoning.js`
(`extractNumericTokens`) so integer vs. decimal values are matched exactly.

---

### F2 — [High] Legitimate compatible 2.0 packages are hard-failed by `KEY_RESULTS_PROJECTION_MISMATCH`

**File:** `plugins/codex-paper/skills/study/scripts/validation-report.js:412-448` (`projectionFindings`), reached for `mode === 'compatible_2_0'` because `canWriteReport` is true (line 466).

`projectionFindings` assumes `resultClaims` and `keyResults` are 1:1 (typed 2.1 projection).
But 2.0 packages predate typed ResultClaims: their `facts.json` has `keyResults` and **no**
`resultClaims`. For such a package `resultClaims.length (0) !== keyResults.length (>0)`, so the
engine emits an `error`-severity `KEY_RESULTS_PROJECTION_MISMATCH` and the report becomes `fail` /
`block`.

The summary states "Package 2.0 is validated in memory with a compatibility warning" and is meant
to remain publishable-capable through the read-only compatibility layer. Instead any 2.0 package
that actually contains results is now blocked.

**Failure scenario (POC, verified):** `meta.packageVersion = "2.0.0"`, `facts.schemaVersion = "2.0.0"`
with one `keyResults` entry and no `resultClaims`. `inspectPackageArtifacts` reports
`mode: compatible_2_0`, `canWriteReport: true`, and findings include
`KEY_RESULTS_PROJECTION_MISMATCH`. A previously-valid 2.0 package fails the new gate.

**Suggested fix:** gate the projection/ungrounded/conflict cross-checks on
`compatibility.mode === 'native_2_1'` (or on `facts.schemaVersion === '2.1.0'`), and skip typed-
ResultClaim projection when the package is `compatible_2_0`. The 2.0 path already carries
`PACKAGE_COMPATIBILITY_LIMITED`; typed 2.1 consistency simply does not apply to it.

Note: current fixture/tests only exercise 2.1 packages, so this path is untested — see F4.

---

### F3 — [Low] `facts.json` schema is validated only when `schemaVersion === '2.1.0'`; other results-bearing checks still run unconditionally

**File:** `plugins/codex-paper/skills/study/scripts/validation-report.js:463-465`, and the
unconditional cross-artifact loops at 531-626.

`validateArtifactSchema(facts, validateFacts21, ...)` is correctly skipped for non-2.1 facts, but
the analysis/reasoning/visible grounding loops and `projectionFindings` are not similarly gated.
This is the same root cause as F2 and would be resolved by the same mode gate. Calling it out
separately because even after fixing the projection mismatch, `ANALYSIS_RESULT_UNGROUNDED` /
`VISIBLE_RESULT_UNGROUNDED` will still fire against 2.0 packages (whose `resultClaims` is empty,
so `supported` is empty and every visible metric is "ungrounded").

**Suggested fix:** short-circuit all typed-ResultClaim-dependent checks when the package is not
native 2.1.

---

### F4 — [Medium] No test covers the compatible-2.0 path through the report engine

**File:** `plugins/codex-paper/skills/study/scripts/tests/validation-report.test.mjs`

Every fixture in the contract suite declares `packageVersion: '2.1.0'`. The
`compatible_2_0` branch — which the summary lists as an explicit compatibility invariant and which
F2/F3 show is broken — has no assertion. The `unknown_read_only` path is tested; the
`compatible_2_0` writable path is not.

**Suggested fix:** add a fixture with `meta.packageVersion = '2.0.0'`, `facts` without
`resultClaims`, and assert the report is writable, warning-only, publishable under standard, and
does **not** contain projection/grounding errors.

---

## Confirmed-correct invariants

- Standard vs. strict identical intrinsic state + report hash (verified: hashes equal, only
  `gate.outcome` differs `allow_publish` vs `block`).
- `reportHash` is computed over the `intrinsic` object only, correctly excluding `gate`,
  `generatedAt`, `errors`, `warnings` (line 215-236).
- Finding overflow fails closed with `VALIDATION_FINDINGS_TRUNCATED` and truncates to 500.
- Atomic write: `O_EXCL | O_NOFOLLOW`, fsync file + dir, rename; concurrent-writer test leaves a
  single schema-valid report.
- Symlinked report target and symlinked `.codex-paper` dir both rejected without writing.
- Unknown package version stays report-free; existing files' mtimes unchanged.
- Viewer parser caps findings at 100, sets `truncated`/`findingCount`, treats schema-less
  `errors`/`warnings` reports as legacy non-publishable, and never leaks the library path
  (asserted). Viewer endpoint validates slug and reuses `readOptionalInternalJson` (no-follow read).
- Vue panel renders `finding.code/artifact/path/message` via text interpolation (no `v-html`),
  so report content cannot inject markup.
- Repository gate asserts the engine writes only `validation-report.json`, that mandatory fixtures
  require Validation Report 1.0, and that CI runs `validation-test` before `benchmark-mandatory`.

## Reproduction

- POC for F1 and F2 were run against `inspectPackageArtifacts` directly and reproduced the false
  negative / false positive respectively. Existing suite: `16/16` pass
  (`validation-report.test.mjs` 12, `viewer-validation.test.mjs` 4).

## Recommendation

Fix F1 (disclosure token matching) and F2/F3 (gate typed checks on native-2.1) before closing M1,
and add the F4 compatibility test. F1 undermines the report's primary purpose; F2/F3 break the
stated 2.0 compatibility guarantee.
