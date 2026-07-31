# ADR 0007: Read-only Doctor and paper-scoped backup baseline

- Status: accepted
- Date: 2026-07-30

## Context

Codex Paper can read several package and authority versions, but migration previously combined diagnosis, parsing, and in-place writes. Managed generations are now immutable and Manifest 2.0 is authoritative, so migration must not proceed without deterministic compatibility evidence and a verified recovery point.

## Decision

1. Freeze in-place migration. The legacy command is a dry-run alias only.
2. Preserve five deterministic synthetic compatibility goldens and test them through production readers with zero writes.
3. Make library inventory and Doctor read-only, tolerant per object, path-redacted, and unstable-scan aware.
4. Store backups as paper-scoped, content-addressed private snapshots with an integrity manifest.
5. Restore only into an absent or byte-identical target through private staging and a recoverable journal. Never overwrite different content.
6. Keep migration execution, repair, replacement, and rollback in P1-2b.

## Consequences

Migration cannot be performed during P1-2a. This deliberate interruption removes an unsafe compatibility path and gives P1-2b a stable input contract.

Backups consume local disk and are retained indefinitely. Retention and purge remain P1-7 responsibilities.

Doctor may report an unstable scan rather than obtaining a lock. This preserves the zero-write contract and allows callers to retry.

The backup format is suitable for future rollback, but it is not an export, release artifact, or whole-library disaster recovery mechanism.
