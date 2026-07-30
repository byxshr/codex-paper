# P1-4 Code Review — Round 4 Findings and Sign-off

**Scope:** the round-3 remediation described in `docs/P1-4_CODE_REVIEW_SUMMARY.md` §"Review round 3 disposition", re-reviewed against `docs/P1-4_CODE_REVIEW_FINDINGS_ROUND3.md`.
**Reviewed at:** 2026-07-30, branch `codex/audit-optimizations-2026-07-10`.
**New/changed since round 3:**

- `cli-error-format.mjs`: `sanitizeText` applied to both message and details, empty-details suppression, structured truncation
- `generation-provenance.mjs`: `PROVENANCE_DRAFT_MISSING`, frozen-schema comment on the adoption-pair inference
- `generation-workspace.mjs`: `maybeFault` helper
- `SKILL.md` (study): publish step moved to the checkout-relative wrapper
- `generation-provenance.test.mjs`: dedicated CLI formatter regression (+1 test)
- `check-repository.mjs`: guards for `sanitizeText`, `PROVENANCE_DRAFT_MISSING`, the exact `maybeFault` call, and `"study" 100`

## Verdict: **PASS**

All six actionable round-3 items are fixed, and I verified the two I had demonstrated as live defects by re-running the same probes — both are closed. The remediation went beyond the minimum in the right places: truncation now yields structurally valid JSON rather than a marker suffix, the missing-draft error is typed with a `causeCode` detail, and every fix is pinned by a Repository Guard token so it cannot silently regress.

Round 4 found no correctness defects. Three low items below are hardening and cosmetic notes, none of which I could reach from any real code path.

Sign-off carries two conditions that are outside the code and already stated in the handoff — see **Conditions** at the end.

---

## Round 3 disposition — verified

| # | Finding | Status | Evidence |
|---|---|---|---|
| R1a | Missing draft surfaced as raw `ENOENT` | **Fixed, verified** | `readProvenanceDraft:554-568` types it `PROVENANCE_DRAFT_MISSING` (404) vs `PROVENANCE_DRAFT_INVALID` (422) with `details.causeCode`. Re-ran my round-3 probe: `Error [PROVENANCE_DRAFT_MISSING]: Workspace provenance draft is missing.` / `Details: {"causeCode":"ENOENT"}` — no path |
| R1b | `message` not path-redacted | **Fixed, verified** | `sanitizeText` now handles message and details through one function. Re-ran the round-3 leak: `ENOENT: no such file or directory, lstat '[redacted-path]'`. The URL-placeholder pass preserves `https://` locators while stripping credentials, query and fragment, so redaction does not destroy the useful part of a message |
| R2 | Useless `Details: {}` on most errors | **Fixed, verified** | `formatCliError:56` returns early when the serialized value is `{}` or `[]`. Re-ran the probe: `publication-cli publish /tmp/nope` now prints one line |
| R3 | Two conventions for root commands in SKILL.md | **Fixed** | `SKILL.md:592` publish step now uses `../../../../scripts/codex-paper.sh`. All P1-4 commands (prepare, runtime-status/setup, provenance-resolve, publish-workspace) share one form; the sandbox block at `:582-585` keeps its bare form with its explicit "from the repository root" annotation, which is a deliberate and self-documenting exception |
| R4 | Truncated details emitted invalid JSON | **Fixed, better than proposed** | `formatCliError:57-69` rebuilds a `{truncated: true, preview}` object and shrinks `preview` until the serialization fits, falling back to a bare marker. The loop is monotone in `preview.length` and exits on empty, so it terminates. The test asserts `JSON.parse(details)` succeeds and `truncated === true` |
| R5 | Adoption inference undocumented | **Fixed** | `manifestDiagnostics:1055-1058` records that Manifest 2.0 and the draft key allowlist are frozen, so adoption is encoded as an adjacent recovered aborted/completed pair, and asks that the inference be kept until a versioned schema can add a first-class field. That is exactly the reasoning a future reader needs |
| R6 | Inline fault injection | **Fixed** | `maybeFault(options, point)` helper at `generation-workspace.mjs:100`, called at `:483`; the guard requires the literal `maybeFault(options, 'after_authoring_demotion')`, so the ordering test's hook cannot be renamed away |
| Coverage 6 | `formatCliError` untested | **Fixed, thorough** | `generation-provenance.test.mjs:232-287` covers secret-keyed values, credentialed URLs, absolute paths in both message and details, empty details, oversized details (parse-checked), circular details, and the missing-draft CLI path with `stderr.includes(libraryRoot) === false`. This is the case set I recommended plus circular refs |
| R7 | N10 timeline claim | **Corrected** | `docs/P1-4_CODE_REVIEW_SUMMARY.md:83-84` now reads "were present in the round-2 snapshot and were removed during that remediation", matching what I observed |

The five remaining test gaps I listed in round 3 (event/dependency limit codes, seal-time `PROVENANCE_EXECUTION_INVALID`, the `meta.json` half of the projection check, `postSealEvents` happy path and `compatible_1_0` end-to-end, `PROVENANCE_ACTOR_INVALID`) are still open. I flagged them as low-value relative to what is covered and I stand by that; they are all fail-closed paths guarded by code that is exercised from the other direction.

---

## New findings — all low, none reachable

### S1 — path redaction is anchored on an allowlist of preceding characters (LOW, hardening)

`sanitizeText:22` only redacts an absolute path when it follows start-of-string, whitespace, `:`, `(`, or `=`; `:21` separately handles the quoted form. Probing the function directly:

```
ok    "quoted '[redacted-path]'"            ok    "colon:[redacted-path]"
ok    "space [redacted-path] here"          ok    "paren([redacted-path])"
ok    "eq=[redacted-path]"                  ok    "json {\"path\":\"[redacted-path]\"}"
ok    "tilde [redacted-path]"               ok    "url https://example.com/a and [redacted-path]"
LEAK  "bracket[/Users/me/secret.pdf]"       LEAK  "comma,/Users/me/secret.pdf"
LEAK  "angle</Users/me/secret.pdf>"         LEAK  "double//Users/me/x"
```

I could not reach any of these from real code. The repo's own error messages interpolate only relative paths (`event.path`, dependency paths, `relativePath`), and Node's fs errors use the quoted form or `, open /path` — both covered, as are `file:///…` (redacts to `file:[redacted-path]`) and the symlink/containment errors I probed through the CLIs. So this is future-proofing rather than a live leak: any new message format that embeds a path after `[`, `,`, `<`, or a doubled slash would leak silently.

**Suggested hardening:** replace the preceding-character allowlist with one positive rule — redact any `/`-rooted run of two or more path segments wherever it appears — so the guarantee does not depend on how a future message happens to be punctuated.

### S2 — the URL placeholder can capture a literal token from the input (LOW, cosmetic)

`sanitizeText:14-25` swaps each `http(s)` URL for `__CODEX_SAFE_URL_<n>__`, then `replaceAll`s the placeholders back. If an input message already contains that literal token *and* at least one URL, the pre-existing token is replaced by a sanitized URL. The result is confusing output, never a disclosure. A non-substitutable sentinel (e.g. a `\0`-delimited index) would remove the class entirely.

Relatedly, the message slice to `maxLength` happens after substitution, so a restored URL can be cut mid-token. Harmless for stderr.

### S3 — `safeDetail`'s trailing absolute-path check is now largely unreachable (informational)

`safeDetail:42` still tests `ABSOLUTE_PATH` after calling `sanitizeText`, but `sanitizeText`'s `^`-anchored branch already redacts a bare absolute path, so the check almost never fires. It is harmless defense in depth; worth knowing that `sanitizeText`, not this line, is the guard actually doing the work — a future reader trimming "dead" code should keep the right one.

---

## Verification run

| Suite | Claimed | Measured |
|---|---|---|
| `provenance-test` | 13/13 | **13/13 pass** |
| `repo-test` (`check-repository.test.mjs`) | 79/79 | **79/79 pass** |
| study (`skills/study/scripts/tests/*.mjs`) | 100/100 | 100 tests, **95 pass, 5 fail** |
| repository/security (`scripts/tests/*.test.mjs`) | 209/209 | 209 tests, **186 pass, 23 fail** |

All 28 failures are the same single cause as in rounds 1–3: `PROVENANCE_RUNTIME_NONCONFORMANT` on this host (Node 22.16.0 vs pinned 22.23.1, no managed CPython/PyMuPDF). Every failing test reaches `prepare-paper.js`. Test counts match the literals the Repository Guard asserts against `codex-paper.sh` (`209`, `100`, `79`), and the study count moved 99 → 100 exactly as the new formatter test implies.

Also verified directly this round:

- both round-3 leaks reproduced as *fixed* using the same commands that demonstrated them;
- `Details: {}` suppression reproduced on `publication-cli`;
- truncated details parse as JSON and carry `truncated: true`;
- frozen manifest schema hash `514daada…17ce` still matching — four rounds of remediation without unfreezing the schema, which is the point of the freeze;
- all 19 `security/supply-chain-review.json` hashes match the working tree after this round's further `check-repository.mjs` edit; `reviewedAt` `2026-07-30`;
- new guard tokens present: `sanitizeText`, `redacted-path`, `details === '{}'`, `truncated: true`, `PROVENANCE_DRAFT_MISSING`, `maybeFault(options, 'after_authoring_demotion')`, `"study" 100`.

---

## Conditions on this sign-off

Neither is a code defect; both are evidence gaps already acknowledged in the handoff.

1. **Docker sandbox conformance has not run in any environment.** It is the only entry in the acceptance list with no evidence from anywhere, and this phase bumps `sandbox/policy.json`'s `executionReportVersion` to `2.0.0` and adds `generationBinding` to every execution report. Remote CI must produce that evidence before Review completion, as the summary already requires.
2. **The full green suite has never been reproduced on a pinned-runtime host in any of my four rounds.** I have only ever observed the 28 runtime-gated failures. The counts line up with the guard literals in all four rounds, which is good corroboration, but someone should confirm `209 / 100 / 79 / 13` on Node `22.23.1` with the managed CPython/PyMuPDF before merge. This is a limitation of my review environment, not a finding against the work.

And one hygiene item to honour at commit time, as the handoff states: `plugins/codex-paper/src/web/components/PaperAnalysisHero.vue` and the eight unrelated draft docs must not be staged with this phase. The Vue component has now been unreferenced across four phases and should be deleted or wired up in its own change.

## Assessment across the four rounds

The remediation record is unusually disciplined. Every round's findings were either fixed, or deferred with a stated reason and a named phase — and in three cases the chosen fix was better than what I proposed: the golden-fixture reassignment to P1-2 (where a migration must read it, rather than the same code generating it), removing the `--depends-on` CLI pre-check instead of patching it (one authority instead of two), and rebuilding truncated details as a valid object instead of appending a marker. Nothing was quietly dropped, and the one substantive defect I found across four rounds (round 2's N1 publish-ordering bug) was fixed with an ordering change, a fault hook, an invariant test, and a structural guard rather than just the one-line reorder.

The design itself holds up: fail-closed is consistent across every new failure mode, redaction is enforced rather than asserted, the WAL is ordered in the recoverable direction, Manifest/Identity 1.0 readers are isolated with a verified zero-write path, and the frozen schema plus the contract exclusion list mean the two forward-compatibility hazards I raised in round 1 are now enforced by the guard instead of by discipline.

Approved for merge once condition 1 is satisfied and condition 2 is confirmed.
