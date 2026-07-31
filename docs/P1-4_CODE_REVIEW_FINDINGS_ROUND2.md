# P1-4 Code Review — Round 2 Findings

**Scope:** the round-1 remediation described in `docs/P1-4_CODE_REVIEW_SUMMARY.md` §"Review round 1 disposition", re-reviewed against `docs/P1-4_CODE_REVIEW_FINDINGS.md`.
**Reviewed at:** 2026-07-30, branch `codex/audit-optimizations-2026-07-10`.
**New/changed since round 1:**

- `plugins/codex-paper/src/shared/validation-report-intrinsic.mjs`, `docs/paper-identity-2.0.md` (new)
- `generation-provenance.mjs`: `collectRepositoryProvenance`, `resolveUnresolvedAuthoringEvent`, `MAX_AUTHORING_DEPENDENCIES`, error `details`, two new diagnostics
- `generation-workspace.mjs`: `resolveWorkspaceAuthoringEvent`, `provenance.software` requirement
- `workspace-cli.js`: `resolve-event`; `codex-paper.sh`: `provenance-resolve`, `prepare`
- `check-repository.mjs`: frozen manifest-schema hash, contract exclusion list, lock-ordering guard
- `validation-report.js`, `prepare-paper.js`, both `SKILL.md`, `generation-contract-2.0.json`, `security/supply-chain-review.json`

**Verdict:** the remediation is real and mostly well-executed. Both round-1 blockers and all seven mediums are addressed, several structurally rather than by documentation — the contract exclusion list, the frozen schema hash, and the lock-ordering check are now enforced by the Repository Guard, so they cannot silently regress. Test count went 8 → 12 provenance tests and the four highest-value coverage gaps are closed, including a real `createValidationReport` → seal → `verifyGenerationManifest` round trip.

One new defect should be fixed before merge: **N1**, an ordering bug in the new `provenance-resolve` path that can leave adopted out-of-band bytes in a still-`validated` workspace, publishable under a stale validation report. It is a two-line fix and it deviates from the demote-first order that `writeWorkspaceAuthoring` uses twenty lines away in the same file. The remaining eight findings are polish, but **N2/N3/N4** together mean the new B1/B2 remedies are harder to actually use than the summary implies.

---

## Round 1 disposition — verified

| # | Finding | Status | Evidence |
|---|---|---|---|
| B1 | Stale-dependency trap | **Fixed (see N2)** | `generation-provenance.mjs:840-867` collects `(path, dependency, expectedSha256, actualSha256)` tuples into `error.details`; message names the downstream artifact; `SKILL.md:213-219` documents reasoning-first order + regeneration remedy + the error code; guard at `check-repository.mjs:747` enforces the doc |
| B2 | Unresolvable WAL event bricks workspace | **Fixed (see N1, N3, N6)** | `resolveUnresolvedAuthoringEvent` (`:726-778`) + `resolveWorkspaceAuthoringEvent` (`generation-workspace.mjs:467-496`) + `workspace-cli resolve-event` + `codex-paper.sh provenance-resolve`; error message names the event ID and both remedies; scope is tight — only a `pending` event qualifies, and a resolvable one is delegated back to `recoverPendingAuthoringEvents` rather than laundered |
| M1 | Schema `const` pins break published manifests | **Fixed, process-level** | `FROZEN_GENERATION_MANIFEST_V2_SHA256 = 514daada…` verified against the file; guard at `:686`. Editing the 2.0 schema now fails `repo-check`, forcing a new versioned schema + reader. See residual note below |
| M2 | Duplicated validation intrinsic hash | **Fixed** | `validation-report-intrinsic.mjs` is the single authority; consumed by `createValidationReport`, `validateValidationReportForPublication`, and `generation-manifest.mjs`. Test asserts `report.reportHash.value === validationReportIntrinsicHash(report)` on a real report and drives it through `verifyGenerationManifest` |
| M3 | Git provenance not verified as codex-paper | **Fixed** | `collectRepositoryProvenance` (`:334-352`) requires `realpathSync(--show-toplevel) === realpathSync(repoRoot)`; test creates a real repo and asserts a nested subdirectory yields `unavailable` |
| M4 | Runtime gate opaque, no wrapper | **Fixed (see N4)** | `assertContentRuntime` (`:244-273`) enumerates `failedChecks` and puts them plus both remediation commands in the *message*, so it survives CLIs that drop `details`; `cmd_prepare` added; both `SKILL.md` files document the remedy |
| M5 | Observations inside the lock | **Fixed** | `prepare-paper.js:622` calls `collectSoftwareProvenance` before `createGenerationWorkspace`; `provenance.software` is now required (`generation-workspace.mjs:337`); guard compares source indices at `check-repository.mjs:~640` |
| M6 | Contract fingerprints verifier code | **Fixed** | `generation-contract-2.0.json` no longer lists `src/shared/generation-manifest.mjs` or the manifest schema, and both are in the guard's `forbidden` list. See residual note |
| M7 | Fabricated `openai` provider | **Fixed** | Both skills and README now pass `--authoring-provider unavailable --authoring-model unavailable`; the guard requires that exact string; `docs/paper-identity-2.0.md` states "fabricated provider defaults are forbidden" |
| L1 | Silent `unknown` actor | **Fixed** | `AUTHORING_ACTOR_UNDECLARED` in `manifestDiagnostics` (`:1001`), guard-enforced |
| L2 | `--depends-on` undocumented/unbounded | **Fixed (see N7)** | `MAX_AUTHORING_DEPENDENCIES = 64`, CLI cap, `--actor` now reports the allowed set, documented in `SKILL.md` and `provenance-manifest-2.0.md` |
| L3 | README bytes rewritten server-side | **Fixed** | `SKILL.md:239-243` and `provenance-manifest-2.0.md` both state the returned SHA-256 must be used for the next CAS write |
| L4 | Raw ENOENT for missing README | **Fixed (see N8)** | `verifyReadmeProjection` (`:906-915`) normalizes to `PROVENANCE_PROJECTION_INVALID`; test added |
| L5 | Dead code / bound mismatches | **Fixed** | `postSealEvents` dead throw removed and the dotfile guard added (`provenance-cli.js:41-51`); identity schema path is now an explicit map with a fail-closed default (`:358-367`); schema bounds now agree with the JS validators — diagnostic `{2,79}`, canonical doi/arxiv 255, `execution.outcome` enum. Residual: `addManifestProjection`'s unused params, the double draft read in `sealWorkspacePackage`, and duplicated `stableJson` remain (N10) |
| L7 | Stale supply-chain review date | **Fixed** | `reviewedAt` advanced to `2026-07-30`; all 19 artifact hashes verified against the working tree |
| L9 | No Identity 2.0 document | **Fixed** | `docs/paper-identity-2.0.md` added, including the fingerprint boundary and the declaration-not-observation framing |
| L6 | Per-write provenance cost | **Deferred, accepted** | Deferring rather than weakening durability without profiling is the right call; tracked under P1-3b |
| L8 | Pre-seal `meta.json` projection | **Retained, accepted** | The stated reason holds — an unsealed generation cannot reach `current.json` or the index through the publication path |
| L10 | Unrelated untracked files | **Acknowledged, not staged** | `PaperAnalysisHero.vue` and eight draft docs remain untracked and explicitly excluded. This is now the third phase they have carried through; they are still unreferenced |

Two design decisions I raised are answered rather than "fixed", and both answers are defensible: `software.repository` is kept even though it is `unavailable` in the installed layout (the exactness check is what makes the field trustworthy when it *is* observable), and the authoring engine stays inside the fingerprint with `unavailable` as a stable sentinel.

---

## New findings

### N1 — `provenance-resolve` commits the WAL adoption before demoting the workspace, so a crash between them can publish adopted bytes under a stale validation report (MEDIUM)

`generation-workspace.mjs:476-479`:

```js
return withStorageLocks([current.paperLockKey, current.generationLockKey, current.workspaceLockKey], async (lockHandle) => {
    const draft = resolveUnresolvedAuthoringEvent(current, eventId, lockHandle)   // 1. durable WAL mutation
    const refreshed = updateWorkspaceRecordLocked(current, {
      state: 'authoring',                                                          // 2. state demotion
```

Compare `writeWorkspaceAuthoring` twenty lines above, which gets the order right:

```js
let refreshed = transitionWorkspaceToAuthoringLocked(current, lockHandle, options)   // demote FIRST
const result = writeAuthoringWithProvenance({ ... })                                 // then mutate
```

Adoption is meant to force re-validation, and it does on the success path — `publishGenerationWorkspace` requires `initial.workspace.state === 'validated'` (`generation-publication.mjs:535`), and `validated → authoring` is an allowed transition. But the two writes are not atomic and are in the wrong order.

**Failure:** a workspace in state `validated` has an ambiguous pending event on `summary.md`. The operator runs `provenance-resolve --adopt-current <event-id>`. `resolveUnresolvedAuthoringEvent` writes the draft: the interrupted event becomes `aborted`, and a `completed` `unknown`-actor event records the out-of-band bytes with freshly re-hashed dependencies. The process is then killed (or `updateWorkspaceRecordLocked` throws — it re-resolves the record and applies a CAS precondition on `workspace.json`). State stays `validated`.

Now nothing blocks publication:

- `recoverPendingAuthoringEvents` finds no pending events — the adoption already resolved it;
- `buildArtifactGraph` finds no staleness — the adopted event's `afterSha256` equals the current file and its dependencies were re-hashed to current;
- `validateValidationReportForPublication` only checks the report's *intrinsic* self-consistency, not that it describes the current package bytes;
- the state gate passes because the demotion never happened.

So the generation seals with a `complete`/`publishable` validation report computed from the pre-adoption bytes. The manifest is internally consistent and carries `AUTHORING_EVENT_RECOVERED`, but the validation attestation is about content that is no longer there.

The crash window is exactly the failure mode this WAL exists to survive, and `resolveWorkspaceAuthoringEvent` is the only new code path with **no test at all** — the suite exercises the pure `resolveUnresolvedAuthoringEvent` engine function directly under a raw lock, bypassing the wrapper entirely.

**Fix:** demote first. `transitionWorkspaceToAuthoringLocked(current, lockHandle, options)` is idempotent, so if the draft mutation then fails the workspace is merely back in `authoring` — harmless and re-runnable. Add a test for the wrapper (state before/after, and the demotion surviving a thrown draft write).

### N2 — the new `details` payloads never reach an operator (LOW-MEDIUM)

`buildArtifactGraph` attaches the stale tuples to `error.details`, but no CLI prints them. All three catch blocks are message-only:

```js
// publication-cli.js, workspace-cli.js, provenance-cli.js
console.error(`Error [${code}]: ${String(error?.message || error)…}`)
```

So the summary's claim that stale-dependency failures "identify the downstream artifact, dependency, expected hash and actual hash" is true at the API boundary and false at the operator boundary. What an operator actually sees is:

```
Error [PROVENANCE_DEPENDENCY_STALE]: Artifact dependency graph is stale for summary.md; regenerate the downstream artifact after finalizing its dependencies.
```

— the downstream artifact, but not which of `reasoning-analysis.json` / `evidence-ledger.json` / `facts.json` drifted. Practical impact is limited because `SKILL.md`'s remedy is "regenerate everything downstream" anyway, and `assertContentRuntime` deliberately put its own diagnostics in the *message* precisely so they survive this. But that asymmetry is the tell: one fix routed around the gap, the other did not.

**Fix:** print bounded `error.details` on stderr in the three CLIs, or fold the first few tuples into the message the way `assertContentRuntime` does.

### N3 — the event ID that `provenance-resolve` requires cannot be obtained from `provenance-inspect` (LOW-MEDIUM)

`provenance-resolve <workspace> --adopt-current <event-id>` needs an exact `ae-…` ID. The natural diagnostic command reports only counts (`provenance-cli.js:97-98`):

```js
authoringEventCount: draft.authoringEvents.length,
pendingEventCount: draft.authoringEvents.filter((event) => event.state === 'pending').length,
```

`inspect` correctly does *not* call `recoverPendingAuthoringEvents`, so it stays usable while the workspace is blocked — good design. But it tells the operator "1 pending event" and nothing more. The ID is only obtainable by triggering another failing `workspace-write` or `publish-workspace` and reading `PROVENANCE_EVENT_UNRESOLVED`'s message.

**Fix:** include `{eventId, path, state, intendedSha256}` for pending events in the `workspace_draft` output.

### N4 — the new remediation commands do not resolve from the working directory the skills document (LOW-MEDIUM)

`SKILL.md:107-108` (Step 1) and `:250` (Step 6) add:

```
bash scripts/codex-paper.sh runtime-status
bash scripts/codex-paper.sh runtime-setup
bash scripts/codex-paper.sh provenance-resolve <workspace> --adopt-current <event-id>
```

Step 1 states "Run the preparation entrypoint from the study skill directory" and Step 6 uses `node ./scripts/workspace-cli.js`, so the working directory is `plugins/codex-paper/skills/study/`. From there `scripts/codex-paper.sh` does not exist — verified; the root script is four levels up at `../../../../scripts/codex-paper.sh`. The file's own convention agrees: `:562` explicitly says "from the repository root" for the sandbox block, and `:466` correctly uses `../../scripts/runtime-python.sh`.

This is the same class as P1-3a finding B1, which this project already fixed once, and `check-repository.mjs` still has no guard that SKILL.md command paths resolve. It bites at the worst moment: the commands only matter when the agent is already blocked by a nonconformant runtime or an unresolved WAL event.

Also worth noting: in the installed plugin layout `<plugin>/scripts/` ships only `runtime-python.sh` and `start-webui.sh` (verified against the `2.0.0+codex.20260730113820` install), so root-script remediation is unreachable there regardless of relative path. And the new `cmd_prepare` wrapper — the structural half of the M4 fix — has no consumer: no skill or doc invokes `codex-paper.sh prepare`.

**Fix:** use `../../../../scripts/codex-paper.sh` in the two skill-dir-scoped steps (or state the cwd change), and consider the Repository Guard check for SKILL.md command paths that P1-3a B1 already recommended.

### N5 — `AUTHORING_EVENT_RECOVERED` conflates automatic reconciliation with human adoption of out-of-band bytes (LOW)

`manifestDiagnostics:1007` emits one code for any `recovered === true` event, and the message says "reconciled or explicitly adopted". Those are very different provenance claims:

- an interrupted write whose target hash matched the recorded intent — fully unambiguous, provenance intact;
- a human adopting bytes that the writer never produced — provenance unverified by construction.

A consumer *can* distinguish them: adoption produces an `aborted` event immediately followed by a `completed` `unknown`-actor event on the same path with the same `beforeSha256`. But `AUTHORING_ACTOR_UNDECLARED` also fires for a plain forgotten `--actor`, so the diagnostics alone don't separate the cases, and the manifest is the artifact a consumer is supposed to be able to trust without reconstructing event pairs.

**Fix:** distinct codes — `AUTHORING_EVENT_RECONCILED` vs `AUTHORING_EVENT_ADOPTED`.

### N6 — `--adopt-current` can itself fail with a raw `ENOENT` when a recorded dependency is missing (LOW)

`resolveUnresolvedAuthoringEvent:759` re-hashes the recorded dependency paths:

```js
const dependencies = dependenciesWithHashes(workspace.packageDir, event.dependencies.map((item) => item.path))
```

If any dependency was deleted out-of-band, `readFileNoFollowBounded` throws an unwrapped `ENOENT` and adoption fails. The docs handle only the missing-*artifact* case ("If the current artifact is missing, the only safe remedy is to abandon the workspace and prepare again"), which is the same trigger class — whatever edited the artifact out-of-band could equally have removed a dependency.

**Fix:** wrap it in a `PROVENANCE_EVENT_UNRESOLVED` naming the missing dependency, and extend the doc sentence to cover dependencies.

### N7 — the `--depends-on` cap is off by the default dependencies (LOW)

`workspace-cli.js` accepts up to 64 `--depends-on` values, but `dependenciesWithHashes` applies `MAX_AUTHORING_DEPENDENCIES = 64` *after* merging the 3–4 defaults. Exactly 64 explicit dependencies on a Markdown artifact passes the CLI check and then fails downstream with `PROVENANCE_DEPENDENCY_LIMIT_EXCEEDED` (413).

**Fix:** document the limit as "total, including defaults", and either drop the CLI pre-check or lower it.

### N8 — projection error normalization is one-sided (LOW)

`verifyReadmeProjection` now wraps README read failures into `PROVENANCE_PROJECTION_INVALID`, but the `meta.json` read two lines later goes through `readJsonNoFollow`, which rethrows any error carrying a `code` — so a missing `meta.json` still surfaces as a raw `ENOENT` from the same function that was just normalized.

### N9 — `validateGenerationManifest` re-derives `authoring.status` but not `diagnostics` (LOW)

The validator recomputes `expectedAuthoringStatus` from the events and rejects a mismatch, but only checks that `diagnostics` codes are unique and sorted — it never re-derives them. A manifest with `unknown` actors and no `AUTHORING_ACTOR_UNDECLARED` validates. Tampering is still caught by `manifestHash` plus the `current.json` binding, so this is internal asymmetry rather than a hole; recomputing it would be one line and would make the diagnostic list as trustworthy as the status.

### N10 — residual duplication and dead parameters (LOW)

- `stableValue`/`stableJson` now exist in a **fifth** module (`validation-report-intrinsic.mjs`, alongside `storage-transaction`, `generation-manifest`, `generation-provenance`, `validation-report`).
- `addManifestProjection(packageDir, id, lockHandle, workspace.workspaceLockKey)` still takes two parameters it no longer uses (`generation-publication.mjs:158-164`).
- `sealWorkspacePackage` still calls `recoverPendingAuthoringEvents` (which returns the draft) and then `readProvenanceDraft(workspace)` again for the same file.
- Three names for one operation: engine `resolveUnresolvedAuthoringEvent`, CLI `workspace-cli resolve-event`, user-facing `provenance-resolve --adopt-current`. The docs are consistent on the last one, so this is cosmetic.

---

## Residual notes on round-1 fixes

**M1 is now a process control, not a structural one.** The frozen hash stops accidental edits, but a deliberate change can update the schema and the constant in the same commit — nothing then detects that manifests already on disk no longer validate. The pins that motivated the finding (`packageVersion: const "2.1.0"` and six siblings) are unchanged. Consider checking in a golden sealed 2.0 manifest fixture and validating it in `provenance-test`; that turns "don't edit this file" into "you cannot break existing readers without a test failing", which is what the invariant actually claims.

**M6 is mostly fixed.** Excluding `generation-manifest.mjs` and the manifest schema removes the bulk of the verifier surface from the fingerprint, and the guard's `forbidden` list makes it stick. But `generation-provenance.mjs` remains in `common` and still holds verification-only logic — `collectExecutionReports`, `verifyReadmeProjection`, the validation half of `buildArtifactGraph`, `resolveUnresolvedAuthoringEvent`. A fix to any of those still re-fingerprints every new generation. The file genuinely also holds content-producing code (`writeAuthoringWithProvenance`, `defaultDependencies`, `applyReadmeProjection`), so including it is defensible; splitting it would complete the intent that `docs/paper-identity-2.0.md` now states as a guarantee: "verification-only readers are deliberately excluded, so a verifier bug fix does not force content regeneration."

---

## Remaining test coverage gaps

Closed since round 1: WAL recovery (all three branches), `assertContentRuntime` details, repository toplevel exactness, README projection missing, validation-report drift → `GENERATION_MANIFEST_DIRTY`, execution-report cross-generation drift → `GENERATION_MANIFEST_DIRTY`, real validation-report round trip, stale-dependency `details`.

Still untested:

1. **`resolveWorkspaceAuthoringEvent`** — the wrapper containing N1. Only the engine function is tested, under a hand-held lock, which is precisely why the ordering bug survived.
2. **The `resolve-event` / `provenance-resolve` CLI surface** — no end-to-end test; nothing verifies the workspace ends up in `authoring` or that the workspace diagnostic is persisted.
3. `PUBLICATION_RUNTIME_MISMATCH` — invariant 1's publish-side half.
4. `PROVENANCE_EVENT_LIMIT_EXCEEDED` and `PROVENANCE_DEPENDENCY_LIMIT_EXCEEDED`.
5. `PROVENANCE_EXECUTION_INVALID` at seal time (malformed / wrong-phase reports). Only the published-overlay symlink case is covered.
6. The `meta.json` half of the projection check.
7. `postSealEvents` happy path (invariant 5) and `compatible_1_0` end-to-end.
8. `PROVENANCE_ACTOR_INVALID`.

## Verification run

| Suite | Claimed | Measured |
|---|---|---|
| `provenance-test` | 12/12 | **12/12 pass** |
| `repo-test` (`check-repository.test.mjs`) | 79/79 | **79/79 pass** |
| study (`skills/study/scripts/tests/*.mjs`) | 99/99 | 99 tests, **94 pass, 5 fail** |
| repository/security (`scripts/tests/*.test.mjs`) | 209/209 | 209 tests, **186 pass, 23 fail** |

All 28 failures are the same single cause as in round 1 — `PROVENANCE_RUNTIME_NONCONFORMANT` on this host (Node 22.16.0 vs pinned 22.23.1, no managed CPython/PyMuPDF) — and every failing test reaches `prepare-paper.js`. The counts match the literals the Repository Guard now asserts against `codex-paper.sh` (`209`, `99`, `79`), so the claimed full-green results are plausible on the pinned runtime but were again **not reproduced here**.

Also verified directly:

- frozen manifest schema hash `514daada9b02a53424835bbac43f36cccbaeb6a9d58bdf685dd471ff43be17ce` matches the file;
- all 19 `security/supply-chain-review.json` hashes match the working tree, `reviewedAt` now `2026-07-30`;
- `generation-contract-2.0.json` `common` no longer contains `src/shared/generation-manifest.mjs` or the manifest schema, and the guard forbids both;
- schema/JS bound agreement: diagnostic `^[A-Z][A-Z0-9_]{2,79}$`, `execution.outcome` enum `pass|fail`, canonical `doi`/`arxiv` maxLength 255;
- `validated → authoring` is a permitted transition, and the `{code, message}` workspace diagnostic satisfies `generation-workspace-1.0.schema.json` (`^[A-Z0-9_]+$`, `additionalProperties: false`);
- `provenance-resolve` routes to `cmd_workspace resolve-event`; `prepare` routes to `cmd_prepare` with `ensure_node`/`ensure_python`/`ensure_pymupdf`;
- `scripts/codex-paper.sh` is absent from `plugins/codex-paper/skills/study/` and from the installed plugin's `scripts/` (N4).

Docker remains unavailable locally, so the digest-pinned sandbox conformance gate is still unexecuted anywhere. That is now the only claim in the acceptance list with no evidence from any environment.

---

## Recommended order of work

1. **N1** — demote the workspace before mutating the WAL, and add a test for `resolveWorkspaceAuthoringEvent`. This is the only finding I would block merge on.
2. **N3, N2** — make the B2 remedy self-service (pending event IDs in `inspect`) and the B1 diagnosis actionable (print `details`). Together these are what turn two documented remedies into usable ones.
3. **N4** — fix the two relative paths; they fail exactly when needed.
4. **N5** — split the recovered/adopted diagnostic codes before any consumer starts trusting the single code.
5. Test gaps 1–3 — the resolve wrapper, its CLI, and `PUBLICATION_RUNTIME_MISMATCH`.
6. **M1 residual** — check in a golden 2.0 manifest fixture so the freeze is enforced by a test rather than by a constant.
7. **N6–N10** — polish.
8. **L10** — still unstaged, still correct to keep out; `PaperAnalysisHero.vue` has now been carried unreferenced through three phases and should be deleted or wired up in its own change.
