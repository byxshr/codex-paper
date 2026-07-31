# ADR 0002: Paper identity and generation fingerprint

- Status: accepted for P0-C1a
- Date: 2026-07-21
- Supersedes: title slug as an implicit uniqueness boundary

## Context

The flat package layout is addressed by a title-derived slug. A source hash exists, but it previously did not prevent a second source or a different generation configuration from targeting the same directory. Re-preparation could therefore overwrite managed artifacts or mutable user state.

P0-C1b and P0-C2 will provide the durable layout and transaction model, but preparation needs an immediately enforceable collision boundary that does not pre-empt those designs.

## Decision

Adopt Paper Identity `1.0.0` with three independent identifiers:

1. `paperId`: normalized high-confidence DOI/arXiv grouping, otherwise source SHA identity.
2. `sourceRevisionId`: exact PDF SHA-256.
3. `generationId`: SHA-256 over versioned canonical content-affecting inputs.

Trust only exact DOI/arXiv input URLs and explicit markers on the first two PDF pages. Same-type canonical conflicts fall back to source identity. A unique DOI is primary and a unique arXiv identifier is an alias.

Store the transitional authority in `.codex-paper/paper-identity.json` and require exact projections in metadata, parsed data, and the index. Treat plugin cachebusters and runtime provenance as non-fingerprint data.

Until P0-C1b lands, allow only exclusive first creation or byte-for-byte read-only reuse of a complete identical generation. Reject every other collision, missing/corrupt identity on a target, unsafe registry entry, and stale index. Do not add an overwrite escape hatch.

In paper-only mode, the trusted input locator does not affect `generationId`, but it can affect `paperId` when the PDF's first two pages contain no matching trusted marker. The first successful C1a preparation therefore pins the transitional paper identity. If identical bytes and generation inputs are later supplied through a locator that resolves to a different `paperId`, reject reuse with `PAPER_IDENTITY_CONFLICT`; do not silently promote, alias, regroup, or rewrite the stored identity. P0-C1b must define any controlled alias/enrichment/reconciliation policy as an explicit versioned decision.

## Consequences

- Repeated identical preparation is idempotent and preserves all files and mutable user state.
- A second language, workflow, profile, context, parser contract, or content-contract revision for the same PDF cannot coexist in the flat layout and must wait for P0-C1b.
- A stronger canonical locator discovered after first preparation is not silently adopted. This favors stable, auditable grouping over automatic enrichment during the flat-layout transition.
- Legacy packages remain readable by existing compatibility paths but cannot be implicitly adopted by preparation.
- Registry discovery is O(N) over identity-aware flat packages; C1b must replace it with the authoritative resolver/index while preserving fail-closed duplicate detection.
- C2 must use these identifiers and canonical inputs as its manifest identity contract; changing their semantics requires a new version, not silent recomputation.
