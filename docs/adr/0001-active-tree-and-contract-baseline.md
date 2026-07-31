# ADR 0001: Active Tree and Contract Baseline

- Status: Accepted
- Date: 2026-07-10
- Decision owner: Codex Paper maintainers

## Context

The repository contained two executable plugin trees. The repo marketplace and all root automation used `plugins/codex-paper/`, while the top-level `plugin/` copy had diverged. Keeping both made it possible to fix, test, or install the wrong implementation. The package also needs a stable contract boundary before security and quality work changes schemas or validation behavior.

The audit sample artifacts live outside this repository under `/Users/bianyuxin/codex-papers/papers/attention-is-all-you-need`. Its PDF, images, tables, and long excerpts are local evidence and are not redistributable repository fixtures.

## Decision

### Single active implementation

`plugins/codex-paper/` is the only source, install, build, test, and release tree. `.agents/plugins/marketplace.json` is the only repository marketplace catalog. Git history is the archive for the removed top-level `plugin/` tree. The plugin uses default component discovery for `hooks/`; the manifest does not declare the unsupported `hooks` field.

### Immutable 2.0 contracts and compatible 2.1 evolution

The three 2.0 JSON Schemas and their SHA-256 values are frozen in `docs/contracts/s0-contract-baseline.json`; no 2.0 schema may be edited in place.

- v1 remains statically browsable and receives only limited validation through `--legacy-ok`.
- v2.0 remains readable and validatable. Reading never migrates or rewrites files.
- The next writer targets v2.1. It may add typed `resultClaims` and direct `ev-*` references, but must retain the `keyResults` compatibility projection until v3. Readers accept both old `claim:n`/`result:n` references and direct evidence references.
- Unknown versions are read-only diagnostics: they produce an explicit compatibility error and are never automatically migrated or written back.
- Migrations are explicit, idempotent, reversible, and preserve rollback material.

### Authority and trust boundary

The source PDF and source hash are the fact root. The evidence ledger is authoritative for paper evidence. Reasoning analysis is authoritative for final research reasoning. Until P0-B2 and P0-B3 complete, `facts`, `analysis`, and `paper-data` are unverified hints or projections and cannot overrule those authorities.

### Validation Report 1.0 target

S0 freezes, but does not implement, the future interface: `status` is `pass`, `pass_with_warnings`, or `fail`; `phase` is `draft` or `complete`; the report includes `publishable`, explicit included/excluded scope, gate policy/outcome, validator identity, generation time, structured findings, and `referenceCoverage`. Strict mode changes only the gate decision and CLI exit code; it does not rewrite intrinsic findings or status. Draft output is never publishable.

### Fixture policy

Repository PDFs are allowlisted only below `benchmarks/fixtures/pdf/`. A fixture must be original synthetic content or carry an explicit redistribution license. Every PDF uses a tracked `<pdf-path>.manifest.json` sidecar recording identity, kind, origin, copyright, SPDX identifier, license, redistribution permission, SHA-256, and generator. The local Attention sample artifacts must not be copied into the repository.

## Consequences

Repository automation can reject a second plugin tree, duplicate marketplace, generated artifacts, old executable paths, version drift, or edits to frozen schemas before dependencies are installed. Users with scripts hard-coded to `<repo>/plugin` must reinstall from the repository marketplace. Typed results and three-state validation remain assigned to P0-B2 and P0-B3 rather than being partially implemented in S0.

## Rollback

Revert the S0 change set. If the legacy tree must be inspected, restore it from Git history into a temporary non-executable location; do not reintroduce a second installable tree.
