# ADR 0003: Paper Library Layout, Current Resolution, and Mutable Overlay

- Status: Accepted
- Date: 2026-07-21
- Related: P0-C1b, ADR 0002

## Context

Paper Identity 1.0 separates paper, source revision, and generation identity, but the transitional flat writer still used title slug as the physical directory. That prevented safe coexistence of same-title papers and multiple generations, mixed user state with generated artifacts, and left Viewer/CLI consumers with independent path logic.

## Decision

New packages use an identity-keyed managed store at `.codex-paper/store-v1/papers/<paperKey>`. Each paper record owns sources, generations, one paper-level overlay, and an authoritative `current.json`. Route slugs and `index.json` are compatibility/search projections only.

All in-library consumers use the shared no-follow resolver. The resolver validates paper/current records, derives rather than trusts generation paths, rejects symlinks and ambiguous aliases, and returns stable paper/generation keys for locks and Ask threads. Missing or corrupt current state fails closed; consumers never guess the newest generation.

Exact generation preparation is a zero-write reuse. New fingerprints and source revisions coexist. `--resume` requires an exact generation, `--new-revision` requires an existing grouping plus different source bytes, and `--replace` is rejected until P0-C2. A mismatched paper ID for identical source/generation requires explicit `--reconcile-identity`; reconciliation is audited and may promote a trusted canonical ID at paper level without moving the stable paper key or rewriting generation identity.

Tags, chat notes, progress, annotations, and user overlay files live outside generation packages. Overlay merge is allowlisted and cannot shadow generated artifacts. Existing flat 2.0/2.1 packages resolve as read-only; explicit migration remains P1-2. Trash uses a separate tombstone/payload envelope so lifecycle operations do not inject metadata into legacy or managed payloads.

## Consequences

- Same-title papers and multiple source/generation revisions coexist without overwrite.
- A current switch does not discard overlay state or modify old generations.
- Legacy write operations become explicit migration errors.
- C1b still has single-process/multi-file crash windows and logically mutable prepared generations; shared workspace/writers, cross-process locks, manifest sealing, gate-driven atomic publish, dirty detection, and recovery remain P0-C2.
