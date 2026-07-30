# Paper Identity 1.0

> Historical compatibility contract: new workspaces use Paper Identity / Generation Contract 2.0 so content-runtime and declared authoring-engine inputs participate in the generation fingerprint. Identity 1.0 records remain read-only and retain their original IDs.

Paper Identity 1.0 separates three concepts that the historical flat layout conflated:

- `paperId` groups a paper by a high-confidence DOI or arXiv base identifier, with `source:sha256:<hash>` as the fail-closed fallback.
- `sourceRevisionId` always identifies the exact PDF bytes as `sha256:<source-hash>`.
- `generationId` identifies the exact content-affecting generation inputs as `gen:sha256:<fingerprint>`.

The transitional authority is `.codex-paper/paper-identity.json`, validated by [`paper-identity-1.0.schema.json`](../plugins/codex-paper/skills/study/schemas/paper-identity-1.0.schema.json). `meta.json`, `paper-data.json`, and `index.json` contain identical projections. P0-C2 must absorb and validate these values in its authoritative manifest rather than derive new identifiers.

## Canonical identity boundary

Only exact `https://arxiv.org/abs|pdf/...` and `https://doi.org/...` input URLs are trusted. PDF discovery is limited to explicit, whole-line `DOI:`, `https://doi.org/`, or `arXiv:` markers on the first two pages. References, later pages, and approximate free-text matches are ignored.

DOIs are lowercased and stripped of resolver prefixes and trailing punctuation. arXiv identifiers accept modern and legacy forms and discard the `vN` revision suffix. A unique DOI is primary and a unique arXiv identifier is its alias. Conflicting candidates of the same type produce `CANONICAL_ID_CONFLICT` and force source-hash identity; no conflicting canonical candidate is used for grouping.

Canonical identity never replaces source isolation. Two PDFs with the same DOI but different bytes still have distinct `sourceRevisionId` values.

The first successful preparation pins canonical resolution for the C1a flat-layout transition. In paper-only mode, an exact trusted DOI/arXiv input URL can change `paperId` without changing `generationId` when the PDF itself has no matching trusted marker in its first two pages. If identical bytes and generation inputs are later presented through a locator that resolves to a different `paperId`, preparation fails with `PAPER_IDENTITY_CONFLICT`; it does not promote, alias, regroup, or rewrite the stored identity. Any controlled reconciliation or alias enrichment belongs to P0-C1b and must be explicit and auditable.

## Generation fingerprint

[`generation-contract-1.0.json`](../plugins/codex-paper/skills/study/generation-contract-1.0.json) lists the content-affecting files. Each file is SHA-256 hashed, the generation inputs are recursively key-sorted and encoded as compact UTF-8 JSON, and the resulting canonical JSON is hashed with SHA-256.

The inputs include source hash, policy and artifact contract versions, workflow, language, context, requested profile, actual parser backend/version/contract, and workflow-specific content-contract hashes. Canonical/literature modes also include the normalized external source locator.

UTC cachebusters, timestamps, absolute paths, index order, PID, OS patch details, Viewer, sandbox, tests, and documentation are provenance-only or out of scope and do not alter `generationId`. Full plugin and parser build versions remain in provenance; stable base/contract versions participate in the fingerprint.

## Flat-layout transition

P0-C1a does not introduce the future multi-generation layout. Before any target or index write, prepare computes identity and scans existing C1a records:

- An identical, complete generation with matching PDF, managed artifacts, projections, and index is returned as `action: reused` without changing bytes or mtimes.
- Same source with a different fingerprint fails as `GENERATION_CONFLICT`.
- Same slug with different source bytes fails as `SOURCE_REVISION_CONFLICT`.
- Identity mismatch, duplicate registry entries, legacy target directories, unsafe symlinks, partial packages, and index drift fail with stable diagnostic codes.

Creation uses exclusive/no-follow writes. There is no `--force`, title hash suffix, implicit adoption, repair, migration, or overwrite path. Mutable tags, chat notes, user files, and existing index data are never rewritten by reuse.

P0-C1b remains responsible for the physical paper/source/generation layout, shared resolver, authoritative current record, and mutable overlay. P0-C2 remains responsible for cross-process locks, transaction publication, crash recovery, and manifest integration.

The C1a registry scan is intentionally transitional and O(N) in the number of identity-aware flat packages. C1b's resolver/index must remove that scaling boundary while retaining duplicate-identity and stale-projection detection.
