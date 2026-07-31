# P0-C2b Implementation Plan

## Scope

P0-C2b completes the publication half of the P0-C lifecycle. A validated Generation Workspace is sealed into an immutable generation, committed through the authoritative current record, projected into the rebuildable library index, and recoverable after any process interruption. C2b does not add migration, backup/restore, a general doctor UI, revision browsing, or provenance history beyond the minimum publication contract.

## Publication protocol

1. Resolve one exact non-residue workspace and acquire locks in the existing order: registry, paper, source, generation, workspace, then index.
2. Re-read identity, workspace publish intent, and Validation Report 1.0 while locked. Publication requires `phase=complete`, `publishable=true`, `gate.policy=standard`, `gate.outcome=allow_publish`, no error finding, and a valid intrinsic report hash.
3. Add the manifest projection to `meta.json`, enumerate every regular package file except the manifest itself, reject symlinks and special files, and write `.codex-paper/generation-manifest.json` atomically in the workspace.
4. Persist a bounded `publication.json` journal next to `workspace.json`. The journal contains only relative targets, identities, manifest/report hashes, state, timestamps, and bounded diagnostics.
5. Create or CAS-update the paper record, atomically rename the workspace package to its final generation-addressed path, seal file/directory modes, and atomically write `current.json`. The current record is the authoritative visibility commit point.
6. Rebuild `index.json` from authoritative records and current pointers. Index failure does not roll back an already committed current generation; recovery/reindex repairs the cache.
7. Retain the consumed workspace record and terminal journal after current and index are committed, but detach its package and mark the descriptor read-only/non-active. This provides a bounded recovery audit trail until P1 retention tooling exists.

## Authoritative manifest

Generation Manifest 1.0 binds paper/source/generation identity, source SHA, generation fingerprint, Validation Report status/hash, the publication transaction ID, and a stable sorted inventory of generated files. `manifestHash` is calculated over canonical manifest content excluding the hash field itself. The manifest file SHA is separately recorded in `current.json` and `index.json`.

New managed generations are checked against their current-record manifest binding on resolution. Missing, modified, extra, symlinked, or special files fail closed with an explicit dirty/corrupt diagnostic. Older managed generations without a C2b manifest remain readable as unsealed compatibility records and are never silently upgraded.

## Recovery and reindex

- `publication-recover` scans exact workspace journals and retries only transactions whose identity and relative targets still match their workspace record. It never guesses the newest workspace.
- `reindex` ignores the existing index contents and rebuilds the managed projection from valid `paper.json` + `current.json` + sealed generation manifests.
- A committed generation with a missing/stale index is repaired without rewriting generation content.
- A pre-commit failure remains outside current/index. Invalid gates, identity drift, target collisions, unsafe paths, and manifest drift fail closed.

## Interfaces

```bash
bash scripts/codex-paper.sh publish-workspace <workspace-id-or-path> [--json] [--lock-timeout-ms 0..30000]
bash scripts/codex-paper.sh publication-recover [--json] [--lock-timeout-ms 0..30000]
bash scripts/codex-paper.sh reindex [--json] [--lock-timeout-ms 0..30000]
bash scripts/codex-paper.sh publication-test
```

CLI exit codes remain `0` success, `1` publication/integrity failure, `2` argument/policy error, and `3` workspace/lock conflict.

## Verification

- Gate refusal for draft, strict-blocked, failed, tampered, or non-standard reports.
- Manifest determinism, complete inventory, no-follow traversal, identity/report binding, and post-publication dirty detection.
- New paper and new generation publication, route/identity reconciliation, overlay preservation, current switching, and index projection.
- Fault injection before generation rename, after generation rename, after current commit, and before index commit; recovery must converge without duplicate generations or lost overlays.
- Index deletion/corruption/staleness rebuild from authoritative records.
- Mandatory fixtures publish only after the complete standard gate and resolve through the Viewer-facing shared resolver.
- Full repository, security, identity, layout, storage, validation, benchmark, build, HTTP, smoke, plugin-validator, and active-path regression.

## Rollback

Rollback may remove the C2b commands and publication engine, but must never delete committed generations or retained workspace journals. A generation whose current record was committed remains authoritative data. Before reverting readers, preserve its manifest/current/index records or complete a compatible export; do not rename it back into a workspace.

## Implementation result

Status: `开发完成 / 未推送`.

- Generation Manifest 1.0, publication journal, Validation-gated sealing, authoritative current commit, rebuildable index, recovery, and reindex are implemented.
- Shared readers verify current-record manifest bindings and fail closed on published package drift.
- Mandatory fixtures now complete the workspace → validation → publication → Viewer-resolution lifecycle without exposing pre-publication workspaces.
- Repository Guard, CI, study/summary skills, README, layout/workspace contracts, ADR, and root commands are integrated.
- Local regression passed before first Review: Guard `66/66`, repository/security `169/169`, study `83/83`, publication `9/9`, validation `24/24`, mandatory `2/2`, all other benchmark/build/HTTP/smoke gates, official plugin validation, and temporary-library Browser QA. First-Review fixes expanded publication to `14/14`; second-Review sealing/journal/containment fixes expand it to `15/15`. The current full regression is recorded in the Review summary and audit ledger.
- Independent Review and remote CI are still required before P0-C2 and M2 can be closed.
