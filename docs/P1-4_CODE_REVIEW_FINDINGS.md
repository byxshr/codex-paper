# P1-4 Code Review — Findings

**Scope:** the uncommitted P1-4 unified provenance / Generation Manifest 2.0 work, as described in `docs/P1-4_CODE_REVIEW_SUMMARY.md` and `docs/P1-4_IMPLEMENTATION_PLAN.md`.
**Reviewed at:** 2026-07-30, branch `codex/audit-optimizations-2026-07-10`.
**Primary files:**

- `plugins/codex-paper/src/shared/generation-provenance.mjs` (new, 858 lines)
- `plugins/codex-paper/skills/study/scripts/provenance-cli.js` (new)
- `plugins/codex-paper/skills/study/schemas/generation-manifest-2.0.schema.json`, `paper-identity-2.0.schema.json`, `skills/study/generation-contract-2.0.json` (new)
- `plugins/codex-paper/runtime/runtime-baseline.json` (moved from `security/`)
- `plugins/codex-paper/src/shared/generation-manifest.mjs`, `generation-publication.mjs`, `generation-workspace.mjs`, `workspace-writer.mjs` (changed)
- `plugins/codex-paper/skills/study/scripts/prepare-paper.js`, `paper-identity.js`, `workspace-cli.js`, `sandbox-code.js` (changed)
- `scripts/check-repository.mjs`, `scripts/codex-paper.sh`, `scripts/common.sh`, `scripts/runtime-policy.mjs`, `.github/workflows/ci.yml` (changed)
- `docs/provenance-manifest-2.0.md`, `docs/adr/0006-generation-manifest-2-provenance-authority.md` (new)

**Verdict:** the architecture is sound and the fail-closed posture is real and consistent — every new failure mode throws a distinct code with a sane status, redaction is genuinely enforced rather than asserted, the WAL is ordered in the recoverable direction, and 1.0 readers are cleanly isolated with a verified zero-write path. The seven security/correctness invariants in the summary hold as written.

Two defects should be fixed before this becomes a long-lived on-disk format, because both silently break *already-published* manifests at some future point (M1, M2). Three more are workflow-blocking ergonomics that will surface on the first real authoring loop (B1, B2, M4). The Docker sandbox conformance gate remains unexecuted anywhere, as the summary states.

---

## Blocking

### B1 — A normal reasoning fix-loop permanently blocks publication, with no remedy in the error or the docs (HIGH)

`generation-provenance.mjs:537-557` makes every visible artifact depend on the reasoning artifact:

```js
} else if (relativePath.startsWith('code/') || relativePath.endsWith('.md') || relativePath === 'index.html') {
    candidates = [
      fs.existsSync(path.join(packageDir, 'reasoning-analysis.json'))
        ? 'reasoning-analysis.json'
        : 'analysis.json',
      'evidence-ledger.json',
      'facts.json',
    ]
```

`generation-provenance.mjs:725-731` then rejects the seal if any completed event's recorded dependency hash differs from the current file:

```js
if (filesByPath.get(event.path).sha256 !== event.afterSha256
  || event.dependencies.some((dependency) => filesByPath.get(dependency.path).sha256 !== dependency.sha256)) {
  const error = new Error('Artifact dependency graph contains a stale authoring dependency.')
  error.code = 'PROVENANCE_DEPENDENCY_STALE'
```

`reasoning-analysis.json` is itself a writable authoring artifact (`AUTHORING_ROOT_FILES`, and `WRITE_POLICIES.reasoning_scaffold`). So the sequence *write package → revise reasoning* — an ordinary correction after reading the rendered output — leaves every `.md`, `index.html`, and `code/*` event stale and blocks `publish-workspace` with a 409.

**Failure:** author writes `README.md`, `summary.md`, `insights.md`, `method.md`, `reflection.md`, `qa.md`, then fixes one claim in `reasoning-analysis.json`. Publication now fails with `Artifact dependency graph contains a stale authoring dependency.` The message names neither the stale artifact nor the dependency, so there is no way to know that the remedy is "rewrite all six visible files." Nothing in `SKILL.md` or `docs/provenance-manifest-2.0.md` states the ordering constraint; §"Authoring WAL" says only *"Visible study artifacts depend on the current reasoning artifact plus the evidence layer."*

**Fix:** put the offending `(path, dependency, expected, actual)` tuples in the error `details`, document the constraint and the regenerate-downstream remedy in `docs/provenance-manifest-2.0.md`, and state the required write order explicitly in `SKILL.md` Step 4/Step 6. Consider whether a stale upstream should instead be a recorded diagnostic on the manifest rather than a hard block, since the artifact bytes and their hashes are all still faithfully recorded either way.

### B2 — `PROVENANCE_EVENT_UNRESOLVED` bricks a workspace with no repair path (HIGH)

`generation-provenance.mjs:639-663`:

```js
if (current === event.afterSha256) return { ...event, state: 'completed', ... }
if (current === event.beforeSha256 || (current === null && event.beforeSha256 === null)) {
  return { ...event, state: 'aborted', ... }
}
const error = new Error('Pending authoring event cannot be reconciled with the current artifact hash.')
error.code = 'PROVENANCE_EVENT_UNRESOLVED'
```

`recoverPendingAuthoringEvents` is the first thing both `writeAuthoringWithProvenance` and `sealWorkspacePackage` call. Once a pending event's target hash matches neither `beforeSha256` nor `afterSha256`, *every* subsequent authoring write and *every* publication attempt fail forever. There is no CLI to inspect-and-resolve an event; `provenance-cli.js` exposes only `inspect` and `verify`. The only exit is `workspace-abandon`, which discards all authored content.

Likelihood is low — locks plus atomic rename make the third state hard to reach — but the blast radius is a total loss of a completed study package, and the reachable trigger (any out-of-band edit to a package file, which the design forbids but does not prevent) is exactly the situation a human debugging a workspace would create.

**Fix:** add an explicit, audited resolution path — e.g. `provenance-resolve <workspace> --abort <eventId>` that writes an `aborted` event plus a permanent manifest diagnostic — or, at minimum, name abandon-and-reprepare as the accepted outcome in the error message and the docs so the operator is not left guessing.

---

## Medium

### M1 — The 2.0 schema `const`-pins mutable version fields, so a future bump makes already-published manifests unreadable

`generation-manifest-2.0.schema.json:140-144, 156, 186-187, 243, 409` pin, with `additionalProperties: false`:

```json
"packageVersion": { "const": "2.1.0" },
"pluginBaseVersion": { "const": "2.0.0" },
"evidenceSchemaVersion": { "const": "2.0.0" },
"factsSchemaVersion": { "const": "2.1.0" },
"reasoningSchemaVersion": { "const": "2.0.0" },
```

`validateGenerationManifest` (`generation-manifest.mjs:196-206`) runs the *current* schema against every stored manifest, and `verifyGenerationManifest` calls it during authoritative resolution. The next time `packageVersion` becomes `2.2.0` (or the facts/evidence/reasoning schema versions move), the schema must be edited to match — and at that moment every generation already published under 2.0 starts failing `GENERATION_MANIFEST_INVALID`, so it can neither resolve nor stay current.

This is the same coupling the 1.0 path has, but 1.0 got away with it by pinning only `validation.schemaVersion`. The 2.0 manifest pins seven fields that this project has already bumped at least once each.

**Failure:** ship P1-5 with `facts` at `2.2.0`; update the schema const; `provenance-verify` on every pre-existing 2.0 paper now exits 1, and `rebuildLibraryIndex` drops those records. This directly contradicts invariant "existing generations remain readable with zero writeback" for the 2.0 cohort.

**Fix:** either freeze a read-only copy of the 2.0 schema (hash-pinned, never edited, new versions get new files — which the `LEGACY_*` naming already anticipates), or relax the reader to `pattern`/`enum` and keep exactness where it belongs, in the generation fingerprint.

### M2 — The validation-report intrinsic-hash key list is duplicated, and no test covers the real report

`generation-manifest.mjs` re-implements the intrinsic projection:

```js
function validationIntrinsicHash(report) {
  return sha256(stableJson({
    schemaVersion: report.schemaVersion, status: report.status, phase: report.phase,
    publishable: report.publishable, scope: report.scope, validator: report.validator,
    findings: report.findings, referenceCoverage: report.referenceCoverage,
  }))
}
```

The authority is `validation-report.js:221-230` (`createValidationReport`) and `:258-268` (`validateValidationReportForPublication`), which already contain this exact list twice. Adding one intrinsic field there and forgetting this third copy makes `verifyGenerationManifest` reject every published 2.0 generation with `GENERATION_MANIFEST_DIRTY`.

No test would catch it. `generation-provenance.test.mjs:300-307` builds a stub report with a fabricated hash and no `scope`/`findings`/`referenceCoverage`:

```js
reportHash: { algorithm: 'sha256', value: 'e'.repeat(64) },
```

`buildGenerationManifest` copies that value without checking it, so the seal path never exercises the real coupling. Only `generation-publication.test.mjs` reaches it end-to-end, and only on the pinned runtime.

**Fix:** export the intrinsic projection from `validation-report.js` and consume it in both places. Add a test that runs a real `createValidationReport` output through `buildGenerationManifest` → `verifyGenerationManifest`.

### M3 — Repository provenance is not verified to belong to codex-paper

`generation-provenance.mjs:16, 313-314`:

```js
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..')
...
const gitCommit = commandObservation('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], /^[a-f0-9]{40}$/)
const gitDirty = commandObservation('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no'], null, 4096)
```

`git -C <dir>` walks *up* the directory tree until it finds a repository. In the canonical installed layout the plugin root is `~/.codex/plugins/cache/codex-paper/codex-paper/<version>`, so `REPO_ROOT` resolves to `~/.codex/plugins/cache/codex-paper` (verified locally against the installed `2.0.0+codex.20260730103545`). Git returns 128 there *today* only because no ancestor happens to be a repository. On a host with a dotfiles repo rooted at `$HOME` — a common setup — the recorded `software.repository.commit` and `treeState` would be that unrelated repository's, published as this generation's provenance.

**Fix:** compare `git rev-parse --show-toplevel` against `REPO_ROOT` and record `unavailable` unless they match.

Related, and worth a design decision rather than a code change: in the installed layout, `software.repository`, `software.codex.cliVersion` (unless `codex` is on PATH), and `authoringEngine.model` are all structurally unobservable, so the typical production manifest carries `REPOSITORY_COMMIT_UNAVAILABLE` + `AUTHORING_MODEL_UNAVAILABLE` and an empty repository record. The provenance authority is structurally complete but thin in substance where it matters most.

### M4 — The documented prepare invocation now fails closed on any unpinned host Node

`prepare-paper.js:456` makes the runtime gate the first action of `preparePaper`:

```js
const runtimeAttestation = assertContentRuntime(options.runtimeAttestation || collectRuntimeAttestation(options.env || process.env))
```

But both skills instruct a bare `node` invocation, and there is no `codex-paper.sh prepare` wrapper (verified: `grep -n prepare scripts/codex-paper.sh` finds only the test path), so `ensure_node` / `ensure_python` never run:

```bash
node ./scripts/prepare-paper.js "<user-input>" --workflow study --language "$OUTPUT_LANG" ... \
  --authoring-provider openai --authoring-model unavailable
```

On this host (Node 22.16.0, no managed CPython/PyMuPDF) that reproduces as:

```
Error [PROVENANCE_RUNTIME_NONCONFORMANT]: The content-affecting Node/Python/PyMuPDF/parser runtime is not conformant.
```

The single message conflates four independent checks (`contentChecks.node`, `.python`, `.pyMuPDF`, `.parserPolicy`) and names no remedy. This is also the sole cause of all 28 local test failures (see *Verification*).

**Fix:** report which check failed and what the expected/observed values were, and point at the runtime bootstrap command. Consider adding a wrapped `codex-paper.sh prepare` so the documented path inherits `ensure_node`/`ensure_python`.

### M5 — Observation subprocesses run inside the storage lock hierarchy

`generation-workspace.mjs:333-346` calls `buildProvenanceDraft` — and therefore `collectSoftwareProvenance` — inside `withStorageLocks([registry, paper, source, generation])`. That spawns `git rev-parse`, `git status --porcelain`, and `codex --version`, each with a 3 s timeout (`generation-provenance.mjs:300-310`), while holding four locks whose default acquisition timeout is 10 s. `git status` on a large working tree is genuinely slow, and a hung `codex` binary burns the full 3 s.

**Fix:** collect software observations before acquiring the locks and pass them into `createGenerationWorkspace`, exactly as `provenance.runtime` already is.

### M6 — The generation contract now fingerprints publication and verification code

`generation-contract-2.0.json` adds to `common`:

```json
"src/shared/generation-provenance.mjs",
"src/shared/generation-manifest.mjs",
```

`generation-manifest.mjs` is mostly sealing and *verification* logic — `validateGenerationManifest`, `verifyGenerationManifest`, `validateLegacyGenerationManifest`, `readManifestBoundFile`. A verification-only bugfix (say, fixing M1 or M2) now changes `generationId` for every new generation and stops read-only reuse of previously published ones, forcing a full re-prepare across the library.

**Fix:** split the content-producing surface from the verification surface, or accept and document the churn explicitly in `docs/provenance-manifest-2.0.md`.

### M7 — Hardcoded `--authoring-provider openai` declares a value nothing observed

Both `SKILL.md` files and `README.md` bake in `--authoring-provider openai --authoring-model unavailable`, and `check-repository.mjs:731` now *enforces* the flags' presence. `normalizeAuthoringEngine` marks the pair `evidence: 'unavailable'` and `collectSoftwareProvenance` emits `AUTHORING_MODEL_UNAVAILABLE`, so the record is not dishonest — but the plan's own rule is *"unavailable model, Codex, or repository observations are explicit bounded diagnostics and do not fabricate values,"* and a constant `openai` is a fabricated value carrying no information.

It also sits inside `identity.generation.inputs`, so it participates in `generationId`. The first time that string is corrected to a real model name, every paper in every library re-fingerprints.

**Fix:** default both to `unavailable` until the value is actually observable, or separate a `declared` channel from an `observed` one and keep undeclared values out of the fingerprint.

---

## Low

### L1 — Silent degradation to `authoring.status: 'unknown'`

`generation-workspace.mjs:450` and `workspace-cli.js:67` both default `actor` to `'unknown'`. A single omitted `--actor` downgrades the whole generation's authoring status via `authoringSummary` (`generation-provenance.mjs:665-674`), and `manifestDiagnostics` adds nothing to flag it. The provenance quietly gets worse with no signal.

**Fix:** emit an `AUTHORING_ACTOR_UNDECLARED` diagnostic when any terminal event has `actor === 'unknown'`.

### L2 — `--depends-on` is undocumented and unbounded

Added at `workspace-cli.js:78` but absent from `SKILL.md`, `README.md`, `docs/provenance-manifest-2.0.md`, and the Repository Guard. Values are not count-bounded at the CLI (the schema permits 5000) and are validated only downstream in `dependenciesWithHashes`. Relatedly, an invalid `--actor` value falls through to the generic *"unknown, duplicate, or incomplete option"* error rather than naming the allowed set.

### L3 — `README.md` bytes are rewritten server-side, which breaks client-computed CAS

`writeAuthoringWithProvenance` transforms the caller's data for `README.md` only (`generation-provenance.mjs:597`), so the returned `sha256` is the projected bytes, not what the author sent. Any workflow that computes the expected hash locally for the next replacement will fail CAS. The CLI does return the correct hash, but neither `SKILL.md` nor the docs say the transformation happens.

### L4 — Missing `README.md` at seal surfaces as a raw `ENOENT`

`verifyReadmeProjection` (`generation-provenance.mjs:770-771`) reads `README.md` directly, so a study workspace without one throws an unwrapped fs error out of `sealWorkspacePackage` instead of `PROVENANCE_PROJECTION_INVALID`. In practice `validate-study-package.js` requires `README.md` first, so this is only an error-quality issue.

### L5 — Dead and inconsistent code

- `addManifestProjection(packageDir, id, lockHandle, workspace.workspaceLockKey)` no longer writes anything, so `lockHandle` and `requiredLock` are unused parameters (`generation-publication.mjs:158-164`).
- `sealWorkspacePackage` calls `recoverPendingAuthoringEvents` (which returns the draft) and then `readProvenanceDraft(workspace)` again for the same file (`generation-publication.mjs:180-186`).
- `provenance-cli.js:41-50` — the `for (const directory of [executionRoot, root])` throw branch is unreachable; `executionRoot` existence was already checked at `:40`.
- `postSealEvents` omits the `entry.name.startsWith('.')` guard that `collectExecutionReports` applies, so a dotfile ending in `.json` is accepted there but rejected at seal.
- `collectSoftwareProvenance:318` derives the identity schema path from `identity.schemaVersion.split('.')[0]`, so a hypothetical `2.1.0` identity would silently hash `paper-identity-2.0.schema.json`.
- `stableJson` / `sha256` / `stableValue` are now duplicated across `storage-transaction.mjs`, `generation-manifest.mjs`, `generation-provenance.mjs`, and `validation-report.js`.
- JS validators and the JSON Schema disagree on bounds: diagnostic `code` min length 3 (`validDiagnostic`) vs 2 (schema `{1,79}`); `canonical.doi`/`arxiv` 255 (`validateProvenanceDraft`) vs 2048 (`nullableString`); `execution.outcome` is `pass|fail` only at collection time and any string ≤40 in the schema.

### L6 — Per-write provenance cost

Every authoring write now performs three draft read-and-validate cycles (`recoverPendingAuthoringEvents`, then `readProvenanceDraft` after the artifact write, plus the validation inside each `writeDraft`), two atomic fsynced draft writes, a re-hash of the target file, and a re-hash of every default dependency — `analysis.json`, `evidence-ledger.json`, `facts.json`, `reasoning-analysis.json`, each bounded at 128 MB. For a ten-artifact study package that is a meaningful constant-factor increase over the previous single `atomicWriteFile`.

### L7 — Supply-chain review metadata not advanced

`security/supply-chain-review.json` records new hashes for six artifacts changed on 2026-07-30 but keeps `"reviewedAt": "2026-07-28"` and `"policyVersion": "p1-3a-1.0.0"`. The attestation therefore claims a review date two days before the content it attests. All 19 recorded hashes do match the working tree (verified).

### L8 — `meta.json` carries a manifest projection before any manifest exists

`prepare-paper.js:613` writes `meta.generationManifest = { schemaVersion: '2.0.0', manifestId }` at prepare time, which is what makes invariant 6 work. But `rebuildLibraryIndex` spreads `...meta` and only overrides `generationManifest` when a sealed manifest exists (`generation-publication.mjs:345-362`). An unsealed managed generation would therefore project a `generationManifest` with no `manifestHash`/`manifestFileSha256`, implying a seal that never happened. Not reachable through the normal publish path.

### L9 — Identity 2.0 has no versioned document

Every other contract in this repo has its own doc (`paper-identity-1.0.md`, `generation-publication-1.0.md`, `paper-library-layout-1.0.md`). Identity / Generation Contract 2.0 is described only by a banner on the 1.0 doc plus one paragraph in `provenance-manifest-2.0.md`, even though it changes what enters the fingerprint.

### L10 — Change set carries unrelated files, including a carry-over from the P1-3a review

Untracked and unrelated to P1-4: `docs/P0_IMPLEMENTATION.md`, `docs/P1_IMPLEMENTATION_PLAN.md`, `docs/SKILL_OPTIMIZATION_HANDOFF.md`, `docs/STUDY_REWORK_IMPLEMENTATION_SUMMARY.md`, `docs/codex-paper-audit-2026-07-10_origin.md`, `docs/v2-code-review-findings{,-round2,-round3}.md`, `docs/v2-code-review-summary.md`.

`plugins/codex-paper/src/web/components/PaperAnalysisHero.vue` is still present and still unreferenced anywhere in the web tree — this is P1-3a finding L9, unresolved, now riding along in a second phase's change set.

---

## Test coverage gaps

The provenance suite is 8 focused tests and they are well-chosen, but several behaviours the summary lists as invariants have no test at all:

1. **`recoverPendingAuthoringEvents` — none of its three branches** (complete / aborted / `PROVENANCE_EVENT_UNRESOLVED`). This is the core of invariant 4 and of B2.
2. **`assertContentRuntime` and `PUBLICATION_RUNTIME_MISMATCH`** — invariant 1 has no test that a nonconformant runtime or a runtime that drifted between prepare and publish actually blocks.
3. **`PROVENANCE_EVENT_LIMIT_EXCEEDED`** (`MAX_AUTHORING_EVENTS`).
4. **`verifyReadmeProjection` and the `meta.json` projection mismatch** (`PROVENANCE_PROJECTION_INVALID`).
5. **Malformed / cross-generation / wrong-phase execution reports at seal** (`PROVENANCE_EXECUTION_INVALID`) — only the overlay-symlink case is covered, in `generation-publication.test.mjs`.
6. **`verifyGenerationManifest`'s new 2.0 cross-artifact drift checks** — identity, validation-report, and execution-report mismatch all map to `GENERATION_MANIFEST_DIRTY` and none is exercised.
7. **`postSealEvents` happy path** — invariant 5 has only a negative (unsafe symlink) test.
8. **`compatible_1_0` CLI mode end-to-end** — the mode string is asserted by the Repository Guard but never produced by a test.
9. **A real `createValidationReport` → seal → verify round trip** (see M2).

---

## Verified as claimed

Checked directly, not taken from the summary:

- **Fail-closed is consistent.** Unknown manifest version, malformed draft, pending events, missing graph nodes, cycles, hash drift, unsafe execution directories, and non-`https` locators each throw a distinct code with a coherent status. `validateProvenanceDraft`'s `hasOnlyKeys` allowlists plus per-field checks reject injected keys — `injected.source.localPath` is rejected, as tested.
- **Redaction is real.** `sanitizeSourceLocator` strips username, password, query, and fragment and reports `queryPresent`/`credentialsPresent` separately; `manifestDiagnostics` adds `SOURCE_LOCATOR_REDACTED`. The test asserts `os.tmpdir()` does not appear in the serialized draft. `gitDirty`'s porcelain output is used only for truthiness, never recorded.
- **WAL ordering is correct.** The pending event is durably written *before* the artifact and completed after — the direction that is recoverable. `beforeSha256`/`afterSha256` make both outcomes classifiable.
- **`manifestId` is genuinely self-reference-free.** Deriving it from `paperKey + sourceRevisionId + generationId` (dropping the 1.0 dependency on `validationReportHash`) is what lets `meta.json` and the README footer be written at prepare time, and it keeps `manifestHash` and `manifestFileSha256` out of the package. Invariant 6 holds.
- **1.0 compatibility is properly isolated.** `validateLegacyGenerationManifest` retains the original id derivation via `deriveLegacyManifestId`, and the zero-write claim is asserted by both mtime and byte hash.
- **The runtime-baseline move is validated by the installed layout.** `<plugin>/runtime/runtime-baseline.json` exists in the installed `2.0.0+codex.20260730103545` tree; the old `security/runtime-baseline.json` has no remaining non-doc references (only historical mentions in `docs/P1-3A_*`).
- **`replaceWorkspaceJson`'s inline serialization is byte-identical** to the `atomicWriteJson` it replaced (`JSON.stringify(value, null, 2)` + `\n`), so no CAS hashes shift.
- **DAG construction is deterministic.** Sorted Kahn traversal with a sorted queue and sorted node/edge output, so the graph is stable for hashing.
- **Repository Guard and CI additions are substantive** — new sentinels, a CI step-ordering constraint, boundary-token checks on all four new/changed engines, and CLI mode assertions — not cosmetic.
- **All 19 `security/supply-chain-review.json` artifact hashes match the working tree.**
- **`meta.json` cannot be rewritten during authoring** (`isAuthoringPath` / `WRITE_POLICIES`), so its manifest projection is immutable after prepare — `addManifestProjection`'s downgrade from write to verify is safe.
- **Summary workspaces are never published** (C2b requires a complete study package), so `verifyReadmeProjection`'s hard `README.md` requirement does not break the summary workflow, which produces `quick-summary.md` only.

## Verification run

| Suite | Result |
|---|---|
| `node --test .../tests/generation-provenance.test.mjs` | **8/8 pass** |
| `node --test --test-concurrency=1 scripts/tests/check-repository.test.mjs` | **78/78 pass** |
| `node --test plugins/.../study/scripts/tests/*.mjs` | 95 tests, **90 pass, 5 fail** |
| `node --test --test-concurrency=1 scripts/tests/*.test.mjs` | 208 tests, **185 pass, 23 fail** |

All 28 failures trace to a single cause — `Error [PROVENANCE_RUNTIME_NONCONFORMANT]` — on this host (Node 22.16.0 vs pinned 22.23.1, no managed CPython/PyMuPDF). Every failing test invokes `prepare-paper.js`, directly or through a fixture, and now hits M4's new gate. The test *counts* (208 / 95 / 78) match the literals `check-repository.mjs` asserts against `codex-paper.sh`, so the claimed `208/208` and `95/95` are plausible on the pinned runtime, **but were not reproduced here**.

Worth noting as a side effect of M4: 23 of 208 repository tests and 5 of 95 study tests are now hard-coupled to the exact managed runtime, including tests that only exercise storage and publication semantics. `preparePaper` already accepts an injectable `options.runtimeAttestation` (and `storage-transaction.test.mjs`'s `directProvenance` uses the equivalent), but the CLI fixtures have no way to reach it.

Docker remains unavailable locally, so the digest-pinned sandbox conformance gate is still unexecuted anywhere — as the summary states, remote CI must supply that evidence.

---

## Recommended order of work

1. **M1** — freeze or relax the 2.0 schema pins. Cheapest to fix now, unfixable later without a migration.
2. **M2** — deduplicate the validation intrinsic projection and add the real round-trip test.
3. **B1** — name the stale artifacts in the error, document the write order and the remedy.
4. **B2** — add a resolution path, or document abandon-and-reprepare in the error itself.
5. **M4** — split the runtime error into its four checks and name the bootstrap command.
6. **M3** — verify the git toplevel; then decide whether `software.repository` earns its place.
7. **M5** — move observation collection outside the locks.
8. Test gaps 1, 2, 5, 6 — the four that cover invariants with no coverage at all.
9. **M6, M7** — design decisions; resolve before the contract is frozen for P1-2.
10. **L1–L10** — cleanup. **L10** should be resolved before commit regardless: this change set should not carry eight unrelated docs and a 311-line unreferenced Vue component.
