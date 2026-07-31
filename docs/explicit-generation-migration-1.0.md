# Explicit Generation Migration 1.0

## Authority model

Migration is a two-phase protocol:

1. `migration-start` verifies a target-scoped backup and creates a private generation workspace. Repeating the same start returns the existing transaction.
2. Normal workspace authoring and complete standard validation make the workspace eligible.
3. `migration-commit` rechecks source, backup, runtime, evidence aliases, provenance, validation, and index CAS under the storage lock hierarchy.
4. The existing publication engine seals Manifest 2.0 and commits `current.json`; `index.json` remains a rebuildable projection.

No step rewrites the legacy package or an existing sealed generation.

## Contracts

- Migration Plan 1.1 adds `planId`, policy hash, target generation inputs, `ready | blocked | not_required`, and executable status. Plan 1.0 remains read-only compatible.
- Migration Source Record 1.0 binds source layout/version/snapshot, backup, policy, and migration ID.
- Evidence Alias Map 1.0 binds source references to unique current-ledger evidence IDs.
- Migration Transaction 1.0 journals workspace, source/current bindings, archive locations, and state.
- Doctor Report 1.1 inventories migration transactions and retained archives. Doctor Report 1.0 remains a strict read-only compatibility format.

Transaction states are `workspace_created`, `committing`, `committed`, `rolling_back`, `rolled_back`, and `rolling_forward`. Non-terminal states remain recoverable through `migration-recover`; the contract does not expose an unreachable terminal `failed` state or an unsafe abandon operation.

## Alias resolution

Readers resolve in this fixed order:

1. direct `ev-*` in the current evidence ledger;
2. a validated alias in `.codex-paper/evidence-aliases.json`;
3. the frozen package 2.0 `claim:n`, `result:n`, or `limitation:n` fact projection.

An alias cannot target another alias, cross the current ledger, form a cycle, or resolve ambiguously. Every source reference actually used by migrated structured JSON must resolve. Unreferenced historical evidence may remain a bounded warning.

## Content policy

The current parser always regenerates `paper-data.json`, `evidence-ledger.json`, facts 2.1, and `analysis.json`. Identity, manifests, validation reports, and execution reports are never copied. Approved visible study files, reasoning, Codex review/answering documents, and files under the bounded `code/` and `images/` namespaces are copied through the shared writer with actor `tool`. Reasoning references are translated to direct current-ledger IDs.

Each migrated `code/**` file is limited to 1 MiB. Other approved authoring files are limited to 16 MiB. Existing identical projected content is reused; divergent workspace content is never overwritten implicitly.

No model is called and no paper code is executed during migration.

## Legacy authority switch

The legacy flat source is atomically renamed into a private migration archive only after the managed record/current is complete and before index publication. If a process stops after current commit but before source archive or index commit, migration recovery accepts only the exact transitional authority shape, completes the owed archive/index step, and converges to the committed state. Readers resolve the managed current as soon as it is committed. Recovery replays the transaction and publication journals; it never selects a “latest” directory.

Rollback requires a manifest-hash compare-and-swap:

- managed source: write the exact previous `current.json`;
- legacy source: verify the archived source snapshot, restore the flat authority, archive the managed target, and rebuild only the authoritative projection.

Rollback and roll-forward re-read the live current and both authority locations under lock. They verify all hashes, current bindings, and target/source exclusivity before the first rename; resumptions accept only a known intermediate state. Roll-forward verifies the retained managed manifest and the restored legacy snapshot before reversing the authority switch.

The two-rename legacy switch deliberately permits a short interval with neither authority live. The selected route can transiently return not found during that interval, but dual authority is forbidden and the journal makes the state recoverable.

Managed source freshness covers the immutable paper record and generations but excludes `overlay/`, so tags or reading-progress changes do not invalidate a migration backup or workspace.

## Operations and observability

- `library-doctor` enumerates migration transactions and archives, reports non-terminal transactions, and counts retained archive bytes.
- Corrupt or newer transaction siblings do not break lookup of a known migration/workspace; Doctor reports them independently as invalid or unsupported.
- `reindex --dry-run` reports `applyAvailable`, blockers, final result count, and the exact predicted index hash. Apply uses the same projection/blocking policy and recomputes it under lock.
- Exit 3 remains limited to retryable lock/workspace/backup-restore conflicts. Migration policy/CAS/validation/route conflicts return exit 1.

## Failure policy

- Missing/stale backup, missing or changed source, runtime mismatch, incomplete validation, unresolved aliases, ambiguous authority, and manifest drift all fail closed before authority mutation.
- A failed start or uncommitted workspace is invisible to the Viewer.
- Backup, archive, transaction, and rolled-back target retention are indefinite until P1-7 defines lifecycle policy.
- Unknown package, Identity, Manifest, plan, or transaction versions are never upgraded implicitly.
