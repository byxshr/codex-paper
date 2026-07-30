# ADR 0006: Generation Manifest 2.0 is the published provenance authority

Status: Accepted
Date: 2026-07-30

## Context

Generation Manifest 1.0 established immutable publication but recorded only identity, validation and file inventory. P1-3a added a reproducible content runtime, while C2a/C2b established private workspaces, shared writers and transactional publication. Source acquisition, runtime, authoring history, artifact relationships and executions still lacked one authoritative binding.

## Decision

New generations use Identity/Generation Contract 2.0 and are sealed with Generation Manifest 2.0. The manifest is the only published provenance authority. Workspace `provenance-draft.json` is a temporary sealing input; `meta.json`, README, `current.json` and index contain bounded projections only.

Content-affecting runtime and declared model/provider inputs participate in the generation fingerprint. Unobservable Codex/repository/model facts are explicit diagnostics instead of inferred values. Authoring writes use a bounded write-ahead event log. Artifact relationships form an acyclic graph. Pre-seal executions enter the manifest; post-seal executions bind the immutable manifest from the overlay.

Manifest integrity uses canonical SHA-256 and explicitly records `unsigned`. Signing is deferred to P2-5. Version 1.0 readers remain available without migration or writeback; unknown versions fail closed.

## Consequences

- Publication can prove which source, runtime, contract, artifacts, validation and executions formed a generation.
- Runtime drift or unresolved authoring/execution state blocks publication.
- Existing generations retain their historical identifiers and bytes.
- P1-2 can implement explicit backup/migration/rollback against a frozen 2.0 target.
- P2-5 can add signatures without changing the meaning of current unsigned manifests.
