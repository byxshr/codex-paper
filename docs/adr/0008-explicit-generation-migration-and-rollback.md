# ADR 0008: Explicit New-Generation Migration and Exact Rollback

- Status: Accepted
- Date: 2026-07-31

## Context

Legacy and earlier managed packages must remain readable, but in-place conversion would destroy the evidence needed to diagnose or reverse a migration. P1-2a therefore froze writes and established verified paper-scoped backups.

## Decision

Migration always creates a distinct Generation Contract 2.0 workspace using the declared `codex-paper-migration/p1-2b-1.0.0` authoring engine. The current parser rebuilds authoritative evidence and facts. Approved authoring artifacts pass through the shared writer, and old evidence references are represented by a hash-bound alias map.

Commit reuses the standard complete Validation and Manifest 2.0 publication gates. Managed sources retain all generations. Legacy sources move to a private journaled archive during the authority switch. Rollback requires an expected current manifest hash; legacy rollback restores the original flat authority exactly and retains the managed target for explicit roll-forward.

`current.json` remains authoritative, while `index.json` is repaired only from a re-resolved authority under lock.

## Consequences

- Migration is reviewable and cannot silently rewrite source history.
- Rollback and roll-forward preserve both old and new authority bytes.
- Migration requires a valid PDF, conformant content runtime, fresh backup, explicit authoring where needed, and complete standard validation.
- Private backups and archives consume disk until a later retention policy is implemented.
- Manifest/Identity 1.0 remain compatibility inputs; no implicit schema upgrade is added.
