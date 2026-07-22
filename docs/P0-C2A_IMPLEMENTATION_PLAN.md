# P0-C2a Implementation Record

## Scope

P0-C2a introduces private same-filesystem generation workspaces, hierarchical cross-process locks, and a shared CAS writer. It deliberately stops before publication: no generation manifest is sealed, no `current.json` pointer is switched, and no formal index entry is created.

## Implemented

- Generation Workspace 1.0 under `PAPERS_DIR/.codex-paper/workspaces-v1/<workspaceId>/` with `workspace.json` and `package/`.
- Atomic `.init-*` initialization, exact resume, duplicate-generation rejection, persistent failure state, and explicit abandon.
- Cross-process lock records under `.codex-paper/locks-v1/`, fixed lock ordering, Web fail-fast acquisition, CLI bounded waiting, owner-token release, heartbeat metadata, and conservative dead-local-PID recovery.
- One no-follow writer with required lock ownership, containment, size limits, CAS, exclusive same-directory temporary files, file fsync, rename, and directory fsync.
- Workspace-only prepare/scaffold/render/validation flows and CAS authoring commands.
- Shared writes for Viewer tags/chat, trash tombstones/index, sandbox execution reports, and explicit legacy migration.
- Mandatory regression authoring entirely inside workspaces, with assertions that formal records and index remain absent.

## Public commands

```bash
bash scripts/codex-paper.sh workspace-list [--json]
bash scripts/codex-paper.sh workspace-inspect <workspace-id-or-path> [--json]
bash scripts/codex-paper.sh workspace-write <workspace> <relative-path> \
  (--stdin | --from-file <path>) \
  (--expect-absent | --expected-sha256 <sha256>) [--json]
bash scripts/codex-paper.sh workspace-tags <workspace> --tag <tag> --tag <tag> [--json]
bash scripts/codex-paper.sh workspace-abandon <workspace> [--json]
bash scripts/codex-paper.sh storage-test
```

CLI mutations wait up to 10 seconds by default and accept `--lock-timeout-ms 0..30000`. Web mutations retain immediate `409` conflict behavior.

## Acceptance and rollback

Acceptance requires repository, identity, layout, storage, validation, mandatory, security, benchmark, build, smoke, and plugin validation gates. A rollback removes the new workspace commands and storage modules and restores the previous prepare flow; it must never convert an incomplete workspace into a published record. Existing workspaces are retained as inert data unless explicitly abandoned.

## Deferred to P0-C2b

- authoritative `generation-manifest.json`
- sealing and validation-report hash binding
- gate-driven publish transaction
- `paper.json`/`current.json`/index commit and recovery
- reindex and crash-recovery commands

## Post-review amendments

The first independent review found lock-reclaim TOCTOU, exceptional rollback/release leaks, abandoned-workspace mutation paths, an ineffective prepare sentinel, internal-writer policy/state gaps, and two consumer lock/path mismatches. The accepted corrections are recorded in `docs/P0-C2A_CODE_REVIEW_SUMMARY.md` and covered by storage, sandbox, Viewer, Guard, validation, and mandatory regressions.

The fourth review found a managed-workspace migration bypass, incomplete Ask answer preservation/delete coordination, active `.init-*` crash residues, split validation state/report transactions, and a lost resolver Guard. All correctness findings were accepted. Shared CAS preconditions, storage lock-key constructors, the active-workspace predicate, and CLI error mapping were also consolidated; broader registry/list performance work remains deferred to P1-3.

The fifth review confirmed the fourth-round authority fixes and found two medium correctness issues. A failed `codex-reply` now invalidates only that paper's cached thread, and a validation-report write failure best-effort transitions the workspace to `failed` with a bounded diagnostic while preserving the original error. Ask lease registration no longer takes a filesystem lock; Web CAS and CLI exit mapping now use shared helpers; Guard mutation coverage includes every declared resolver/writer consumer.

The sixth review identified two uncovered variants of those failures. A successful RPC with an empty reply now invalidates the same per-paper cache, and validation compensates failures in both report replacement and the final workspace-state transition. Workspace diagnostics now share one sanitizer, secondary compensation errors remain attached to the primary failure, and both prepare/workspace CLIs consume the shared lock-timeout maximum. Automatic discovery of future write-authority consumers was not added: the current Guard remains an explicit reviewed allowlist with full mutation coverage, because import-based scanning cannot safely infer authority or detect an implementation that deliberately bypasses the shared modules.

The seventh review confirmed the sixth-round fixes and found one remaining answer-delivery gap. Ask now degrades a rich-rendering failure to escaped plain text, returns the already generated answer, and surfaces a bounded warning instead of returning 502. The low-reachability initialization cleanup observation was accepted as inexpensive defense in depth: stale record-free `.init-*` deletion now occurs inside the registry lock and is protected by a Guard mutation. Explicit `--force` legacy reasoning replacement remains the documented destructive override and was not changed.

The eighth independent review revalidated both seventh-round fixes and returned a clean finding set. Its two non-blocking robustness notes require no C2a code change: the plain-text fallback already normalizes input through `String(value ?? '')`, while same-workspace authoring is serialized by the workspace lock and a hypothetical intermediate-directory `EEXIST` remains a fail-closed write error. No plugin cachebuster was generated for this documentation-only disposition.

Automatic recovery of ownerless/corrupt lock directories was not adopted: C2a intentionally treats those records as untrusted and fail-closed. A bounded doctor/recovery workflow and identity-reconciliation publication behavior remain part of C2b/P1-2.
