# P1-4 Implementation Plan

P1-4 upgrades newly published generations to Generation Manifest 2.0 while
retaining read-only verification for Generation Manifest and Paper Identity
1.0. The new manifest is the single authority for source, generation inputs,
software/runtime attestations, artifact dependencies, validation, execution,
authoring, migration history, and integrity.

Implementation rules:

- content-affecting runtime inputs participate in Generation Contract 2.0;
- unavailable model, Codex, or repository observations are explicit bounded
  diagnostics and do not fabricate values;
- workspace provenance is a pre-seal draft only;
- published generations remain immutable;
- post-seal execution reports bind the current manifest without rewriting it;
- integrity uses canonical SHA-256 and records an unsigned P2-5 boundary;
- existing 1.0 generations are never rewritten by inspection or verification.

Acceptance requires provenance-specific unit/integration tests, the complete
existing regression suite, official plugin validation, cachebuster refresh,
and canonical marketplace reinstall. This stage does not commit or push.

## Implementation result

Status: `Review 完成 / 已推送` on 2026-07-30.

The implementation now seals new publications with Generation Manifest 2.0,
keeps Manifest and Identity 1.0 read-only compatible, records redacted source
and software observations, binds the exact content runtime and generation
contract, maintains a write-ahead authoring audit trail, verifies the artifact
dependency DAG, and distinguishes pre-seal executions from manifest-bound
post-seal overlay events. Inspection and verification are available through
the root `provenance-inspect`, `provenance-verify`, and `provenance-test`
commands.

Local acceptance passed:

- repository/security `209/209`, study `100/100`, provenance `13/13`;
- identity `17/17`, layout `7/7`, storage `16/16`, publication `15/15`,
  Validation `24/24`, and PDF ingestion `12/12`;
- mandatory `2/2`, external parser `5/5`, reasoning `12/12`, and package
  `12/12`;
- runtime, dependency, supply-chain and tracked-tree secret gates;
- Nuxt production build, Viewer HTTP security, smoke test, official plugin
  validation, and canonical marketplace reinstall.

Docker is unavailable on this Mac and correctly remains fail closed. Stage
commit `7f0211e` was pushed, and
[CI run 30544688962](https://github.com/byxshr/codex-paper/actions/runs/30544688962)
passed the digest-pinned Docker conformance gate and the complete workflow.
The installed active version is `2.0.0+codex.20260730125252`.

Independent Review round 1 identified two workflow blockers and several
contract-hardening opportunities. The implementation now reports actionable
stale-dependency tuples, provides an explicit audited ambiguous-WAL adoption
command, freezes the Manifest 2.0 schema hash, shares Validation Report
intrinsic hashing, verifies exact repository ownership, keeps subprocess
observations outside storage locks, narrows the content fingerprint, and
improves runtime/actor/dependency/projection diagnostics. Durable WAL and
dependency hashing remain intentionally fail-closed; performance optimization
requires profiling and stays in P1-3b.

Round 2 found and closed one additional publication safety issue: explicit WAL
adoption now demotes `validated → authoring` before persisting adopted bytes,
so a crash cannot publish using the pre-adoption Validation Report. Pending
event discovery, redacted CLI details, checkout/install command routing,
distinct adopted/reconciled diagnostics, missing-dependency normalization,
total dependency budgeting, projection normalization, re-derived manifest
diagnostics, and publish-side runtime drift coverage were completed in the
same remediation.

Round 3 found no blocking issue. The remaining operator-facing path leak was
closed by applying the same path/URL/secret redaction to CLI messages and
details, and missing provenance drafts now use a stable typed diagnostic.
Empty details are suppressed, truncated details stay valid JSON, the study
publish command uses the checkout-relative wrapper, the frozen-schema reason
for pair-based adoption diagnostics is documented, and workspace fault
injection now follows one helper. A dedicated regression increases provenance
coverage to `13/13` and the study suite to `100/100`.

Round 4 returned a conditional `PASS` with no correctness defect. Its two
reasonable hardening notes were adopted: absolute-path redaction no longer
depends on a preceding-character allowlist, and URL sanitation no longer uses
replaceable text placeholders. The trailing `safeDetail` absolute-path check
remains deliberate defense in depth. The pinned-runtime full suite was
reproduced locally at `209/209`, `100/100`, `79/79`, and `13/13`; Review
completion now requires only real Docker sandbox conformance from remote CI.
