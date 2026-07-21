# P0-C1b Code Review Handoff

## Review objective

Confirm that P0-C1b turns Paper Identity 1.0 into a collision-safe, multi-generation library layout; routes all production consumers through one no-follow resolver; separates the generation-addressed layer from mutable user overlays; and never silently adopts or rewrites legacy flat packages.

## High-value review areas

- `src/shared/paper-library.mjs`: route resolution, record/current validation, containment and symlink rejection, stable lock keys, managed versus legacy descriptors, overlay reads/writes, and identity reconciliation.
- `prepare-paper.js`: exact-generation zero-write reuse, new generation/revision creation, current-pointer rules, same-title coexistence, and explicit `--reconcile-identity` behavior.
- Viewer server utilities and routes: current-generation reads, overlay tags/chat, stable locking, trash envelopes, and managed/legacy restore behavior.
- validator, renderer, scaffold, migration, and sandbox consumers: shared resolver use, legacy read-only policy, and absence of direct title-slug path reconstruction.
- schemas and ADR: strict `paper.json`, `current.json`, and overlay state contracts; stable `paperKey`; generation/overlay separation; and the exact C2 publication boundary.

## Intended invariants

- `<library>/.codex-paper/store-v1/papers/<paperKey>` is keyed by a stable hash derived from the initially pinned paper identity, not by title or route slug.
- `current.json` is the sole authoritative current source/generation pointer; `index.json`, route aliases, and package `meta.json` are projections.
- A source/generation package is physically isolated from paper-level mutable state. Tags, Ask history, progress, annotations, and user files belong to `overlay/` and never mutate the generation package.
- Exact source and generation reuse is zero-write and does not switch `current` when an older generation is explicitly reused.
- Different papers with the same title coexist under distinct stable routes. Aliases cannot change paper/generation lock identity.
- Canonical/local identity reconciliation is explicit, bidirectional, hash-bound, and audited; it never moves the stable paper directory or rewrites generation content.
- Legacy flat 2.0/2.1 packages remain readable but are never silently upgraded, overlaid, validated-to-disk, sandbox-executed, or otherwise mutated.
- Every managed path segment is checked with no-follow/realpath containment; paper records, current pointers, package roots, overlays, trash envelopes, and target files reject unsafe symlinks.

## C2 boundary and known residual risks

P0-C1b intentionally does not provide cross-process locks, generation workspaces, a shared transactional writer, manifest sealing, post-publication immutability, manifest-managed dirty detection, gate-driven publication, or crash recovery across the record/current/index multi-file update. These are the explicit P0-C2a/C2b responsibilities. Until that publication commit point exists, the existing authoring commands still write to the generation-addressed package. C1b writes individual JSON/state files atomically, isolates every paper-level overlay mutation, and prevents overwrite/collision errors, but it does not claim a sealed immutable package.

Legacy migration, route/identity repair tools, doctor/reindex, backup/restore workflow, and rollback automation remain P1-2. Viewer identity/history UX is not added in C1b.

## Verification record

- Library Layout contract tests: 7/7, covering current generation routing, tamper rejection, slug and explicit-path legacy zero-write enforcement, overlay survival across generations, symlink rejection, and bidirectional explicit reconciliation.
- Paper Identity/prepare tests: 17/17, including multi-generation/revision behavior, legacy coexistence, CLI flags, current stability, same-title collision safety, and the third-tier generation-fingerprint route fallback.
- Repository/security suite: 124/124; study/unit suite: 76/76; Validation Report: 21/21.
- Mandatory benchmark: 2/2; external parser: 5/5; reasoning/package: 12/12 each.
- Production build, Viewer HTTP security integration, smoke test, and Browser QA passed.
- Browser QA verified pairing and session refresh, managed current-generation display, overlay `chat-notes.md`, zero active-content canary requests, and no browser console errors.
- Official plugin validation passed; the canonical marketplace reinstall resolves to `plugins/codex-paper/` with active version `2.0.0+codex.20260721114227`.

## Review disposition requested

The first independent review returned “Approve with one fix requested.” Both actionable findings were accepted:

- B1: fixed `identity.generation.fingerprint.slice(...)` to read the structured fingerprint's `.value`, with an integration test that occupies both the base and source-suffixed routes.
- H1: explicit paths resolving inside `<library>/papers/` now return a read-only legacy descriptor. Build analysis, render, reasoning scaffold, and sandbox planning are covered together and leave the legacy tree byte-for-byte unchanged.

The dead `resolveWritablePaperFile` helper was removed and equal-rank canonical first-pin behavior is now documented inline. The old `.codex-paper-trash.json` name intentionally remains on the Viewer denylist so older packages cannot expose machine tombstones. Tags rollback and missing-overlay behavior were not changed: prepare guarantees the overlay exists, while broader rollback/recovery semantics remain P0-C2.

The second independent review reproduced the parser-free H1 path, inspected the exact B1 branch and its parser-dependent regression, confirmed every round-one disposition, and returned unconditional `Approve` with no new defect. P0-C1 is therefore `Review 完成 / 未推送`. M2 remains open; the next handoff is a C1b stage commit and remote CI, followed by P0-C2a.
