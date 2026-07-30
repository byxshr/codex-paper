# P1-4 Code Review Handoff

## Review objective

Confirm that new publications have one complete, deterministic provenance authority while existing Manifest/Identity 1.0 generations remain readable with zero writeback.

## Material changes

- Added Paper Identity, Generation Contract and Generation Manifest `2.0.0`.
- Moved the runtime baseline into the active plugin as its single distributable authority.
- Added redacted source/runtime/software provenance and generation-fingerprint inputs.
- Added workspace `provenance-draft.json`, declared-actor authoring WAL, default/additive dependencies, README/meta projections and DAG validation.
- Bound pre-seal and post-seal execution reports to generation/manifest identity.
- Added provenance inspect/verify/test CLI commands, Repository Guard checks and a dedicated CI gate.
- Preserved Manifest/Identity 1.0 readers; no migration or retroactive rewrite is performed.

## Review round 1 disposition

The independent review was substantively correct. The following changes were
adopted:

- stale dependency failures now identify the downstream artifact, dependency,
  expected hash and actual hash, and the study workflow documents the required
  reasoning-first order plus downstream regeneration remedy;
- ambiguous pending WAL events remain fail closed, but can now be resolved only
  through `provenance-resolve <workspace> --adopt-current`; recovery aborts the
  interrupted intent, records a new `unknown`-actor adoption event with current
  dependency hashes, and persists a permanent diagnostic;
- the Manifest 2.0 schema is byte-hash frozen. Future contract changes require
  a new versioned schema and reader rather than editing the 2.0 file;
- Validation Report intrinsic hashing is shared by report creation,
  publication validation and Manifest verification, with a real report
  build/verify round trip;
- repository provenance is accepted only when `git --show-toplevel` exactly
  matches the expected repository root;
- runtime failures enumerate failed checks, expected and observed values, and
  remediation; root `prepare` now uses the managed runtime bootstrap;
- software observations are collected before storage locks are acquired;
- publication/sealing-only code is excluded from the generation content
  fingerprint, and undeclared provider/model values default to
  `unavailable`;
- unknown authoring actors produce a diagnostic, additive dependencies are
  documented and capped at 64, README projection/CAS behavior is explicit,
  projection errors are normalized, schema/validator bounds agree, and
  Identity/Generation Contract 2.0 has its own document.

The performance observation about repeated durable WAL writes and dependency
hashing is valid, but durability is not weakened without profiling. It is
tracked under P1-3b together with the existing storage performance work.
The pre-seal `meta.json` projection is retained because unsealed generations
cannot enter authoritative `current.json` or the index through the normal
publication path. Unrelated untracked documents and the unreferenced
`PaperAnalysisHero.vue` remain outside the P1-4 change set and must not be
staged with this phase.

## Review round 2 disposition

Round 2 confirmed the first remediation and identified one new publication
ordering defect. All correctness and operator-facing findings N1–N9 were
adopted:

- ambiguous adoption now durably demotes the workspace before touching the
  WAL; a fault injected after demotion leaves the workspace in `authoring` and
  the event pending;
- workspace wrapper and `resolve-event` CLI tests prove successful adoption
  cannot retain a stale validated state;
- `provenance-inspect` exposes bounded pending-event identifiers, while all
  provenance/workspace/publication CLIs print bounded, secret/path-redacted
  structured error details;
- repository-checkout skill commands use the correct path from the skill
  directory, installed-cache fallback is explicit, and the root `prepare`
  wrapper is now the preferred checkout entrypoint;
- explicit adoption and automatic reconciliation have distinct diagnostics;
- missing adoption dependencies are normalized to
  `PROVENANCE_EVENT_UNRESOLVED`;
- the 64-dependency budget is explicitly total-after-defaults;
- README and meta projection failures share
  `PROVENANCE_PROJECTION_INVALID`;
- Manifest validation re-derives the exact diagnostic projection;
- publication-side runtime drift and validation/execution cross-artifact drift
  have direct regression coverage.

N10's dead parameters and duplicate draft read were present in the round-2
snapshot and were removed during that remediation. Consolidating canonical
JSON helpers and splitting the remaining mixed content/verification provenance
module are valid engineering improvements but intentionally remain in P1-3b
because they are broader refactors, not P1-4 correctness fixes. The untracked
unrelated files remain excluded.

## Review round 3 disposition

Round 3 approved the round-2 remediation with no blocking findings. Its six
actionable low-severity items were adopted:

- CLI error messages now use the same absolute-path and URL-secret redaction
  as structured details; missing drafts become `PROVENANCE_DRAFT_MISSING`;
- empty details are omitted, and oversized details remain valid JSON with an
  explicit truncation marker;
- the study publish step uses the same checkout-relative root wrapper as
  prepare, runtime and recovery commands;
- the indirect adopted-event pair encoding documents the frozen Manifest 2.0
  schema constraint;
- workspace fault injection uses a shared local helper;
- the N10 remediation timeline above now matches the reviewed tree.

A dedicated CLI formatter regression covers messages, secret keys, URLs,
empty/oversized/circular details and missing-draft CLI output. This raises the
study suite to `100/100` and provenance coverage to `13/13`. Unrelated
untracked files remain excluded, while Docker conformance still requires
remote CI before Review completion.

## Review round 4 disposition

Round 4 gave the implementation a conditional `PASS` and found no correctness
defect. Two low-cost hardening suggestions were adopted:

- absolute Unix paths with two or more segments are redacted regardless of the
  punctuation immediately before them, covering bracket, comma, angle and
  doubled-slash message forms;
- URL sanitization now processes URL and non-URL chunks directly instead of
  substituting textual placeholders, so user-controlled text cannot collide
  with an internal token.

The remaining `safeDetail` absolute-path check is intentionally retained as
defense in depth. Regression coverage exercises all newly identified message
forms and the former placeholder literal. The pinned-runtime evidence condition
is now satisfied locally by `209/209`, `100/100`, `79/79`, and `13/13` passing
with Node `22.23.1` and the managed CPython/PyMuPDF runtime. Real Docker sandbox
conformance remains the sole external condition and must pass in remote CI
before this phase is marked Review complete.

## Security and correctness invariants

1. Content-runtime mismatch blocks prepare and publication; tooling-only npm drift does not change generation identity.
2. Local absolute paths, URL credentials, query values, fragments, secrets, environment and artifact contents never enter provenance.
3. Workspace writes remain lock-held, no-follow, CAS-protected, fsynced and atomic; provenance events are written ahead of the artifact.
4. Pending/ambiguous authoring events, malformed execution reports, missing DAG nodes, cycles, hash drift and unsupported manifest versions fail closed; ambiguous WAL recovery requires an explicit audited adoption.
5. Published package bytes remain immutable. Post-seal execution events live only in the overlay and bind all three authoritative manifest values.
6. `manifestId` is available before authoring without self-reference; final hash/file hash remain outside package projections.
7. Signature state is explicitly unsigned and cannot imply P2-5 authenticity.

## Suggested review commands

```bash
bash scripts/codex-paper.sh repo-check
bash scripts/codex-paper.sh provenance-test
bash scripts/codex-paper.sh validation-test
bash scripts/codex-paper.sh identity-test
bash scripts/codex-paper.sh storage-test
bash scripts/codex-paper.sh publication-test
bash scripts/codex-paper.sh benchmark-mandatory
```

Use Node `22.23.1`, npm `10.9.8` and the managed CPython/PyMuPDF runtime. On a host without the pinned Node version, direct product tests may be run with a temporary exact Node executable, but root commands intentionally fail closed.

## Implementation acceptance

- Repository/security: `209/209`; study: `100/100`; provenance: `13/13`.
- Identity `17/17`, layout `7/7`, storage `16/16`, publication `15/15`,
  Validation `24/24`, PDF ingestion `12/12`.
- Mandatory `2/2`, external parser `5/5`, reasoning `12/12`, package `12/12`.
- Runtime, dependency audit, supply-chain, tracked-tree secret scan, production
  build, Viewer HTTP security, smoke, and official plugin validation passed.
- Canonical marketplace install resolves to `plugins/codex-paper/` at
  `2.0.0+codex.20260730125252`.
- Docker is unavailable locally and fails closed as designed; remote CI must
  provide the real sandbox conformance evidence before Review completion.

The ordinary secret-scan command sees the pre-existing Git index and therefore
still sees the staged view of the moved runtime policy. Acceptance used an
isolated temporary Git index containing the current tracked changes and the
P1-4 files, without staging the user's worktree; that complete candidate tree
passed with no secret findings.

## Deliberately excluded

- migration/backup/rollback of existing generations (P1-2);
- root workspace, `npm ci`, strict typing and matrices (P1-3b);
- signing keys/SBOM/release signatures (P2-5);
- provenance editing UI.

The round-2 residual Manifest 2.0 golden fixture is assigned to P1-2, where it
will become an explicit zero-write migration/reader compatibility input rather
than another self-generated P1-4 unit fixture. Canonical JSON consolidation and
the content-producer/verifier module split are assigned to P1-3b with a
behavior-equivalence requirement so that the refactor cannot silently change
Generation Contract 2.0 fingerprints.
