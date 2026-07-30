# P1-4 Code Review — Round 3 Findings

**Scope:** the round-2 remediation described in `docs/P1-4_CODE_REVIEW_SUMMARY.md` §"Review round 2 disposition", re-reviewed against `docs/P1-4_CODE_REVIEW_FINDINGS_ROUND2.md`.
**Reviewed at:** 2026-07-30, branch `codex/audit-optimizations-2026-07-10`.
**New/changed since round 2:**

- `plugins/codex-paper/src/shared/cli-error-format.mjs` (new)
- `generation-workspace.mjs`: demote-before-adopt ordering, `after_authoring_demotion` fault hook, `AUTHORING_EVENT_ADOPTED`
- `generation-provenance.mjs`: `AUTHORING_EVENT_ADOPTED`/`AUTHORING_EVENT_RECONCILED` split, dependency-failure normalization, `dependenciesWithHashes` details
- `generation-manifest.mjs`: `expectedDiagnostics` re-derivation; `generation-publication.mjs`: `verifyManifestProjection`
- `provenance-cli.js`: `pendingEvents`; all three CLIs: `formatCliError`
- both `SKILL.md` (root-wrapper paths + installed-cache fallback), `check-repository.mjs` (+2 guards), `generation-provenance.test.mjs`, `generation-publication.test.mjs`, `docs/provenance-manifest-2.0.md`

**Verdict:** the round-2 remediation is complete and correct. All ten findings N1–N10 are fixed, and the important one is fixed properly rather than minimally — N1 got the ordering change, a fault-injection hook, a test that asserts both halves of the invariant (state demoted, event still pending), and a Repository Guard check that compares source positions so the ordering cannot silently regress. The two items deferred to later phases are deferred with sound reasoning, and the golden-fixture reassignment to P1-2 is arguably better than what I proposed.

No blocking findings. Eight new items, all low: the largest is **R1**, a demonstrable absolute-path leak through the CLI error *message* — `formatCliError` carefully redacts paths in `details` but leaves `message` untouched, and `readProvenanceDraft` hands it a raw `ENOENT`. That is a three-line fix on the surface round 3 just built.

---

## Round 2 disposition — verified

| # | Finding | Status | Evidence |
|---|---|---|---|
| N1 | Adoption committed before state demotion | **Fixed, well** | `generation-workspace.mjs:476-491` demotes via `transitionWorkspaceToAuthoringLocked` first, then adopts, then records; `authoring.workspace.diagnostics` now reads the post-lock snapshot, closing the TOCTOU note too. Test (`generation-provenance.test.mjs:482-511`) sets the record to `validated`, injects `faultAt: 'after_authoring_demotion'`, and asserts state `authoring` **and** event still `pending`. Guard at `check-repository.mjs:685-690` compares `transitionWorkspaceToAuthoringLocked` / `resolveUnresolvedAuthoringEvent` source positions |
| N2 | `details` never reached the operator | **Fixed (see R1, R2, R4)** | `cli-error-format.mjs` — secret-key redaction, absolute-path redaction, URL credential/query/fragment stripping, depth 6 / 32-item / 64-key / 512-char caps; wired into `publication-cli.js:59`, `provenance-cli.js:182`, `workspace-cli.js:120`; guard requires `formatCliError` in all three plus the module's own tokens |
| N3 | Event ID unobtainable from `inspect` | **Fixed** | `provenance-cli.js:100-107` emits `pendingEvents[{eventId, path, state, intendedSha256}]` — exactly the recommended shape; `SKILL.md:268` and `provenance-manifest-2.0.md:73` point at it; guard requires `pendingEvents` and `intendedSha256` |
| N4 | Remediation commands unresolvable from skill cwd | **Fixed (see R3)** | Both skills now use `../../../../scripts/codex-paper.sh` — verified correct from `skills/study/` and `skills/summary/` — with an explicit installed-plugin-cache fallback and an instruction not to invent a root path. The `prepare` wrapper is now the preferred entrypoint, which also gives `cmd_prepare` the consumer it lacked. Guard at `:764-768` |
| N5 | Recovered/adopted conflated | **Fixed (see R5)** | `manifestDiagnostics:1042-1066` splits `AUTHORING_EVENT_ADOPTED` from `AUTHORING_EVENT_RECONCILED`; the workspace record diagnostic is also `AUTHORING_EVENT_ADOPTED`; test asserts the exact diagnostic set |
| N6 | Raw `ENOENT` during adoption | **Fixed** | `dependenciesWithHashes:626-632` now attaches `details = {path, causeCode}`; `resolveUnresolvedAuthoringEvent:767-785` normalizes to `PROVENANCE_EVENT_UNRESOLVED` naming the missing dependency; test asserts `error.details.missingDependency === 'facts.json'`; docs extended to cover dependencies |
| N7 | `--depends-on` cap off by defaults | **Fixed, cleanly** | The misleading CLI pre-check was removed entirely rather than patched, leaving `dependenciesWithHashes` as the single authority; both docs now say "64 total … after defaults and explicit values are merged and deduplicated" |
| N8 | One-sided projection normalization | **Fixed** | `verifyReadmeProjection:950-958` wraps the `meta.json` read into `PROVENANCE_PROJECTION_INVALID` with the same status mapping as the README branch |
| N9 | `diagnostics` not re-derived | **Fixed** | `generation-manifest.mjs:249-253, 283` re-derives via `manifestDiagnostics({software, source, authoringEvents})` and compares with `stableJson`. I checked the build/validate input asymmetry (draft's full event list vs the manifest's terminal-only list): all three predicates are pending-safe — `AUTHORING_ACTOR_UNDECLARED` filters pending itself, and a pending event can match neither side of the adoption pair (`state` is neither `aborted` nor `completed`) — and a pending event is always last, so indices never shift. The two calls are equivalent |
| N10 | Dead params, duplicate draft read | **Fixed** | `addManifestProjection` is now `verifyManifestProjection(packageDir, manifestId)` with only the parameters it uses; the redundant second `readProvenanceDraft` is gone — `sealWorkspacePackage:176-182` reuses the draft returned by `recoverPendingAuthoringEvents` |
| — | `PUBLICATION_RUNTIME_MISMATCH` coverage | **Added** | `generation-publication.test.mjs:118-135` injects a drifted `host.node`, asserts the code, and additionally asserts the workspace stays `validated` — i.e. a failed publish leaves no state damage. That second assertion is beyond what I asked for |
| — | `resolve-event` CLI coverage | **Added** | `generation-provenance.test.mjs:516-540` drives the real CLI and asserts both `diagnostic: AUTHORING_EVENT_ADOPTED` and the resulting `authoring` state |

Both deferrals are reasonable, and one is an improvement on my suggestion:

- the **golden 2.0 manifest fixture** moves to P1-2, where it becomes a real zero-write migration/reader-compatibility input rather than another self-generated P1-4 fixture. That is a stronger test than the one I proposed, since a fixture the same code generates is weaker evidence than one a migration must read;
- **canonical JSON consolidation** and the **content-producer/verifier module split** move to P1-3b with an explicit behavior-equivalence requirement so the refactor cannot silently shift Generation Contract 2.0 fingerprints. Given that `generation-provenance.mjs` is inside the contract, gating the split on fingerprint equivalence is the right constraint.

---

## New findings

### R1 — `formatCliError` redacts absolute paths in `details` but not in `message`, and a missing provenance draft arrives as a raw `ENOENT` (LOW-MEDIUM)

`cli-error-format.mjs:33` passes the message through untouched apart from newline stripping and truncation:

```js
const message = String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, maxMessage)
```

Meanwhile `safeDetail` maps any absolute-looking string in `details` to `[redacted-path]`. So the redaction applies to the structured half and not the prose half printed immediately above it.

`readProvenanceDraft` compounds this: it calls `readJsonNoFollow`, which rethrows anything carrying a `code`, so a missing draft surfaces as an unwrapped fs error rather than a typed provenance error. Reproduced on a workspace with a valid `workspace.json` and no `provenance-draft.json`:

```
$ PAPERS_DIR=/tmp/leaklib node …/provenance-cli.js inspect ws-aaaa…cccc --json
Error [ENOENT]: ENOENT: no such file or directory, lstat '/private/tmp/leaklib/.codex-paper/workspaces-v1/ws-aaaa…cccc/provenance-draft.json'
```

That is the operator-facing command round 3 just extended, and it prints the full library path. The project treats this as something to avoid: `createWorkspaceDiagnostic` takes a `redactions` list, `generation-publication.test.mjs:157` asserts `stderr.includes(libraryRoot) === false`, and `provenance-manifest-2.0.md:83-86` states that CLI failures are printed "without leaking local absolute paths". That last sentence is scoped to `Details` and so is literally true, but it reads as a property of the CLI output as a whole, which it is not.

A second reproduction, for the message path generally:

```
$ node …/workspace-cli.js write <ws> README.md --from-file /Users/bianyuxin/secret-dir/nope.md --expect-absent
Error [ENOENT]: ENOENT: no such file or directory, lstat '/Users/bianyuxin/secret-dir/nope.md'
```

Impact is modest — these are the user's own paths on the user's own terminal — but the leak is real, the fix is small, and the invariant list says local absolute paths never enter provenance output.

**Fix:** (a) normalize the missing draft to a typed error (`PROVENANCE_DRAFT_MISSING` or `PROVENANCE_DRAFT_INVALID`) in `readProvenanceDraft`, the way `verifyReadmeProjection` now does for README and `meta.json`; (b) run `message` through the same absolute-path redaction as `details` in `formatCliError`.

### R2 — every storage-family error now prints a useless `Details: {}` line (LOW)

`StorageTransactionError` defaults `details = {}` (`storage-transaction.mjs:23`), and `GenerationWorkspaceError` / `GenerationPublicationError` inherit that. `formatCliError` only skips the section when `details` is `undefined` or `null`, so an empty object serializes and prints:

```
$ node …/workspace-cli.js inspect /tmp/nope
Error [WORKSPACE_NOT_FOUND]: Generation workspace was not found.
Details: {}

$ node …/publication-cli.js publish /tmp/nope
Error [WORKSPACE_NOT_FOUND]: Generation workspace was not found.
Details: {}
```

Most errors in these three CLIs are storage-family errors, so the common case gained a noise line while the informative cases gained real content. It slightly devalues the signal that R2's parent fix was meant to add.

**Fix:** skip the section when the serialized value is `{}` or `[]`.

### R3 — SKILL.md now carries two conventions for root commands, and the publish step kept the old one (LOW)

Round 3 corrected Steps 1 and 6 to `../../../../scripts/codex-paper.sh`. Step 11 still reads:

```bash
bash scripts/codex-paper.sh publish-workspace "{prepare-output.workspaceId}" --json
```

The "from the repository root" annotation that justifies the bare form lives at `:582` in the sandbox block, separated from `:592` by three paragraphs and a different topic. So an agent that has just internalized the corrected four-level form meets the old form at the step that actually seals the Manifest 2.0 — the one operation P1-4 exists for.

The new guard (`:764-768`) checks only that the *correct* strings are present; it cannot detect a bare `scripts/codex-paper.sh` elsewhere in the same file. And there is still no check that SKILL.md command paths resolve at all — the recommendation P1-3a finding B1 already made, now relevant for the third time.

**Fix:** make the convention uniform in the file (or annotate the publish block), and consider the resolve-every-quoted-path guard.

### R4 — truncating the serialized `details` can emit invalid JSON (LOW)

`formatCliError` ends with `details.slice(0, maxDetails)`, which cuts the JSON string mid-token. Fine for a human reading stderr; it breaks any wrapper that tries to parse the `Details:` payload, and the payload is otherwise well-formed JSON, which invites parsing.

**Fix:** truncate the structure before serializing, or append an explicit `…[truncated]` marker outside the JSON.

### R5 — the adopted/reconciled distinction is inferred from an event-pair pattern because the manifest schema is frozen (LOW, worth recording)

`manifestDiagnostics:1042-1054` identifies adoption by matching adjacent events on seven conditions (`previous.recovered && previous.state === 'aborted'`, `current.recovered && current.state === 'completed'`, `current.actor === 'unknown'`, same `path`, same `beforeSha256`, same `completedAt`) rather than reading an explicit flag. That is because an explicit marker would need a new key in `authoringEvent`, and both `validateProvenanceDraft`'s `hasOnlyKeys` allowlist and the now byte-frozen `generation-manifest-2.0.schema.json` forbid it.

I verified the inference is sound: an unresolvable pending event is always the last element (no subsequent write can succeed, because every write path calls `recoverPendingAuthoringEvents` first), so adoption always produces an adjacent pair; and a pending event can match neither side of the pattern. A hypothetical false positive would mislabel reconciliation as adoption, which is the conservative direction.

The finding is that nothing in the code or docs records *why* the encoding is indirect, so a future reader is likely to "simplify" it into a flag and quietly break the schema freeze — and it is a concrete example of what the M1 freeze costs. Add a comment naming the constraint.

### R6 — fault-injection style diverges from the established helper (LOW)

`resolveWorkspaceAuthoringEvent:477-479` inlines `if (options.faultAt === 'after_authoring_demotion') throw …`, while `generation-publication.mjs` uses a `maybeFault(options, name)` helper for the same purpose. Not reachable from any CLI (`workspace-cli.js` passes only `{lockTimeoutMs}`), so this is consistency only.

### R7 — one disposition claim does not match the round-2 tree (informational)

The summary states that N10's dead parameters and duplicate draft read "had already been removed before the round-2 review snapshot." At round 2 I read `addManifestProjection(packageDir, id, lockHandle, workspace.workspaceLockKey)` with two unused parameters and a second `readProvenanceDraft(workspace)` immediately after `recoverPendingAuthoringEvents`. Both are gone now. The code is correct either way; this only matters because the summary is the durable record of what changed when.

### R8 — unchanged carry-overs (informational)

- `plugins/codex-paper/src/web/components/PaperAnalysisHero.vue` and eight unrelated draft docs remain untracked. Keeping them out of P1-4 is right; the Vue component has now been unreferenced through three phases and should be deleted or wired up in its own change.
- Docker remains unavailable locally, so the digest-pinned sandbox conformance gate is still unexecuted in any environment. It is the only entry in the acceptance list with no evidence from anywhere, and `sandbox/policy.json`'s `executionReportVersion: 2.0.0` bump is part of this phase.

---

## Test coverage status

Closed in round 3: `resolveWorkspaceAuthoringEvent` including the crash-after-demotion invariant, the `resolve-event` CLI end-to-end, `PUBLICATION_RUNTIME_MISMATCH` plus post-failure state preservation, adoption with a missing dependency, and the exact adopted-vs-reconciled diagnostic set.

Still uncovered (all low-value relative to what is now tested):

1. `PROVENANCE_EVENT_LIMIT_EXCEEDED` and `PROVENANCE_DEPENDENCY_LIMIT_EXCEEDED`.
2. `PROVENANCE_EXECUTION_INVALID` at seal time — malformed or wrong-phase reports. The published-overlay symlink case is covered.
3. The `meta.json` half of `verifyReadmeProjection` (the README half is covered).
4. `postSealEvents` happy path (invariant 5) and `compatible_1_0` end-to-end.
5. `PROVENANCE_ACTOR_INVALID`.
6. `formatCliError` itself — no unit test, despite being the module that decides what leaves the process on stderr. A handful of cases (secret key, absolute path, URL with credentials, depth cap, circular reference) would be cheap and would have caught R2.

Note that round 3's new assertions all landed inside existing `test()` blocks, so `run_counted_test_suite`'s counts (209 / 99 / 79) are unchanged even though coverage grew. That is fine, but the count guard cannot see this kind of growth — worth knowing when reading the acceptance numbers.

## Verification run

| Suite | Claimed | Measured |
|---|---|---|
| `provenance-test` | 12/12 | **12/12 pass** |
| `repo-test` (`check-repository.test.mjs`) | 79/79 | **79/79 pass** |
| study (`skills/study/scripts/tests/*.mjs`) | 99/99 | 99 tests, **94 pass, 5 fail** |
| repository/security (`scripts/tests/*.test.mjs`) | 209/209 | 209 tests, **186 pass, 23 fail** |

All 28 failures are again the single `PROVENANCE_RUNTIME_NONCONFORMANT` cause on this host (Node 22.16.0 vs pinned 22.23.1, no managed CPython/PyMuPDF); every failing test reaches `prepare-paper.js`. Counts match the literals the guard asserts against `codex-paper.sh`, so the claimed full-green is plausible on the pinned runtime but was **not reproduced here** in any of the three rounds.

Also verified directly this round:

- frozen manifest schema hash `514daada…17ce` unchanged and matching, so the round-2 and round-3 diagnostic work was done without unfreezing the schema;
- all 19 `security/supply-chain-review.json` hashes match the working tree after the further `check-repository.mjs` edit, `reviewedAt` still `2026-07-30`;
- `../../../../scripts/codex-paper.sh` resolves to the repository root from both `skills/study/` and `skills/summary/`, and is absent from the installed plugin cache (whose `scripts/` ships only `runtime-python.sh` and `start-webui.sh`) — matching the fallback the skills now document;
- `formatCliError` is imported and used in all three CLIs; `safeDetail` leaves relative paths, hashes, `sha256:` strings and version numbers intact, so the stale-dependency and runtime payloads survive redaction;
- R1 and R2 reproduced directly as shown above.

---

## Recommended order of work

1. **R1** — normalize the missing-draft error and redact absolute paths in `message`. The only finding with a demonstrated leak, and both halves are small.
2. **R2** — suppress `Details: {}`.
3. **R3** — one convention for root commands in SKILL.md.
4. **R5** — a comment recording why the adopted/reconciled encoding is pattern-based.
5. Coverage item 6 — unit-test `formatCliError`; it is now the last thing between an internal error and the operator's terminal.
6. **R4, R6** — polish.
7. **R8** — delete or wire up `PaperAnalysisHero.vue`; obtain the remote-CI Docker conformance evidence before Review completion, as the summary already requires.
