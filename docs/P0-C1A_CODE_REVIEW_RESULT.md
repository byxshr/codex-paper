# P0-C1a Code Review Result

Reviewer: automated code review (Claude)
Date: 2026-07-21
Branch: `codex/audit-optimizations-2026-07-10`
Scope: Paper Identity 1.0 boundary — `paper-identity.js`, `prepare-paper.js` integration, `validation-report.js` identity findings, `parse-pdf.js` parser-version split, schema/contract, and their tests.

## Verdict

**Approve with notes.** The implementation matches the stated design: it establishes a deterministic identity boundary before any flat-layout write, permits only verifiably-identical read-only reuse, and rejects every ambiguous or unsafe collision without expanding scope into C1b/C2. Logic is sound, fail-closed, and well-tested at the unit level. No blocking correctness or security defect found. The notes below are one verification-record discrepancy and several design observations worth recording.

## Verification (reproduced locally)

| Suite | Result | Notes |
| --- | --- | --- |
| `paper-identity.test.mjs` | 8/8 pass | pure-logic identity/canonical/contract tests |
| `validation-report.test.mjs` | 15/15 pass | includes new conditional identity finding test |
| `prepare-paper-identity.test.mjs` | 2/7 pass, **5 fail** | the 5 failures are **environmental**, not code defects (see below) |

### The 5 "failing" tests are environmental, not regressions

The handoff summary claims "Paper Identity/collision tests: 15/15." Locally, the 5 `prepare-paper-identity` tests that spawn the real `prepare-paper.js` fail because **PyMuPDF (`fitz`) is not installed in this sandbox** and the `pdf-parse` fallback cannot read `benchmarks/fixtures/pdf/front-matter-noise.pdf`:

```
Error [pdf_parse_failed]: PyMuPDF unavailable: ModuleNotFoundError: No module named 'fitz'
                          | pdf-parse failed: bad XRef entry
```

The two `prepare` tests that do **not** reach the parser (`slugify` determinism, `--force` argument rejection) pass. This is consistent with the summary's own note that PyMuPDF-backed acceptance passed in the authoring environment. The tests are correct; they simply require the parser to be installed. **Recommendation:** the 15/15 claim should be qualified as "requires PyMuPDF" so future reviewers in a bare environment don't read the failures as a regression.

## Invariants — confirmed

- `sourceRevisionId` derives from exact PDF bytes via `sha256File` (O_NOFOLLOW, streamed). ✓ (`paper-identity.js:259`, `:45`)
- `generationId` excludes cachebuster/time/path/PID/platform: `provenance` (createdAt, pluginBuildVersion, platform) is outside `generation.inputs`, so the fingerprint is stable across those. Test 7 asserts provenance-only changes keep `generationId` constant. ✓ (`paper-identity.js:233-254`, `:263-264`)
- Canonical conflicts fall back to `source:sha256:...` with `CANONICAL_ID_CONFLICT` and never group a paper. ✓ (`:137-146`)
- `action: reused` performs no writes; `validateReusableGeneration` is read-only and the reuse branch returns before any `mkdir`/write. Test 9 snapshots hashes+mtimes and asserts equality. ✓ (`prepare-paper.js:384-399`)
- All managed writes are exclusive/no-follow (`O_CREAT|O_EXCL|O_NOFOLLOW`, `COPYFILE_EXCL`); no `--force` / overwrite path exists — unknown `--*` args exit 2. ✓ (`:193-213`, `:84-85`)
- Legacy packages without identity keep compatibility behavior; `validation-report` only emits identity findings when the package *declares* identity or a record exists (conditional, fail-closed). Test 14 confirms legacy packages are unaffected. ✓ (`validation-report.js:464-471`)

## Design observations (non-blocking)

1. **`paperId` depends on input URL, but `generationId` (in paper-only mode) does not.** The same PDF + workflow prepared once from `https://arxiv.org/abs/X` and once from a local file produces an identical `generationId` but a different `paperId` (`arxiv:X` vs `source:sha256:...`). `resolvePreparationAction` catches this at `prepare-paper.js:315` and throws `PAPER_IDENTITY_CONFLICT` rather than reusing. This is fail-closed and defensible, but it means canonical identity is effectively pinned by the *first* preparation's provenance. Worth an explicit note in the design doc so it's a deliberate choice, not a surprise in C1b.

2. **`resolveCanonicalIdentity` reads only the first two PDF pages** for front-matter identifiers (`:114`, `.slice(0, 2)`). Reasonable for arXiv/DOI front matter, but a paper whose identifiers appear only on a later page silently falls back to source identity. Acceptable given the "trusted, exact-match only" posture; just confirm it's intended.

3. **Registry scan cost.** `scanIdentityRegistry` (`prepare-paper.js:238`) reads and schema-validates every identity record and re-hashes on reuse. Fine for current library sizes; if libraries grow large this becomes O(N) per prepare. Out of scope for C1a (no index-based lookup yet), but a known scaling edge.

4. **`validation-report` index cross-check is best-effort.** It only runs when `paperDir` resolves to the canonical `PAPERS_DIR/papers/<slug>` location (`:496`) and swallows all index read/parse errors into a single `IDENTITY_PROJECTION_MISMATCH`. That's the right fail-closed direction; the coarse catch just means a malformed index and a missing entry surface identically. Acceptable.

## Nits

- `parse-pdf.js` splits `parserVersion` (contract, pre-`+`) from `parserBuildVersion` (full) cleanly, and threads `backendVersion` through both PyMuPDF and pdf-parse paths — good, and it feeds the generation fingerprint so a parser upgrade correctly forces a new generation. No issue.
- `canonicalStringify` correctly sorts object keys recursively and is order-independent (test 5), which is load-bearing for fingerprint stability across JSON key ordering.

## Scope discipline

No leakage into C1b/C2: no multi-generation physical layout, no `current` resolver, no mutable overlays, no legacy migration, no cross-process locks, no Viewer identity UI. The parent P0-C1 correctly remains open pending C1b.

## Recommendation

Merge-ready pending CI confirmation of the 5 parser-dependent integration tests in an environment with PyMuPDF installed. Record observation #1 in the design/ADR before starting C1b.
