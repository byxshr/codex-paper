# P0-B2 Code Review Handoff

## Review scope

P0-B2 implements the S0-frozen minimum `2.1.0` package contract for newly generated paper packages. It replaces heuristic quantitative `keyResults` extraction with typed, evidence-ledger-backed `resultClaims`, keeps `keyResults` as a deterministic compatibility projection, and changes newly authored facts and analysis references to direct `ev-*` IDs.

The change also introduces one shared package-version compatibility layer for validators, artifact readers and Viewer APIs. Existing 2.0 and v1 packages remain readable without being rewritten; unknown versions remain safely readable but are explicitly diagnosed and rejected by validators and artifact writers.

Primary review areas:

- `plugins/codex-paper/skills/study/schemas/facts-2.1.schema.json`
- `plugins/codex-paper/skills/study/scripts/extract-facts.js`
- `plugins/codex-paper/skills/study/scripts/prepare-paper.js`
- `plugins/codex-paper/skills/study/scripts/build-analysis.js`
- `plugins/codex-paper/src/shared/package-compatibility.mjs`
- `plugins/codex-paper/skills/study/scripts/validate-study-package.js`
- `plugins/codex-paper/src/web/server/api/papers/[slug]/`
- `benchmarks/mandatory/gold/`
- `benchmarks/mandatory/run-fixture.mjs`
- `scripts/check-repository.mjs`

Supporting contracts:

- `docs/P0-B2_IMPLEMENTATION_PLAN.md`
- `docs/package-v2.md`
- `docs/evidence-ledger.md`
- `docs/reasoning-analysis.md`
- `docs/deterministic-regression-contract.md`
- `docs/contracts/s0-contract-baseline.json`

## Delivered package contract

Newly prepared packages now declare:

- `meta.packageVersion = "2.1.0"`
- `facts.schemaVersion = "2.1.0"`
- `facts.resultClaims` as the native quantitative-result interface
- `facts.keyResults` as a deterministic compatibility projection

Each ResultClaim contains nullable context dimensions (`task`, `dataset`, `split`, `languagePair`, `model`, and `comparator`) plus a required metric, numeric value, unit, direction, page/table location, non-empty direct evidence references, and `high | medium` confidence. Page numbers are one-based; table is `null` when no reliable table label can be bound.

`keyResults` is derived from ResultClaim rather than extracted independently. The projection retains the legacy string value, contextual description, evidence description and direct `evidenceRefs`. This prevents native and compatibility result surfaces from drifting inside the same newly generated package.

The package-version axes are deliberately independent:

- package and facts writer contract: `2.1.0`
- evidence ledger, external evidence and reasoning-analysis schemas: frozen at `2.0.0`
- Node package, lockfile and plugin base version: `2.0.0`
- active plugin build: cachebuster-qualified `2.0.0`

`generatedWith.pluginVersion` records the plugin base version rather than incorrectly copying the package contract version. The three frozen 2.0 schema files and their contract-baseline hashes were not modified.

## Extraction and evidence behavior

Facts extraction now starts from evidence-ledger units rather than scanning an unconstrained document summary. A result candidate must bind its number to an explicit metric or result predicate in the same evidence unit or clause.

The deterministic P0 metric registry covers:

- BLEU
- Accuracy
- F1
- ROUGE
- Perplexity
- AUC/AUROC
- mAP
- Precision
- Recall
- Exact Match

Both metric-first and value-first forms are supported, including forms such as `41.8 BLEU` and `BLEU score of 41.8`. Percentage values are normalized into a numeric value plus an explicit unit.

The extractor rejects common false-result categories, including years from 1900 through 2099, page/table labels, reference numbers, versions, GPU counts, parameter counts and training-duration numbers. Controlled front-matter filters also exclude copyright text, conference boilerplate, arXiv version lines, equal-contribution footnotes, references and repeated heading-like noise from core claims and limitations.

Context is only populated when it can be bound from the same evidence or reliable adjacent table evidence. Missing context remains `null`; the writer does not infer it from distant text. Equal metric/value candidates merge only when they share the same evidence or a concrete compatible discriminator; context-poor candidates remain distinct instead of inheriting attribution. Distinct values always remain separate claims. Therefore 41.8 and 41.0 are both preserved with their own evidence; deciding that they conflict belongs to P0-B3.

New facts and analysis artifacts only emit direct ledger IDs. Every emitted `ev-*` reference is checked against the current evidence ledger before the artifact is accepted. Legacy `claim:n`, `result:n`, and `limitation:n` aliases remain reader-only compatibility inputs.

## Compatibility behavior

The shared reader classifies a package into one of four modes:

| Package | Mode | Read-only | Behavior |
|---|---|---:|---|
| `2.1.0` | `native_2_1` | no | Native ResultClaim and direct-reference behavior |
| `2.0.0` | `compatible_2_0` | yes | Reads `keyResults`; resolves legacy fact aliases in memory |
| v1/no v2 metadata | `legacy_v1` | yes | Existing static browsing and `--legacy-ok` validation boundary |
| unknown | `unknown_read_only` | yes | Safe reads with `PACKAGE_VERSION_UNSUPPORTED`; validation/writes fail closed |

Viewer facts, analysis and reasoning GET responses now include the compatibility object. Compatibility reads do not migrate or write back any file. Tests compare package hashes and mtimes before and after reads to enforce this boundary.

Artifact writers that could otherwise modify a package, including analysis, rendering and ordinary reasoning scaffolding, reject every read-only compatibility mode before writing. The existing explicit v1-to-v2 migration retains only its internal scaffold step. The study validator reports unsupported versions as a validation failure with exit code `1`.

## Mandatory golden migration

P0-B1's expected-defect contract was migrated so corrected B2 behavior is now a required positive assertion rather than an expected failure.

`front-matter-noise` now requires:

- only evidence-backed 28.4 BLEU result values; context-distinct mentions are not force-merged;
- package/facts version `2.1.0`;
- direct references only;
- no 2017 or 2026 result;
- no equal-contribution, conference-year or copyright contamination in facts/analysis.

`result-conflict` now requires:

- independent evidence-backed 28.4, 41.8 and 41.0 ResultClaims;
- no 2014 result;
- Table 2 evidence for the synthetic 41.8 claim;
- exact `keyResults`/`resultClaims` projection agreement;
- complete direct-reference coverage.

The ResultClaim target moved from `reservedTargets` into active `requiredAssertions`. Validation Report 1.0 remains reserved for P0-B3.

Only these three expected findings remain:

- `FRONT_MATTER_FOOTNOTE_IN_ABSTRACT`
- `FRONT_MATTER_COPYRIGHT_IN_ABSTRACT`
- `RESULT_CONFLICT_HAS_NO_VALIDATION_WARNING`

The first two are parser-level abstract warnings to be represented by P0-B3 validation findings. The last is the intentionally missing cross-artifact conflict warning. They are not B2 extraction failures.

The mandatory report now exposes package version, facts schema version, ResultClaim count, active B2 contract IDs and direct-reference assertions. The suite still fails unless both declared fixtures execute and pass.

## Repository and regression gates

Repository Guard now requires:

- the facts 2.1 schema, ResultClaim extractor and shared compatibility module;
- package/facts writer version `2.1.0` while evidence/reasoning/plugin/package versions remain correctly decoupled;
- direct-reference writer behavior;
- all four compatibility modes and the unsupported-version diagnostic;
- migrated mandatory gold at contract schema `1.1.0`;
- the ResultClaim target to be active and the Validation Report target to remain reserved;
- unchanged hashes for all S0-frozen 2.0 schemas.

Mutation tests cover missing sentinels, version-axis coupling, removal of compatibility modes, mandatory-gold regression and frozen-schema drift.

## Independent Review feedback resolution

The independent Review confirmed the fixture-level contract and reported nine actionable issues. All nine were accepted after local reproduction:

1. Numeric tokens inside metric names such as `ROUGE-1` and `ROUGE-2` are excluded from value scanning; a real score following the metric still binds correctly.
2. Evidence confidence is preserved (`medium` remains `medium`), and ledger `low` candidates are omitted as required by the ResultClaim contract.
3. Equal metric/value candidates now merge only when contexts do not conflict and they share the same evidence or a concrete discriminator such as dataset, split, language pair, model, or comparator. A context-poor candidate cannot silently inherit a dataset/model; the legitimate 41.8 prose/Table 2 merge remains supported through shared `EN-FR` context.
4. Mandatory projection comparison parses an optional trailing percent sign strictly, so `95.2%` matches numeric `95.2` while junk suffixes remain invalid.
5. Non-positive table labels map to `null`, preventing schema-invalid `table: 0` output.
6. Evidence refs are checked for canonical pattern, uniqueness and ledger membership. `preparePaper` additionally runs Ajv against the complete facts 2.1 schema before writing package artifacts.
7. Analysis, rendering and ordinary reasoning-scaffold writers now call one `assertWritablePackage` guard and reject every read-only mode, including 2.0. The existing explicit v1-to-v2 migration has a narrowly scoped internal exception for creating its 2.0 reasoning scaffold; no general 2.0 writer or implicit 2.0-to-2.1 migration was added.
8. A reasoning/ledger artifact with an unsupported or missing schema version can no longer be classified as legacy v1 and skip v2 validation; it becomes `unknown_read_only` with `PACKAGE_VERSION_UNSUPPORTED`.
9. Viewer facts/analysis/reasoning endpoints parse the large evidence ledger only as a fallback when package/reasoning version metadata is absent. HTTP regression coverage proves native 2.1 endpoints do not need to parse ledger content for compatibility classification.

The directly related cleanup was also adopted: the canonical paper-evidence ID regex is exported from the shared compatibility module, and unused extractor `_contexts` state was removed. Broader whitespace-helper consolidation, the repeated analysis fallback helper, and the server path-policy regex variant were left unchanged because they are separate refactors with different trust-boundary semantics and no demonstrated P0-B2 defect.

## Round 2 Review feedback resolution

The second independent Review verified all nine first-round fixes and reported eight lower-severity robustness and consistency findings. Seven implementation defects were accepted, and the two related legacy-behavior observations were resolved by documenting and testing the already frozen read-only policy rather than adding a writer escape hatch:

1. Result candidates are canonically sorted by semantic specificity and stable evidence/location keys before greedy grouping. All six permutations of a dataset-only, language-pair-only and bridging candidate now produce the same single claim and evidence set.
2. Legacy v1 analysis/rendering remains intentionally read-only. This follows the S0 contract: v1 supports static browsing and limited validation, not artifact regeneration. No `--legacy-ok` writer bypass was added.
3. Validation now aligns with that boundary: a v1 package requires `--legacy-ok`; without it validation fails with `LEGACY_PACKAGE_REQUIRES_LEGACY_OK`. With it, output explicitly says validation is limited and read-only and does not authorize artifact writes.
4. Facts, analysis and reasoning endpoints now call one stored-package classifier. When `meta.packageVersion` is absent, all endpoints inspect both reasoning and ledger versions, so a mismatched/tampered package consistently reports `unknown_read_only`. The shared module is explicitly inlined by Nitro to preserve production-build path resolution without duplicating compatibility logic.
5. Migration rejects unsupported declared source versions before its first write, preventing a partially migrated directory. Unversioned/v1 sources and idempotent 2.0 reruns retain their intended behavior.
6. Analysis fallback references now honor the caller's `limit` on every branch.
7. Direct `ev-*` compatibility resolution can optionally validate membership against the supplied ledger; syntactically valid but absent IDs no longer pass when evidence membership is available.
8. Malformed non-array `evidenceRefs` now produces one shape error and stops processing that field instead of emitting one error per string character.

Repository Guard mutation coverage protects the merge-order comparator, explicit legacy validation boundary, pre-write migration rejection and shared Viewer classification helper. The deferred whitespace/helper cleanups remain outside P0-B2 because Round 2 again identified no behavior or security defect in them.

## Round 3 Review feedback resolution

The third independent Review verified every Round 2 correction and reported seven residual edge cases or policy confirmations. The actionable correctness gaps were accepted with one stricter safety interpretation:

1. Explicitly versioned `1.x` packages now use the same shared legacy-migration predicate in both the migration preflight and the internal reasoning-scaffold exception. A `1.0.0` regression proves the migration produces ledger, reasoning, review and final 2.0 metadata instead of stopping after partial writes.
2. For packages without authoritative `meta.packageVersion`, malformed ancillary reasoning/ledger JSON no longer turns otherwise readable facts or analysis endpoints into HTTP 422. The Viewer still serves the requested valid primary artifact but reports `unknown_read_only` with `PACKAGE_ARTIFACT_INVALID`.
3. The reasoning endpoint uses the same behavior when reasoning is absent or valid but its ancillary ledger is malformed; an actually malformed requested reasoning document still retains the managed-JSON 422 boundary.
4. Real HTTP coverage now includes a no-meta package with a corrupt ledger and asserts the same fail-closed diagnostic across facts, analysis and reasoning. The earlier native-2.1 corrupt-ledger fixture remains, proving authoritative metadata avoids unnecessary ledger parsing.
5. Requiring `--legacy-ok` for v1 validation is confirmed as intentional. It is a deliberate hard compatibility boundary for automation and remains documented; no code rollback was made.
6. Native 2.1 mode is deliberately not inferred without `meta.packageVersion`. Evidence and reasoning schemas remain frozen at 2.0, so ancillary `2.1.0` versions are invalid rather than evidence of a writable package. A unit test freezes this fail-closed decision.
7. Validator compatibility reads no longer silently turn malformed `meta.json` into inferred 2.0. Corrupt compatibility JSON produces `PACKAGE_ARTIFACT_INVALID` and validation failure. Viewer routes continue to return 422 when their directly required `meta.json` is corrupt.

The Review suggestion to treat corrupt ancillary files as absent was tightened: absence and corruption are not equivalent. Readers preserve available safe data, but corruption always produces an explicit read-only diagnostic. Repository Guard mutation coverage now protects the shared declared-1.x predicate and corrupt-artifact handling in the shared reader, validator, migration and Viewer helper.

## Round 4 Review feedback resolution

The fourth independent Review verified all seven Round 3 decisions and found four actionable residuals plus one trust-boundary question:

1. Migration now preflights existing reasoning and ledger artifacts, independently of `meta.packageVersion`, before its first write. Unsupported or missing ancillary schema versions fail with `MIGRATION_SOURCE_VERSION_UNSUPPORTED` under both normal and `--force` operation; `--force` can no longer silently replace an unsupported ledger after other files were written.
2. Migration JSON reads now convert malformed meta, paper-data, ledger or reasoning inputs into `PACKAGE_ARTIFACT_INVALID` instead of exposing a raw `SyntaxError`. Regression tests verify the directory remains byte-for-byte unchanged.
3. Facts and analysis endpoints let the stored-package helper read `meta.json` through the same 422-tolerant compatibility path. A corrupt meta sidecar therefore returns the valid primary artifact with `unknown_read_only + PACKAGE_ARTIFACT_INVALID`; reasoning retains its pre-existing 422 behavior because meta is directly required by that response.
4. Mixed ancillary versions now identify the actual unsupported or missing versions. A 2.0 reasoning plus 3.0 ledger reports 3.0.0 rather than incorrectly describing supported 2.0.0 as the offender. A versionless artifact mixed with a 2.0 artifact also fails closed instead of being ignored.
5. The Viewer/validator difference under authoritative metadata is intentional and now explicit. Viewer compatibility is a lightweight package-version view: when `meta.packageVersion` is valid, it does not parse the large ledger merely to assess artifact integrity. CLI validation is the exhaustive health gate and may report corrupt ancillary content. Consequently Viewer `compatibility.readOnly` must not be used as a publishability or package-integrity signal; P0-B3 owns those gates.

HTTP tests cover corrupt meta on facts and analysis, while migration tests cover unsupported ancillary versions with and without force and corrupt metadata before writes. Repository Guard protects full migration preflight, corrupt-input diagnostics, corrupt-meta Viewer fallback and accurate mixed-version diagnostics.

## Verification evidence

- Repository/security tests: 108/108.
- Study unit tests: 44/44.
- Mandatory deterministic benchmark: 2/2.
- PDF ingestion security: 12/12.
- External parser corpus: 5/5.
- Reasoning benchmark: 12/12.
- Package benchmark: 12/12.
- Production build passed.
- Viewer HTTP security integration passed; focused compatibility tests cover all four modes and prove zero-write reads.
- Smoke test passed.
- Repository Contract passed with 196 tracked files inspected.
- Official plugin validator passed.
- `git diff --check` passed.
- Active plugin path is `plugins/codex-paper` at `2.0.0+codex.20260716070151`.

## Attention sample read-only acceptance

The existing sample at `/Users/bianyuxin/codex-papers/papers/attention-is-all-you-need` was used only as a read-only manual acceptance source. Its PDF was prepared into a temporary `PAPERS_DIR`; the temporary output was deleted after inspection.

Observed behavior:

- 28.4, 41.8 and the evidence-backed 41.0 are present as quantitative claims;
- 2014 and 2017 are not emitted as result values;
- analysis references are direct `ev-*` IDs;
- the source sample directory's metadata digest and mtimes matched before and after the check.

No sample PDF, images, tables or long excerpts were copied into the repository.

## Reviewer focus

- Validate the ResultClaim schema's required/nullable fields, numeric value semantics, direction enum, one-based location and evidence-reference constraints.
- Check extraction boundaries for metric-first/value-first syntax, years, hardware counts, duration, front matter and same-clause binding.
- Confirm context fields are not guessed and that stable merge/sort rules do not collapse distinct 41.8 and 41.0 claims.
- Confirm `keyResults` is a pure projection and cannot diverge from native ResultClaims.
- Trace every new facts/analysis reference to an existing ledger entry; look for any writer path that can still emit `claim:n`, `result:n`, or `limitation:n`.
- Verify 2.0 legacy aliases resolve only in memory and that compatibility reads cannot change files.
- Verify unknown versions are readable with an explicit diagnostic but cannot be validated as supported or modified by artifact writers.
- Confirm package/facts 2.1 did not alter the three frozen 2.0 schemas or the Node/plugin base version.
- Review mandatory expected-finding migration carefully: corrected B2 defects must be positive assertions, while only the three B3-owned findings remain expected.
- Confirm Viewer compatibility metadata does not weaken P0-A1 path/session controls or P0-A2 active-content isolation.

## Suggested reproduction

```bash
bash scripts/codex-paper.sh repo-check
bash scripts/codex-paper.sh test
bash scripts/codex-paper.sh pdf-security-test
bash scripts/codex-paper.sh benchmark-mandatory
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh reasoning-test
bash scripts/codex-paper.sh package-test
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh security-test
bash scripts/codex-paper.sh smoke-test
python3 /Users/bianyuxin/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-paper
```

Review should not run preparation directly against the user's real `~/codex-papers` library. Mandatory and automated tests use repository-owned synthetic fixtures and temporary libraries.

## Out of scope and residual boundary

- Conflict findings, cross-artifact consistency gates, `publishable`, and `pass | pass_with_warnings | fail` remain P0-B3.
- The remaining parser-level abstract contamination is reported as a B3 target rather than solved by modifying the P0-A4 parser in this phase.
- Advanced double-column ordering, general table-grid reconstruction and broader header/footer classification remain P1-1.
- Explicit, reversible 2.0-to-2.1 migration remains P1-2; this phase performs no implicit migration.
- Facts and analysis remain projections until P0-B3 makes their consistency and publication health machine-enforceable.
- Dependency-audit remediation remains P1-3a.
- Identity collision, overwrite protection and transactional publication remain P0-C1/C2.

Fourth-round independent Code Review passed on 2026-07-20. All findings from the four review rounds are closed, with no remaining Review blockers.

Delivery status is `Review 完成 / 已推送`. The P0-B2 stage commit contains the reviewed implementation and documentation; remote CI is the delivery acceptance gate before P0-B3. M1 remains open until P0-B3 is reviewed and its remote CI passes.
