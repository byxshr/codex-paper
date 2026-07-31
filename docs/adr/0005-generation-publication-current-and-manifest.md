# ADR 0005: Generation Publication, Current Commit, and Manifest

Status: Accepted

## Context

C2a made authoring private and transactional, but a validated workspace was not a library generation. Publication spans immutable package bytes, the paper record, the current pointer, and a rebuildable index; these files cannot be made atomically visible as one filesystem operation.

## Decision

- Publication accepts one exact `validated` workspace and independently verifies a complete standard Validation Report with `allow_publish`.
- The package is sealed with Generation Manifest 1.0 before it leaves the workspace. The manifest binds identity, generation fingerprint, validation report hash, publication transaction, and every generated file.
- The same-filesystem generation rename commits durable immutable bytes. `current.json` is the authoritative visibility commit point. `index.json` is a rebuildable cache and never decides identity or visibility.
- A bounded `publication.json` journal records transaction progress. Recovery retries the same exact identities and relative target; it never chooses a latest workspace.
- Published readers verify the current-to-manifest binding and complete file inventory. Drift fails closed. Pre-C2b managed generations without a manifest remain readable compatibility records and are not silently rewritten.
- Terminal detached workspace records and journals are retained until a later lifecycle policy removes them. They are read-only and do not reserve an active generation workspace.

## Consequences

An index failure after current commit does not make a published paper disappear; recovery or `reindex` repairs the projection. A committed generation is never renamed back or deleted as rollback. Multi-file publication is recoverable and idempotent rather than falsely described as globally atomic. Migration, revision browsing, backups, broad doctor tooling, and retention/purge remain outside C2b.
