# P1-2b Implementation Plan

## Status

- Development: complete
- Delivery: not pushed
- Parent P1-2: development complete
- Next item: P1-3b
- Scope date: 2026-07-31

## Objective

Replace the retired in-place migration path with an explicit, reviewable, new-generation workflow. A migration must begin from a verified fresh P1-2a backup, rebuild the evidence layer with the current bounded parser, preserve only approved authoring artifacts, pass complete standard validation, and then publish through the existing Manifest 2.0 transaction boundary.

## Delivered design

### Two-stage migration

`migration-start` creates an exact generation workspace and records a Migration Transaction 1.0. It does not change the source authority, current record, or index. The caller authors and validates that exact workspace through the existing writer and validators. `migration-commit` accepts only a `validated` workspace whose complete Validation Report has the standard `allow_publish` gate. A second active transaction for the same paper is rejected. If interruption leaves a workspace before registration, retry returns its exact ID and directs the operator to inspect/abandon it.

Supported sources are legacy v1, flat 2.0/2.1, and managed Manifest/Identity 1.0. Unknown or corrupt contract versions fail closed. A verified package 2.1 / Identity 2.0 / Manifest 2.0 generation returns `not_required` without requiring a backup.

### Evidence aliases

The new package contains `.codex-paper/evidence-aliases.json`. Resolution order is direct current-ledger ID, alias map, then the read-only 2.0 fact projection. Aliases bind the source artifact hash and map only to real current-ledger `ev-*` IDs. Referenced aliases must have 100% unique coverage before commit. New facts, analysis, and translated reasoning continue to store direct current-ledger IDs.

### Commit and recovery

Managed migration appends a new immutable generation and switches `current.json` through Generation Publication 1.0. Legacy migration journals an atomic authority transition: the flat source is retained privately in `.codex-paper/migration-archives-v1/<migrationId>/source/` before the managed index becomes visible.

Recovery uses transaction state and exact bindings rather than timestamps. Detached legacy recovery accepts the exact `source present/archive absent` crash state and completes the archive and index steps. Rollback requires the caller's expected current manifest hash and rechecks live current under lock on every resume. Managed rollback switches to the previous current record. Legacy rollback restores the original flat tree and index projection byte-for-byte and mode-for-mode while privately retaining the managed target. Roll-forward verifies all preconditions before moving either authority and restores the same migrated manifest binding. Authority-switch index updates are target scoped, so unrelated damaged records do not block the selected transition.

### Targeted reindex

`reindex --dry-run [--paper <ref>]` is read-only and reports whether apply is available, explicit blockers, final entry count, and the predicted post-apply index hash. Apply recomputes authority while holding locks; target mode replaces only the selected paper projection and retains unrelated index entries and the envelope. Library dry-run and apply use the same tolerant projection plus explicit blocking policy. Ambiguous record/current/manifest authority fails closed.

## Public commands

```bash
bash scripts/codex-paper.sh migration-start <paper-ref> --backup-id <backup-id> --json
bash scripts/codex-paper.sh migration-inspect <migration-id-or-workspace> --json
bash scripts/codex-paper.sh migration-commit <migration-id-or-workspace> --json
bash scripts/codex-paper.sh migration-recover --json
bash scripts/codex-paper.sh migration-rollback <migration-id> \
  --expected-current-manifest-hash <sha256> --json
bash scripts/codex-paper.sh migration-rollforward <migration-id> --json
bash scripts/codex-paper.sh reindex --dry-run [--paper <paper-ref>] --json
bash scripts/codex-paper.sh reindex [--paper <paper-ref>] --json
```

The deprecated `migrate` command remains a read-only `--dry-run` alias and has no writer imports.

## Acceptance

- Migration, backup, compatibility, managed/legacy rollback, roll-forward, crash recovery, Doctor 1.0/1.1 compatibility, transaction isolation, and reindex parity tests pass (`55/55`).
- Repository Guard requires all four migration schemas, the shared engine/CLI, Evidence Alias resolution, complete validation, rollback CAS, and the independent CI migration gate.
- Existing source packages and sealed generations are never edited in place.
- All automated tests use temporary libraries; the user library and Attention sample remain unchanged.
- Full local regression passed: Guard `87/87`, repository/security `259/259`, study `102/102`, Validation `25/25`, all lifecycle suites, deterministic/external/reasoning/package benchmarks, production build, Viewer security, smoke, supply-chain gates, and official plugin validation.
- Active plugin path is `plugins/codex-paper/` at `2.0.0+codex.20260731100653`; Docker conformance is deferred to the mandatory remote CI gate because Docker is unavailable on this host.

## Rollback

Before commit, abandon or retain the private workspace; no published authority changed. After commit, use `migration-rollback` with the exact current manifest hash. If interrupted, run `migration-recover`; do not move archive or record directories manually.
